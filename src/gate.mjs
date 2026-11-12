import fs from 'node:fs'
import {
  ConfigError,
  PR_EVENTS,
  decide,
  failOpen,
  parseBottomN,
  parseForceRunLabel,
  parseRunTop,
} from './decide.mjs'
import { resolveContext } from './github.mjs'

function readEvent(eventPath) {
  if (!eventPath) return {}
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'))
}

function appendOutput(outputPath, name, value) {
  if (!outputPath) return
  fs.appendFileSync(outputPath, `${name}=${value}\n`)
}

/** GitHub sets INPUT_<id> with the id uppercased; hyphens are kept. */
function inputValue(env, id) {
  return env[`INPUT_${id.toUpperCase()}`]
}

function stringifyBool(value) {
  return value ? 'true' : 'false'
}

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/** Neutralize Actions workflow commands in untrusted text. */
function safeText(text) {
  return oneLine(text).replaceAll('::', ': :').replaceAll('##[', '# [')
}

/** The runner decodes % sequences in messages, so %0A would start a new line. */
function annotation(level, text) {
  return `::${level} title=Stack CI Gate::${safeText(text).replaceAll('%', '%25')}`
}

function yesNo(value) {
  return value ? 'yes' : 'no'
}

function knownOrUnknown(value) {
  if (value == null || value === '') return 'unknown'
  return safeText(value)
}

function summaryCell(value) {
  return safeText(value).replaceAll('|', '/')
}

function eventLabel(trace) {
  const name = trace.eventName ? safeText(trace.eventName) : ''
  const action = trace.eventAction ? safeText(trace.eventAction) : ''
  if (name && action) return `${name} ${action}`
  return name || action || 'unknown'
}

function summaryMarkdown({ result, trace }) {
  const rows = [
    ['Decision', result.should_run ? 'Run gated jobs' : 'Skip gated jobs'],
    ['Reason', summaryCell(result.reason)],
    ['Stacked', yesNo(result.is_stacked)],
    ['Remaining bottom', yesNo(result.is_bottom)],
    ['Top', yesNo(result.is_top)],
    ['Position', knownOrUnknown(result.position)],
    ['Size', knownOrUnknown(result.size)],
    ['Event', summaryCell(eventLabel(trace))],
    ['Stack source', summaryCell(trace.source || 'unknown')],
  ]
  let markdown = '# Stack CI Gate\n\n| Field | Value |\n| --- | --- |\n'
  for (const [field, value] of rows) {
    markdown += `| ${field} | ${value} |\n`
  }
  return markdown.replaceAll('::', ': :').replaceAll('##[', '# [')
}

function writeJobSummary(summaryPath, fields, log) {
  if (!summaryPath) return
  try {
    fs.appendFileSync(summaryPath, summaryMarkdown(fields))
  } catch (err) {
    const message = safeText(err instanceof Error ? err.message : String(err))
    log.warn(`Could not write the job summary. (${message})`)
  }
}

function applyLabelChange(names, action, label) {
  const current = Array.isArray(names) ? names.slice() : []
  if (typeof label !== 'string') return current
  if (action === 'labeled') {
    return current.includes(label) ? current : [...current, label]
  }
  // GitHub may still include the label this event just removed.
  if (action === 'unlabeled') return current.filter((name) => name !== label)
  return current
}

function writeOutputs(outputPath, result, log, trace = {}) {
  const reason = safeText(result.reason)
  appendOutput(outputPath, 'should-run', stringifyBool(result.should_run))
  appendOutput(outputPath, 'reason', reason)
  appendOutput(outputPath, 'is-stacked', stringifyBool(result.is_stacked))
  appendOutput(outputPath, 'is-bottom', stringifyBool(result.is_bottom))
  appendOutput(outputPath, 'is-top', stringifyBool(result.is_top))
  appendOutput(outputPath, 'position', result.position ?? '')
  appendOutput(outputPath, 'size', result.size ?? '')
  log.log(reason)
  log.log(
    `gate-trace event=${trace.eventName ?? ''} action=${trace.eventAction ?? ''} source=${trace.source ?? ''} event_stack=${trace.eventStack ? 'yes' : 'no'}`,
  )
}

export async function run(env = process.env, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = deps.log ?? console
  const outputPath = env.GITHUB_OUTPUT
  // A failed output write leaves should-run empty, so the step fails as 1.1.0 did.
  let exitCode = 0
  const write = (result, trace = {}) => {
    try {
      writeOutputs(outputPath, result, log, trace)
    } catch (err) {
      exitCode = 1
      const message = err instanceof Error ? err.message : String(err)
      log.error(
        annotation(
          'error',
          `Could not write gate outputs, so should-run is empty and this step failed. Jobs that need the gate job are skipped unless their if: uses !cancelled() or always(). (${message})`,
        ),
      )
    }
    writeJobSummary(env.GITHUB_STEP_SUMMARY, { result, trace }, log)
  }

  let bottomN
  let runTop
  let forceRunLabel
  try {
    bottomN = parseBottomN(inputValue(env, 'bottom-n'))
    runTop = parseRunTop(inputValue(env, 'run-top'))
    forceRunLabel = parseForceRunLabel(inputValue(env, 'force-run-label'))
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(`::error::${safeText(err.message)}`)
      const result = failOpen(`invalid input; running CI (${safeText(err.message)})`)
      write(result, { eventName: env.GITHUB_EVENT_NAME || '', source: 'invalid-input' })
      return { exitCode, result, error: err }
    }
    throw err
  }

  const eventName = env.GITHUB_EVENT_NAME || ''

  try {
    if (!PR_EVENTS.has(eventName)) {
      const result = decide({
        eventName,
        bottomN,
        runTop,
        stack: null,
        prBaseRef: '',
      })
      write(result, { eventName, source: 'n/a' })
      return { exitCode, result }
    }

    const event = readEvent(env.GITHUB_EVENT_PATH)
    const pr = event.pull_request ?? {}
    const prNumberRaw = inputValue(env, 'pr-number')
    const resolved = await resolveContext({
      eventAction: event.action,
      eventStack: pr.stack,
      eventPrNumber: pr.number,
      eventPrBaseRef: pr.base?.ref,
      eventLabels: pr.labels,
      prNumberOverride: prNumberRaw,
      repo: env.GITHUB_REPOSITORY || '',
      token: inputValue(env, 'github-token') || env.GITHUB_TOKEN || '',
      apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
      fetchImpl,
      sleep,
      bottomN,
    })

    const hasPrNumberOverride = String(prNumberRaw ?? '').trim() !== ''
    const labelNames = hasPrNumberOverride
      ? resolved.labels
      : applyLabelChange(resolved.labels, event.action, event.label?.name)

    const result = decide({
      eventName,
      bottomN,
      runTop,
      stack: resolved.stack,
      prBaseRef: resolved.prBaseRef,
      remainingDepth: resolved.remainingDepth,
      labelNames,
      forceRunLabel,
    })
    write(result, {
      eventName,
      eventAction: event.action,
      source: resolved.source,
      eventStack: pr.stack,
    })
    return { exitCode, result }
  } catch (err) {
    const message = safeText(err instanceof Error ? err.message : String(err))
    log.warn(`Could not gate stacked CI; running checks by default. (${message})`)
    const result = failOpen(`error; running CI (${message})`)
    write(result, { eventName, source: 'error' })
    return { exitCode, result }
  }
}

if (import.meta.main) {
  run()
    .then(({ exitCode }) => {
      process.exit(exitCode ?? 0)
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
