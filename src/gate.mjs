import fs from 'node:fs'
import {
  ConfigError,
  PR_EVENTS,
  decide,
  failOpen,
  parseBottomN,
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

function writeOutputs(outputPath, result, log, trace = {}) {
  const reason = oneLine(result.reason)
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
  const write = (result, trace) => writeOutputs(outputPath, result, log, trace)

  let bottomN
  let runTop
  try {
    bottomN = parseBottomN(inputValue(env, 'bottom-n'))
    runTop = parseRunTop(inputValue(env, 'run-top'))
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(`::error::${err.message}`)
      const result = failOpen(`invalid input; running CI (${err.message})`)
      write(result, { eventName: env.GITHUB_EVENT_NAME || '', source: 'invalid-input' })
      return { exitCode: 0, result, error: err }
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
      return { exitCode: 0, result }
    }

    const event = readEvent(env.GITHUB_EVENT_PATH)
    const pr = event.pull_request ?? {}
    const resolved = await resolveContext({
      eventAction: event.action,
      eventStack: pr.stack,
      eventPrNumber: pr.number,
      eventPrBaseRef: pr.base?.ref,
      prNumberOverride: inputValue(env, 'pr-number'),
      repo: env.GITHUB_REPOSITORY || '',
      token: inputValue(env, 'github-token') || env.GITHUB_TOKEN || '',
      apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
      fetchImpl,
      sleep,
      bottomN,
    })

    const result = decide({
      eventName,
      bottomN,
      runTop,
      stack: resolved.stack,
      prBaseRef: resolved.prBaseRef,
      remainingDepth: resolved.remainingDepth,
    })
    write(result, {
      eventName,
      eventAction: event.action,
      source: resolved.source,
      eventStack: pr.stack,
    })
    return { exitCode: 0, result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`Could not gate stacked CI; running checks by default. (${message})`)
    const result = failOpen(`error; running CI (${message})`)
    write(result, { eventName, source: 'error' })
    return { exitCode: 0, result }
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
