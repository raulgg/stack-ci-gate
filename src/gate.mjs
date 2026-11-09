import fs from 'node:fs'
import {
  ConfigError,
  INVALID_STACK_REASON,
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

/** GitHub reads % codes in annotation text, so escape % to keep text like %0A from turning into a line break. */
function annotation(level, text) {
  return `::${level} title=Stack CI Gate::${safeText(text).replaceAll('%', '%25')}`
}

function degradedHint(problem) {
  if (problem == null) {
    return 'GitHub sent stack data this action could not use. Update to the latest release.'
  }
  if (problem.kind === 'no-token') return 'Set github-token on the gate step.'
  if (problem.kind === 'invalid-pr-number') {
    return 'Set pr-number to a pull request number, or leave it unset.'
  }
  if (problem.status === 401) return 'Check the github-token input.'
  if (problem.status === 403) {
    return 'Add pull-requests: read to the gate job. If it is already there, the token may have hit a rate limit.'
  }
  if (problem.status === 404) {
    return problem.prNumberOverride
      ? 'Check pr-number, or add pull-requests: read to the gate job.'
      : 'Add pull-requests: read to the gate job.'
  }
  return 'This is usually temporary.'
}

/** The lookup problem behind a degraded result. Bad stack data is its own cause. */
function degradedCause(result, problem) {
  return result.reason === INVALID_STACK_REASON ? null : problem
}

function reportProblem(log, result, problem) {
  if (result.degraded) {
    const cause = degradedCause(result, problem)
    log.warn(
      annotation(
        'warning',
        `Could not gate stacked CI; running checks by default. (${cause?.message ?? result.reason}) ${degradedHint(cause)}`,
      ),
    )
  } else if (problem) {
    log.log(
      `Stack lookup failed; the decision did not need it. (${safeText(problem.message)}) ${degradedHint(problem)}`,
    )
  }
}

const UNKNOWN_STACK_SOURCES = new Set(['error', 'no-token', 'invalid-input', 'none'])

function stackFlag(value, source) {
  if (UNKNOWN_STACK_SOURCES.has(source)) return 'unknown'
  return value ? 'yes' : 'no'
}

/** A pipe would end the table cell. */
function summaryCell(value) {
  return safeText(value).replaceAll('|', '\\|')
}

function knownOrUnknown(value) {
  if (value == null || value === '') return 'unknown'
  return summaryCell(value)
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
    ['Stacked', stackFlag(result.is_stacked, trace.source)],
    ['Bottom', stackFlag(result.is_bottom, trace.source)],
    ['Top', stackFlag(result.is_top, trace.source)],
    ['Position', knownOrUnknown(result.position)],
    ['Size', knownOrUnknown(result.size)],
    ['Event', summaryCell(eventLabel(trace))],
    ['Stack source', summaryCell(trace.source || 'unknown')],
  ]
  if (trace.problem) rows.push(['Stack lookup', summaryCell(trace.problem.message)])
  let markdown = '# Stack CI Gate\n\n| Field | Value |\n| --- | --- |\n'
  for (const [field, value] of rows) {
    markdown += `| ${field} | ${value} |\n`
  }
  if (result.degraded) {
    markdown += `\n## Action needed\n\nCI ran because the gate could not decide. ${degradedHint(degradedCause(result, trace.problem))}\n`
  }
  return markdown
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
    reportProblem(log, result, trace.problem)
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
  let event = {}
  const prNumberRaw = inputValue(env, 'pr-number')
  const hasPrNumberOverride = String(prNumberRaw ?? '').trim() !== ''
  // The hint for a 404 depends on whether pr-number chose the pull request.
  const withOverride = (problem) =>
    problem && hasPrNumberOverride ? { ...problem, prNumberOverride: true } : problem

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

    event = readEvent(env.GITHUB_EVENT_PATH)
    const pr = event.pull_request ?? {}
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
      lookupProblem: resolved.lookupProblem ? safeText(resolved.lookupProblem.message) : '',
    })
    write(result, {
      eventName,
      eventAction: event.action,
      source: resolved.source,
      eventStack: pr.stack,
      problem: withOverride(resolved.lookupProblem),
    })
    return { exitCode, result }
  } catch (err) {
    const message = safeText(err instanceof Error ? err.message : String(err))
    const result = failOpen(`error; running CI (${message})`, { degraded: true })
    write(result, {
      eventName,
      eventAction: event?.action,
      source: 'error',
      problem: withOverride({ message, status: err?.status }),
    })
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
