import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { run } from './gate.mjs'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function parseOutputs(file) {
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    const eq = line.indexOf('=')
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stack-ci-gate-'))
}

function writeEvent(dir, payload) {
  const file = path.join(dir, 'event.json')
  fs.writeFileSync(file, JSON.stringify(payload))
  return file
}

function baseEnv(dir, extra = {}) {
  return {
    'INPUT_BOTTOM-N': '1',
    'INPUT_RUN-TOP': 'true',
    'INPUT_GITHUB-TOKEN': 't',
    'INPUT_PR-NUMBER': '',
    GITHUB_REPOSITORY: 'octo/hello',
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_OUTPUT: path.join(dir, 'output.txt'),
    ...extra,
  }
}

const silent = {
  log() {},
  warn() {},
  error() {},
}

test('invalid bottom-n fail-opens should-run=true', async () => {
  const dir = tempDir()
  const errors = []
  const env = baseEnv(dir, {
    'INPUT_BOTTOM-N': 'nope',
    GITHUB_EVENT_NAME: 'pull_request',
  })
  const { exitCode, result } = await run(env, {
    log: {
      log() {},
      warn() {},
      error(msg) {
        errors.push(msg)
      },
    },
  })
  assert.equal(exitCode, 0)
  assert.equal(result.should_run, true)
  assert.equal(parseOutputs(env.GITHUB_OUTPUT)['should-run'], 'true')
  assert.ok(errors.some((msg) => String(msg).includes('bottom-n')))
})

test('merge_group writes should-run=true without fetching', async () => {
  const dir = tempDir()
  const env = baseEnv(dir, { GITHUB_EVENT_NAME: 'merge_group' })
  let fetches = 0
  const { exitCode, result } = await run(env, {
    log: silent,
    fetch: async () => {
      fetches += 1
      throw new Error('no fetch')
    },
  })
  assert.equal(exitCode, 0)
  assert.equal(result.should_run, true)
  assert.equal(fetches, 0)
  assert.equal(parseOutputs(env.GITHUB_OUTPUT)['should-run'], 'true')
})

test('opened with no event stack, API returns middle → should-run=false', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'opened',
    pull_request: {
      number: 42,
      base: { ref: 'feat/auth' },
      stack: null,
    },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
  })
  const { result } = await run(env, {
    log: silent,
    sleep: async () => {},
    fetch: async () =>
      jsonResponse({
        number: 42,
        base: { ref: 'feat/auth' },
        stack: {
          number: 50,
          position: 2,
          size: 3,
          base: { ref: 'main' },
        },
      }),
  })
  assert.equal(result.should_run, false)
  assert.equal(parseOutputs(env.GITHUB_OUTPUT)['should-run'], 'false')
  assert.equal(parseOutputs(env.GITHUB_OUTPUT)['is-stacked'], 'true')
})

test('opened path logs gate-trace with source=api and no event stack', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'opened',
    pull_request: {
      number: 42,
      base: { ref: 'feat/auth' },
      stack: null,
    },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
  })
  const lines = []
  await run(env, {
    log: {
      log(msg) {
        lines.push(String(msg))
      },
      warn() {},
      error() {},
    },
    sleep: async () => {},
    fetch: async () =>
      jsonResponse({
        number: 42,
        base: { ref: 'feat/auth' },
        stack: {
          number: 50,
          position: 2,
          size: 3,
          base: { ref: 'main' },
        },
      }),
  })
  const trace = lines.find((line) => line.includes('gate-trace'))
  assert.match(trace, /action=opened/)
  assert.match(trace, /source=api/)
  assert.match(trace, /event_stack=no/)
})

test('opened with no event stack, API empty then stack on retry → uses stacked result', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'opened',
    pull_request: { number: 42, base: { ref: 'feat/auth' } },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
  })
  let calls = 0
  const { result } = await run(env, {
    log: silent,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      if (calls === 1) {
        return jsonResponse({
          number: 42,
          base: { ref: 'feat/auth' },
          stack: null,
        })
      }
      return jsonResponse({
        number: 42,
        base: { ref: 'feat/auth' },
        stack: {
          number: 50,
          position: 2,
          size: 3,
          base: { ref: 'main' },
        },
      })
    },
  })
  assert.ok(calls >= 2)
  assert.equal(result.should_run, false)
  assert.equal(result.is_stacked, true)
})

test('opened with no event stack, API still empty after retries → should-run=true', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'opened',
    pull_request: { number: 42, base: { ref: 'main' }, stack: null },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
  })
  const { result } = await run(env, {
    log: silent,
    sleep: async () => {},
    fetch: async () =>
      jsonResponse({ number: 42, base: { ref: 'main' }, stack: null }),
  })
  assert.equal(result.should_run, true)
  assert.equal(result.is_stacked, false)
})

test('API failure fail-opens should-run=true', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'synchronize',
    pull_request: { number: 42, base: { ref: 'feat/auth' }, stack: null },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
  })
  const warnings = []
  const { exitCode, result } = await run(env, {
    log: {
      log() {},
      error() {},
      warn(msg) {
        warnings.push(msg)
      },
    },
    fetch: async () => jsonResponse({ message: 'nope' }, 502),
  })
  assert.equal(exitCode, 0)
  assert.equal(result.should_run, true)
  assert.match(warnings.join('\n'), /running checks by default/)
})

test('API error body is not logged or written to reason', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'synchronize',
    pull_request: { number: 42, base: { ref: 'feat/auth' }, stack: null },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
  })
  const warnings = []
  const logs = []
  const { result } = await run(env, {
    log: {
      log(msg) {
        logs.push(String(msg))
      },
      error() {},
      warn(msg) {
        warnings.push(String(msg))
      },
    },
    fetch: async () =>
      jsonResponse({ message: '::error::pwned ##[warning]x' }, 502),
  })
  const text = [warnings.join('\n'), logs.join('\n'), result.reason].join('\n')
  assert.equal(result.should_run, true)
  assert.doesNotMatch(text, /pwned/)
  assert.doesNotMatch(text, /::error::/)
  assert.doesNotMatch(text, /##\[warning\]/)
})

test('pr_number override ignores triggering event stack', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'synchronize',
    pull_request: {
      number: 10,
      base: { ref: 'main' },
      stack: {
        number: 50,
        position: 1,
        size: 3,
        base: { ref: 'main' },
      },
    },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
    'INPUT_PR-NUMBER': '12',
  })
  const { result } = await run(env, {
    log: silent,
    fetch: async (url) => {
      assert.match(url, /\/pulls\/12$/)
      return jsonResponse({
        number: 12,
        base: { ref: 'feat/api' },
        stack: {
          number: 50,
          position: 2,
          size: 3,
          base: { ref: 'main' },
        },
      })
    },
  })
  assert.equal(result.should_run, false)
  assert.equal(result.position, '2')
  assert.equal(result.is_bottom, false)
})

test('bottom_n=2 fetches stack members for remaining depth', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'synchronize',
    pull_request: {
      number: 12,
      base: { ref: 'feat/auth' },
      stack: {
        number: 50,
        position: 2,
        size: 4,
        base: { ref: 'main' },
      },
    },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
    'INPUT_BOTTOM-N': '2',
  })
  const { result } = await run(env, {
    log: silent,
    fetch: async (url) => {
      assert.match(url, /\/stacks\/50$/)
      return jsonResponse({
        number: 50,
        pull_requests: [
          { number: 10, state: 'open' },
          { number: 12, state: 'open' },
          { number: 13, state: 'open' },
          { number: 14, state: 'open' },
        ],
      })
    },
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /remaining depth 2/)
})

test('bottom_n=2 stack list failure fail-opens', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'synchronize',
    pull_request: {
      number: 12,
      base: { ref: 'feat/auth' },
      stack: {
        number: 50,
        position: 2,
        size: 4,
        base: { ref: 'main' },
      },
    },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
    'INPUT_BOTTOM-N': '2',
  })
  const { exitCode, result } = await run(env, {
    log: silent,
    fetch: async () => jsonResponse({ message: 'nope' }, 500),
  })
  assert.equal(exitCode, 0)
  assert.equal(result.should_run, true)
  assert.match(result.reason, /could not determine remaining stack depth/)
})

test('event stack on synchronize does not fetch the PR', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'synchronize',
    pull_request: {
      number: 10,
      base: { ref: 'main' },
      stack: {
        number: 50,
        position: 1,
        size: 3,
        base: { ref: 'main' },
      },
    },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
  })
  let fetches = 0
  const { result } = await run(env, {
    log: silent,
    fetch: async () => {
      fetches += 1
      throw new Error('no fetch')
    },
  })
  assert.equal(fetches, 0)
  assert.equal(result.should_run, true)
  assert.equal(result.is_bottom, true)
})

test('bottom-n=2 with this PR missing from the stack list fail-opens', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'synchronize',
    pull_request: {
      number: 12,
      base: { ref: 'feat/auth' },
      stack: {
        number: 50,
        position: 2,
        size: 4,
        base: { ref: 'main' },
      },
    },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
    'INPUT_BOTTOM-N': '2',
  })
  const { result } = await run(env, {
    log: silent,
    fetch: async () =>
      jsonResponse({
        number: 50,
        pull_requests: [
          { number: 10, state: 'open' },
          { number: 11, state: 'open' },
        ],
      }),
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /could not determine remaining stack depth/)
})

test('writes every kebab-case output', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'synchronize',
    pull_request: {
      number: 10,
      base: { ref: 'main' },
      stack: {
        number: 50,
        position: 1,
        size: 3,
        base: { ref: 'main' },
      },
    },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
  })
  await run(env, { log: silent })
  const out = parseOutputs(env.GITHUB_OUTPUT)
  assert.deepEqual(
    Object.keys(out).sort(),
    [
      'is-bottom',
      'is-stacked',
      'is-top',
      'position',
      'reason',
      'should-run',
      'size',
    ].sort(),
  )
  assert.equal(out['should-run'], 'true')
  assert.equal(out['is-stacked'], 'true')
  assert.equal(out['is-bottom'], 'true')
  assert.equal(out['is-top'], 'false')
  assert.equal(out.position, '1')
  assert.equal(out.size, '3')
  assert.ok(out.reason)
})

function midStackEvent({
  action = 'synchronize',
  labels,
  label,
  number = 11,
  baseRef = 'feat/auth',
  position = 2,
  size = 3,
} = {}) {
  const payload = {
    action,
    pull_request: {
      number,
      base: { ref: baseRef },
      stack: {
        number: 50,
        position,
        size,
        base: { ref: 'main' },
      },
    },
  }
  if (labels !== undefined) payload.pull_request.labels = labels
  if (label !== undefined) payload.label = label
  return payload
}

async function runPull(dir, payload, envExtra = {}, fetch) {
  const event = writeEvent(dir, payload)
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
    ...envExtra,
  })
  const { result } = await run(env, { log: silent, fetch })
  return { result, out: parseOutputs(env.GITHUB_OUTPUT), env }
}

function noFetch() {
  const calls = []
  const fetch = async (url) => {
    calls.push(url)
    throw new Error(`unexpected fetch ${url}`)
  }
  return { calls, fetch }
}

test('mid-stack force-run label runs without fetching', async () => {
  const dir = tempDir()
  const { calls, fetch } = noFetch()
  const { result, out } = await runPull(
    dir,
    midStackEvent({ labels: [{ name: 'stack-ci:run' }] }),
    {},
    fetch,
  )
  assert.equal(calls.length, 0)
  assert.equal(result.should_run, true)
  assert.equal(result.is_bottom, false)
  assert.equal(result.position, '2')
  assert.equal(out['should-run'], 'true')
  assert.equal(out.reason, 'force-run label stack-ci:run')
})

test('mid-stack with a different label skips without fetching', async () => {
  const dir = tempDir()
  const { calls, fetch } = noFetch()
  const { result, out } = await runPull(
    dir,
    midStackEvent({ labels: [{ name: 'bug' }] }),
    {},
    fetch,
  )
  assert.equal(calls.length, 0)
  assert.equal(result.should_run, false)
  assert.match(result.reason, /middle of stack/)
  assert.equal(out['should-run'], 'false')
  assert.match(out.reason, /middle of stack/)
})

test('empty force-run-label disables force-run', async () => {
  const dir = tempDir()
  const { calls, fetch } = noFetch()
  const { result, out } = await runPull(
    dir,
    midStackEvent({ labels: [{ name: 'stack-ci:run' }] }),
    { 'INPUT_FORCE-RUN-LABEL': '' },
    fetch,
  )
  assert.equal(calls.length, 0)
  assert.equal(result.should_run, false)
  assert.equal(out['should-run'], 'false')
})

test('custom force-run label name runs', async () => {
  const dir = tempDir()
  const { calls, fetch } = noFetch()
  const { result, out } = await runPull(
    dir,
    midStackEvent({ labels: [{ name: 'ship-it' }] }),
    { 'INPUT_FORCE-RUN-LABEL': 'ship-it' },
    fetch,
  )
  assert.equal(calls.length, 0)
  assert.equal(result.should_run, true)
  assert.equal(out.reason, 'force-run label ship-it')
})

test('labeled event counts the added label when the array is empty', async () => {
  const dir = tempDir()
  const { calls, fetch } = noFetch()
  const { result, out } = await runPull(
    dir,
    midStackEvent({
      action: 'labeled',
      labels: [],
      label: { name: 'stack-ci:run' },
    }),
    {},
    fetch,
  )
  assert.equal(calls.length, 0)
  assert.equal(result.should_run, true)
  assert.equal(out.reason, 'force-run label stack-ci:run')
})

test('unlabeled event drops the removed label still listed on the pull request', async () => {
  const dir = tempDir()
  const { calls, fetch } = noFetch()
  const { result, out } = await runPull(
    dir,
    midStackEvent({
      action: 'unlabeled',
      labels: [{ name: 'stack-ci:run' }],
      label: { name: 'stack-ci:run' },
    }),
    {},
    fetch,
  )
  assert.equal(calls.length, 0)
  assert.equal(result.should_run, false)
  assert.match(out.reason, /middle of stack/)
})

test('unlabeled of another label keeps force-run', async () => {
  const dir = tempDir()
  const { calls, fetch } = noFetch()
  const { result, out } = await runPull(
    dir,
    midStackEvent({
      action: 'unlabeled',
      labels: [{ name: 'stack-ci:run' }, { name: 'bug' }],
      label: { name: 'bug' },
    }),
    {},
    fetch,
  )
  assert.equal(calls.length, 0)
  assert.equal(result.should_run, true)
  assert.equal(out.reason, 'force-run label stack-ci:run')
})

test('pr-number override uses the fetched pull request labels', async () => {
  const dir = tempDir()
  const calls = []
  const eventLabels = [{ name: 'stack-ci:run' }]
  const { result, out } = await runPull(
    dir,
    {
      action: 'synchronize',
      pull_request: {
        number: 10,
        base: { ref: 'main' },
        labels: eventLabels,
        stack: {
          number: 50,
          position: 1,
          size: 3,
          base: { ref: 'main' },
        },
      },
    },
    { 'INPUT_PR-NUMBER': '12' },
    async (url) => {
      calls.push(url)
      assert.match(url, /\/pulls\/12$/)
      return jsonResponse({
        number: 12,
        base: { ref: 'feat/api' },
        stack: {
          number: 50,
          position: 2,
          size: 3,
          base: { ref: 'main' },
        },
        labels: [{ name: 'bug' }],
      })
    },
  )
  assert.deepEqual(calls.map((url) => url.replace(/.*\/repos\/octo\/hello/, '')), ['/pulls/12'])
  assert.equal(result.should_run, false)
  assert.equal(out['should-run'], 'false')
})

test('pr-number override force-runs from the fetched labels', async () => {
  const dir = tempDir()
  const calls = []
  const { result, out } = await runPull(
    dir,
    {
      action: 'synchronize',
      label: { name: 'bug' },
      pull_request: {
        number: 10,
        base: { ref: 'main' },
        labels: [{ name: 'bug' }],
        stack: {
          number: 50,
          position: 1,
          size: 3,
          base: { ref: 'main' },
        },
      },
    },
    { 'INPUT_PR-NUMBER': '12' },
    async (url) => {
      calls.push(url)
      return jsonResponse({
        number: 12,
        base: { ref: 'feat/api' },
        stack: {
          number: 50,
          position: 2,
          size: 3,
          base: { ref: 'main' },
        },
        labels: [{ name: 'stack-ci:run' }],
      })
    },
  )
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/pulls\/12$/)
  assert.equal(result.should_run, true)
  assert.equal(out.reason, 'force-run label stack-ci:run')
})

test('opened without event stack uses labels from the pull request fetch', async () => {
  const dir = tempDir()
  const calls = []
  const { result } = await runPull(
    dir,
    {
      action: 'opened',
      pull_request: {
        number: 11,
        base: { ref: 'feat/auth' },
      },
    },
    {},
    async (url) => {
      calls.push(url)
      return jsonResponse({
        number: 11,
        base: { ref: 'feat/auth' },
        stack: {
          number: 50,
          position: 2,
          size: 3,
          base: { ref: 'main' },
        },
        labels: [{ name: 'stack-ci:run' }],
      })
    },
  )
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/pulls\/11$/)
  assert.equal(result.should_run, true)
  assert.equal(result.reason, 'force-run label stack-ci:run')
})

test('force-run reason neutralizes workflow commands in the label name', async () => {
  const dir = tempDir()
  const { out, env } = await runPull(
    dir,
    midStackEvent({ labels: [{ name: 'bad::name' }] }),
    { 'INPUT_FORCE-RUN-LABEL': 'bad::name' },
    async () => {
      throw new Error('no fetch')
    },
  )
  assert.equal(out.reason, 'force-run label bad: :name')
  assert.doesNotMatch(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /::/)
})

function summaryEnv(dir, extra = {}) {
  return {
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    ...extra,
  }
}

function readSummary(env) {
  return fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')
}

test('mid-stack skip writes a job summary from the event, without an API call', async () => {
  const dir = tempDir()
  const { calls, fetch } = noFetch()
  const { result, env } = await runPull(
    dir,
    midStackEvent({ number: 12, position: 2, size: 3 }),
    summaryEnv(dir),
    fetch,
  )
  const summary = readSummary(env)
  assert.equal(calls.length, 0)
  assert.equal(result.should_run, false)
  assert.match(summary, /^# Stack CI Gate\n/)
  assert.match(summary, /\| Decision \| Skip gated jobs \|/)
  assert.match(summary, /\| Reason \| middle of stack \(position 2 of size 3\); skipping CI on this layer \|/)
  assert.match(summary, /\| Stacked \| yes \|/)
  assert.match(summary, /\| Bottom \| no \|/)
  assert.match(summary, /\| Top \| no \|/)
  assert.match(summary, /\| Position \| 2 \|/)
  assert.match(summary, /\| Size \| 3 \|/)
  assert.match(summary, /\| Event \| pull_request synchronize \|/)
  assert.match(summary, /\| Stack source \| event \|/)
  const fields = ['Decision', 'Reason', 'Stacked', 'Bottom', 'Top', 'Position', 'Size', 'Event', 'Stack source']
  const indexes = fields.map((name) => summary.indexOf(`| ${name} |`))
  assert.ok(indexes.every((index) => index >= 0))
  for (let i = 1; i < indexes.length; i++) assert.ok(indexes[i] > indexes[i - 1])
})

test('remaining bottom summary says run gated jobs', async () => {
  const dir = tempDir()
  const { fetch } = noFetch()
  const { result, env } = await runPull(
    dir,
    midStackEvent({ number: 10, baseRef: 'main', position: 2, size: 4 }),
    summaryEnv(dir),
    fetch,
  )
  const summary = readSummary(env)
  assert.equal(result.should_run, true)
  assert.match(summary, /\| Decision \| Run gated jobs \|/)
  assert.match(summary, /\| Bottom \| yes \|/)
  assert.match(summary, /\| Position \| 2 \|/)
})

test('job summary is skipped when GITHUB_STEP_SUMMARY is unset', async () => {
  const dir = tempDir()
  const { fetch } = noFetch()
  const { result } = await runPull(dir, midStackEvent({ number: 12 }), {}, fetch)
  assert.equal(result.should_run, false)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['event.json', 'output.txt'])
})

test('merge_group summary runs with no stack data', async () => {
  const dir = tempDir()
  const env = baseEnv(dir, { GITHUB_EVENT_NAME: 'merge_group', ...summaryEnv(dir) })
  const { calls, fetch } = noFetch()
  const { result } = await run(env, { log: silent, fetch })
  const summary = readSummary(env)
  assert.equal(calls.length, 0)
  assert.equal(result.should_run, true)
  assert.match(summary, /\| Decision \| Run gated jobs \|/)
  assert.match(summary, /\| Position \| unknown \|/)
  assert.match(summary, /\| Size \| unknown \|/)
  assert.match(summary, /\| Event \| merge_group \|/)
  assert.match(summary, /\| Stack source \| n\/a \|/)
})

test('standalone summary says not stacked', async () => {
  const dir = tempDir()
  const { result, env } = await runPull(
    dir,
    { action: 'synchronize', pull_request: { number: 42, base: { ref: 'main' }, stack: null } },
    summaryEnv(dir),
    async (url) => {
      assert.match(url, /\/pulls\/42$/)
      return jsonResponse({ number: 42, base: { ref: 'main' }, stack: null })
    },
  )
  const summary = readSummary(env)
  assert.equal(result.should_run, true)
  assert.match(summary, /\| Stacked \| no \|/)
  assert.match(summary, /\| Stack source \| api \|/)
})

test('invalid input summary still runs and does not throw', async () => {
  const dir = tempDir()
  const env = baseEnv(dir, {
    'INPUT_BOTTOM-N': 'nope',
    GITHUB_EVENT_NAME: 'pull_request',
    ...summaryEnv(dir),
  })
  const { exitCode, result } = await run(env, { log: silent })
  const summary = readSummary(env)
  assert.equal(exitCode, 0)
  assert.equal(result.should_run, true)
  assert.match(summary, /\| Decision \| Run gated jobs \|/)
  assert.match(summary, /\| Reason \| invalid input; running CI/)
  assert.match(summary, /\| Event \| pull_request \|/)
  assert.match(summary, /\| Stack source \| invalid-input \|/)
  assert.match(
    summary,
    /## Action needed\n\nCI ran because the gate could not decide\. Check the input values on the gate step\./,
  )
  assert.doesNotMatch(summary, /Stack lookup/)
})

test('invalid input is one escaped error annotation and no warning', async () => {
  const dir = tempDir()
  const errors = []
  const warnings = []
  const env = baseEnv(dir, {
    'INPUT_BOTTOM-N': '50%0A::notice::x',
    GITHUB_EVENT_NAME: 'pull_request',
  })
  const { exitCode, result } = await run(env, {
    log: {
      log() {},
      warn(msg) {
        warnings.push(String(msg))
      },
      error(msg) {
        errors.push(String(msg))
      },
    },
  })
  assert.equal(exitCode, 0)
  assert.equal(result.should_run, true)
  assert.equal(result.degraded, true)
  assert.deepEqual(warnings, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /^::error title=Stack CI Gate::bottom-n must be a non-negative integer/)
  const body = errors[0].replace(/^::error title=Stack CI Gate::/, '')
  assert.doesNotMatch(body, /::/)
  assert.doesNotMatch(body, /%0A/)
  assert.match(body, /50%250A/)
})

test('a job summary write failure does not change should-run', async () => {
  const dir = tempDir()
  const warnings = []
  const event = writeEvent(dir, midStackEvent({ number: 12 }))
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
    GITHUB_STEP_SUMMARY: path.join(dir, 'missing', 'summary.md'),
  })
  const { exitCode, result } = await run(env, {
    log: { log() {}, error() {}, warn(msg) { warnings.push(String(msg)) } },
    fetch: noFetch().fetch,
  })
  assert.equal(exitCode, 0)
  assert.equal(result.should_run, false)
  assert.equal(parseOutputs(env.GITHUB_OUTPUT)['should-run'], 'false')
  assert.match(warnings.join('\n'), /Could not write the job summary/)
})

function capture() {
  const lines = { log: [], warn: [], error: [] }
  const log = {
    log(msg) { lines.log.push(String(msg)) },
    warn(msg) { lines.warn.push(String(msg)) },
    error(msg) { lines.error.push(String(msg)) },
  }
  return { lines, log }
}

function outputDirEnv(dir, extra = {}) {
  const outputDir = path.join(dir, 'output-dir')
  fs.mkdirSync(outputDir)
  return baseEnv(dir, { GITHUB_OUTPUT: outputDir, ...summaryEnv(dir), ...extra })
}

const OUTPUT_ERROR =
  /^::error title=Stack CI Gate::Could not write gate outputs, so should-run is empty and this step failed\. Jobs that need the gate job are skipped unless their if: uses !cancelled\(\) or always\(\)\. \(/

test('an output write failure on a skip exits 1 with an error annotation', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, midStackEvent({ number: 12 }))
  const env = outputDirEnv(dir, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event })
  const { lines, log } = capture()
  const { exitCode, result } = await run(env, { log, fetch: noFetch().fetch })
  assert.equal(exitCode, 1)
  assert.equal(result.should_run, false)
  assert.equal(lines.error.length, 1)
  assert.match(lines.error[0], OUTPUT_ERROR)
  assert.match(readSummary(env), /\| Decision \| Skip gated jobs \|/)
})

test('an output write failure on a run exits 1 with an error annotation', async () => {
  const dir = tempDir()
  const env = outputDirEnv(dir, { GITHUB_EVENT_NAME: 'merge_group' })
  const { lines, log } = capture()
  const { exitCode, result } = await run(env, { log, fetch: noFetch().fetch })
  assert.equal(exitCode, 1)
  assert.equal(result.should_run, true)
  assert.equal(lines.error.length, 1)
  assert.match(lines.error[0], OUTPUT_ERROR)
  assert.match(readSummary(env), /\| Decision \| Run gated jobs \|/)
})

test('an output write failure on invalid input exits 1', async () => {
  const dir = tempDir()
  const env = outputDirEnv(dir, { 'INPUT_BOTTOM-N': 'nope', GITHUB_EVENT_NAME: 'pull_request' })
  const { lines, log } = capture()
  const { exitCode, result } = await run(env, { log })
  assert.equal(exitCode, 1)
  assert.equal(result.should_run, true)
  assert.ok(lines.error.some((msg) => OUTPUT_ERROR.test(msg)))
  assert.match(readSummary(env), /\| Stack source \| invalid-input \|/)
})

test('the job summary appends to an existing file', async () => {
  const dir = tempDir()
  const env = summaryEnv(dir)
  fs.writeFileSync(env.GITHUB_STEP_SUMMARY, '# Earlier step\n\n')
  await runPull(dir, midStackEvent({ number: 12 }), env, noFetch().fetch)
  const summary = readSummary(env)
  assert.match(summary, /^# Earlier step\n\n# Stack CI Gate\n/)
  assert.match(summary, /\| Decision \| Skip gated jobs \|/)
})

test('fail-open summaries show unknown stack flags', async () => {
  const cases = [
    {
      name: 'error',
      payload: { action: 'synchronize', pull_request: { number: 42, base: { ref: 'feat/auth' }, stack: null } },
      env: {},
      fetch: async () => jsonResponse({}, 502),
    },
    {
      name: 'no-token',
      payload: { action: 'synchronize', pull_request: { number: 42, base: { ref: 'feat/auth' }, stack: null } },
      env: { 'INPUT_GITHUB-TOKEN': '' },
      fetch: noFetch().fetch,
    },
    {
      name: 'none',
      payload: { action: 'synchronize', pull_request: { base: { ref: 'feat/auth' } } },
      env: {},
      fetch: noFetch().fetch,
    },
  ]
  for (const item of cases) {
    const dir = tempDir()
    const { result, env } = await runPull(dir, item.payload, summaryEnv(dir, item.env), item.fetch)
    const summary = readSummary(env)
    assert.equal(result.should_run, true, item.name)
    assert.match(summary, new RegExp(`\\| Stack source \\| ${item.name} \\|`))
    assert.match(summary, /\| Stacked \| unknown \|/, item.name)
    assert.match(summary, /\| Bottom \| unknown \|/, item.name)
    assert.match(summary, /\| Top \| unknown \|/, item.name)
  }
})

test('invalid input summary shows unknown stack flags', async () => {
  const dir = tempDir()
  const env = baseEnv(dir, { 'INPUT_BOTTOM-N': 'nope', GITHUB_EVENT_NAME: 'pull_request', ...summaryEnv(dir) })
  await run(env, { log: silent })
  assert.match(readSummary(env), /\| Stacked \| unknown \|/)
})

test('error summary keeps the event action', async () => {
  const dir = tempDir()
  const { env } = await runPull(
    dir,
    { action: 'opened', pull_request: { number: 42, base: { ref: 'feat/auth' }, stack: null } },
    summaryEnv(dir),
    async () => jsonResponse({}, 502),
  )
  const summary = readSummary(env)
  assert.match(summary, /\| Event \| pull_request opened \|/)
  assert.match(summary, /\| Stack source \| error \|/)
})

test('summary text neutralizes workflow commands', async () => {
  const dir = tempDir()
  const label = 'bad::name##[x|y'
  const { out, env } = await runPull(
    dir,
    midStackEvent({ labels: [{ name: label }] }),
    summaryEnv(dir, { 'INPUT_FORCE-RUN-LABEL': label }),
    noFetch().fetch,
  )
  const summary = readSummary(env)
  assert.equal(out.reason, 'force-run label bad: :name# [x|y')
  assert.match(summary, /force-run label bad: :name# \[x\\\|y/)
  assert.doesNotMatch(summary, /::/)
  assert.doesNotMatch(summary, /##\[/)
})

test('error summary neutralizes workflow commands and pipes in the error', async () => {
  const dir = tempDir()
  const { result, env } = await runPull(
    dir,
    { action: 'synchronize', pull_request: { number: 42, base: { ref: 'feat/auth' }, stack: null } },
    summaryEnv(dir),
    async () => {
      throw new Error('::error::pwned ##[warning]x | y')
    },
  )
  const summary = readSummary(env)
  assert.equal(result.should_run, true)
  assert.match(summary, /\| Stack source \| error \|/)
  assert.match(summary, /: :error: :pwned # \[warning\]x \\\| y/)
  assert.doesNotMatch(summary, /::/)
  assert.doesNotMatch(summary, /##\[/)
})

const ANNOTATION = /^::warning title=Stack CI Gate::/

async function runCaptured(dir, payload, envExtra, fetch) {
  const event = writeEvent(dir, payload)
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
    ...summaryEnv(dir),
    ...envExtra,
  })
  const logs = []
  const warnings = []
  const errors = []
  const { exitCode, result } = await run(env, {
    log: {
      log(msg) {
        logs.push(String(msg))
      },
      error(msg) {
        errors.push(String(msg))
      },
      warn(msg) {
        warnings.push(String(msg))
      },
    },
    sleep: async () => {},
    fetch,
  })
  return {
    exitCode,
    result,
    logs,
    warnings,
    errors,
    out: parseOutputs(env.GITHUB_OUTPUT),
    summary: fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'),
  }
}

function openPulls(...numbers) {
  return numbers.map((number) => ({ number, state: 'open' }))
}

const unstackedEvent = {
  action: 'synchronize',
  pull_request: { number: 42, base: { ref: 'feat/auth' }, stack: null },
}

for (const [status, hint] of [
  [401, /github-token/],
  [403, /pull-requests: read.*rate limit/],
  [404, /pull-requests: read/],
  [429, /usually temporary/],
  [500, /usually temporary/],
]) {
  test(`a ${status} from the pull request lookup warns with its fix`, async () => {
    const { exitCode, out, warnings, summary } = await runCaptured(
      tempDir(),
      unstackedEvent,
      {},
      async () => jsonResponse({ message: 'nope' }, status),
    )
    assert.equal(exitCode, 0)
    assert.equal(out['should-run'], 'true')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], ANNOTATION)
    assert.match(warnings[0], new RegExp(`→ ${status}`))
    assert.match(warnings[0], hint)
    assert.match(summary, /## Action needed/)
    assert.match(summary, hint)
    assert.doesNotMatch(warnings[0], /Check pr-number/)
  })
}

test('a timed out pull request lookup warns that it is temporary', async () => {
  const { out, warnings } = await runCaptured(
    tempDir(),
    unstackedEvent,
    {},
    async () => {
      throw new Error('The operation was aborted due to timeout')
    },
  )
  assert.equal(out['should-run'], 'true')
  assert.match(warnings[0], ANNOTATION)
  assert.match(warnings[0], /timeout.*usually temporary/)
})

test('a failed stack lookup that forces a run warns with the cause', async () => {
  const { out, warnings, summary } = await runCaptured(
    tempDir(),
    midStackEvent(),
    { 'INPUT_BOTTOM-N': '2' },
    async () => jsonResponse({ message: 'nope' }, 403),
  )
  assert.equal(out['should-run'], 'true')
  assert.match(out.reason, /could not determine remaining stack depth; running CI \(.*→ 403\)/)
  assert.match(warnings[0], ANNOTATION)
  assert.match(warnings[0], /pull-requests: read/)
  assert.match(summary, /## Action needed/)
  assert.match(summary, /\| Stack lookup \| GET .*→ 403 \|/)
})

for (const [name, payload] of [
  ['remaining bottom', midStackEvent({ baseRef: 'main', position: 1 })],
  ['top', midStackEvent({ position: 3 })],
]) {
  test(`a failed stack lookup on the ${name} only logs with bottom-n=2`, async () => {
    const { out, warnings, errors, logs, summary } = await runCaptured(
      tempDir(),
      payload,
      { 'INPUT_BOTTOM-N': '2' },
      async () => jsonResponse({ message: 'nope' }, 403),
    )
    assert.equal(out['should-run'], 'true')
    assert.deepEqual(warnings, [])
    assert.deepEqual(errors, [])
    assert.match(logs.join('\n'), /Stack lookup failed.*→ 403/)
    assert.match(summary, /\| Stack lookup \| GET .*→ 403 \|/)
    assert.doesNotMatch(summary, /Action needed/)
  })
}

test('a failed stack lookup on a force-run labeled mid-stack PR only logs', async () => {
  const { out, warnings, errors, logs, summary } = await runCaptured(
    tempDir(),
    midStackEvent({ labels: [{ name: 'stack-ci:run' }] }),
    { 'INPUT_BOTTOM-N': '2' },
    async () => jsonResponse({ message: 'nope' }, 403),
  )
  assert.equal(out['should-run'], 'true')
  assert.equal(out.reason, 'force-run label stack-ci:run')
  assert.deepEqual(warnings, [])
  assert.deepEqual(errors, [])
  assert.match(logs.join('\n'), /Stack lookup failed.*→ 403/)
  assert.match(summary, /\| Stack lookup \| GET .*→ 403 \|/)
  assert.doesNotMatch(summary, /Action needed/)
})

for (const action of ['synchronize', 'opened']) {
  test(`no token on a PR not known to be stacked stays quiet on ${action}`, async () => {
    let fetches = 0
    const { exitCode, out, warnings, errors, logs, summary } = await runCaptured(
      tempDir(),
      { ...unstackedEvent, action },
      { 'INPUT_GITHUB-TOKEN': '' },
      async () => {
        fetches += 1
        throw new Error('no fetch')
      },
    )
    assert.equal(exitCode, 0)
    assert.equal(fetches, 0)
    assert.equal(out['should-run'], 'true')
    assert.doesNotMatch(out.reason, /not in a stack/)
    assert.match(out.reason, /no token/)
    assert.deepEqual(warnings, [])
    assert.deepEqual(errors, [])
    assert.match(logs.join('\n'), /github-token is empty, so the gate did not look for a stack/)
    assert.match(summary, /\| Error \| no token to read the stack \|/)
    assert.match(summary, /\| Stacked \| unknown \|/)
    assert.doesNotMatch(summary, /Action needed/)
  })
}

test('no token on a stacked PR that needs the stack listing warns with the fork hint', async () => {
  const { out, warnings, summary } = await runCaptured(
    tempDir(),
    midStackEvent(),
    { 'INPUT_BOTTOM-N': '2', 'INPUT_GITHUB-TOKEN': '' },
    async () => {
      throw new Error('no fetch')
    },
  )
  assert.equal(out['should-run'], 'true')
  assert.match(out.reason, /could not determine remaining stack depth.*no token/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], ANNOTATION)
  assert.match(
    warnings[0],
    /github-token is empty\. Pull requests from forks and Dependabot get no secrets, so set github-token to \$\{\{ secrets\.NAME \|\| github\.token \}\} to fall back to the default token\.$/,
  )
  assert.match(summary, /## Action needed/)
  assert.match(summary, /forks and Dependabot/)
})

test('a non-numeric pr-number warns and names the input', async () => {
  let fetches = 0
  const { out, warnings } = await runCaptured(
    tempDir(),
    unstackedEvent,
    { 'INPUT_PR-NUMBER': 'abc' },
    async () => {
      fetches += 1
      throw new Error('no fetch')
    },
  )
  assert.equal(fetches, 0)
  assert.equal(out['should-run'], 'true')
  assert.doesNotMatch(out.reason, /not in a stack/)
  assert.match(out.reason, /pr-number/)
  assert.match(warnings[0], ANNOTATION)
  assert.match(warnings[0], /Set pr-number/)
})

for (const value of ['-3', '0', '1.5', '0x10', '1e3']) {
  test(`pr-number ${JSON.stringify(value)} fails open with the pr-number hint`, async () => {
    const { out, warnings, summary } = await runCaptured(
      tempDir(),
      midStackEvent(),
      { 'INPUT_PR-NUMBER': value },
      async () => {
        throw new Error('no fetch')
      },
    )
    assert.equal(out['should-run'], 'true')
    assert.match(out.reason, /could not read the stack.*pr-number/)
    assert.match(warnings[0], /Set pr-number to a pull request number/)
    assert.match(summary, /## Action needed/)
  })
}

test('a 404 with pr-number set names the input in the hint', async () => {
  const { out, warnings, summary } = await runCaptured(
    tempDir(),
    unstackedEvent,
    { 'INPUT_PR-NUMBER': '999' },
    async () => jsonResponse({ message: 'Not Found' }, 404),
  )
  assert.equal(out['should-run'], 'true')
  assert.match(warnings[0], /Check pr-number, or add pull-requests: read to the gate job\./)
  assert.match(summary, /Check pr-number, or add pull-requests: read/)
})

test('invalid stack metadata warns', async () => {
  const { out, warnings, summary } = await runCaptured(
    tempDir(),
    midStackEvent({ position: 'nope' }),
    {},
    async () => jsonResponse({ pull_requests: [] }),
  )
  assert.equal(out['should-run'], 'true')
  assert.equal(out.reason, 'invalid stack metadata; running CI')
  assert.match(warnings[0], ANNOTATION)
  assert.match(summary, /## Action needed/)
})

test('invalid stack metadata with a failed lookup names the bad data, not the lookup', async () => {
  const { out, warnings, summary } = await runCaptured(
    tempDir(),
    midStackEvent({ position: 'nope' }),
    { 'INPUT_BOTTOM-N': '2' },
    async () => jsonResponse({ message: 'nope' }, 403),
  )
  assert.equal(out['should-run'], 'true')
  assert.equal(out.reason, 'invalid stack metadata; running CI')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /\(invalid stack metadata; running CI\)/)
  assert.match(warnings[0], /Update to the latest release\./)
  assert.doesNotMatch(warnings[0], /pull-requests: read|→ 403/)
  assert.match(summary, /## Action needed\n\nCI ran because the gate could not decide\. GitHub sent stack data/)
  assert.doesNotMatch(summary.split('## Action needed')[1], /pull-requests: read/)
})

test('a stack listing without this PR warns with bottom-n=2', async () => {
  const { out, warnings, summary } = await runCaptured(
    tempDir(),
    midStackEvent(),
    { 'INPUT_BOTTOM-N': '2' },
    async () => jsonResponse({ number: 50, pull_requests: openPulls(10, 13) }),
  )
  assert.equal(out['should-run'], 'true')
  assert.equal(
    out.reason,
    'could not determine remaining stack depth; running CI (this pull request is not open in the stack listing)',
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], ANNOTATION)
  assert.match(warnings[0], /not open in its stack, for example after a merge, a close or an unstack/)
  assert.doesNotMatch(warnings[0], /Update to the latest release/)
  assert.match(summary, /\| Stack lookup \| this pull request is not open in the stack listing \|/)
  assert.match(summary, /## Action needed\n\nCI ran because the gate could not decide\. The pull request is not open/)
})

test('a stack listing without pull_requests still says to update', async () => {
  const { out, warnings } = await runCaptured(
    tempDir(),
    midStackEvent(),
    { 'INPUT_BOTTOM-N': '2' },
    async () => jsonResponse({ number: 50 }),
  )
  assert.equal(out['should-run'], 'true')
  assert.equal(out.reason, 'could not determine remaining stack depth; running CI')
  assert.match(warnings[0], /Update to the latest release\./)
})

test('standalone pull requests and normal skips stay quiet', async () => {
  const standalone = await runCaptured(
    tempDir(),
    unstackedEvent,
    {},
    async () => jsonResponse({ number: 42, base: { ref: 'main' }, stack: null }),
  )
  assert.equal(standalone.out['should-run'], 'true')
  assert.equal(standalone.out.reason, 'not in a stack; running CI')
  assert.deepEqual(standalone.warnings, [])
  assert.deepEqual(standalone.errors, [])
  assert.doesNotMatch(standalone.summary, /Action needed|Stack lookup/)

  const skipped = await runCaptured(
    tempDir(),
    midStackEvent({ number: 12 }),
    {},
    async () => {
      throw new Error('no fetch')
    },
  )
  assert.equal(skipped.out['should-run'], 'false')
  assert.deepEqual(skipped.warnings, [])
  assert.deepEqual(skipped.errors, [])
  assert.doesNotMatch(skipped.summary, /Action needed|Stack lookup/)
})

test('opened with no stack after the retries stays quiet', async () => {
  let fetches = 0
  const { out, warnings, errors, summary } = await runCaptured(
    tempDir(),
    { action: 'opened', pull_request: { number: 42, base: { ref: 'feat/auth' }, stack: null } },
    {},
    async () => {
      fetches += 1
      return jsonResponse({ number: 42, base: { ref: 'feat/auth' }, stack: null })
    },
  )
  assert.ok(fetches > 1)
  assert.equal(out['should-run'], 'true')
  assert.equal(out.reason, 'not in a stack; running CI')
  assert.deepEqual(warnings, [])
  assert.deepEqual(errors, [])
  assert.doesNotMatch(summary, /Action needed|Stack lookup/)
})

for (const eventName of ['merge_group', 'push']) {
  test(`${eventName} stays quiet`, async () => {
    const { out, warnings, errors, summary } = await runCaptured(
      tempDir(),
      {},
      { GITHUB_EVENT_NAME: eventName },
      async () => {
        throw new Error('no fetch')
      },
    )
    assert.equal(out['should-run'], 'true')
    assert.deepEqual(warnings, [])
    assert.deepEqual(errors, [])
    assert.doesNotMatch(summary, /Action needed|Stack lookup/)
  })
}

test('annotations keep literal newlines and a lone % on one escaped line', async () => {
  const { warnings, errors, summary } = await runCaptured(
    tempDir(),
    unstackedEvent,
    {},
    async () => {
      throw new Error('line one\nline two\r::notice::x 100% done')
    },
  )
  assert.deepEqual(errors, [])
  assert.equal(warnings.length, 1)
  assert.doesNotMatch(warnings[0], /[\r\n]/)
  const body = warnings[0].replace(ANNOTATION, '')
  assert.match(body, /line one line two/)
  assert.match(body, /100%25 done/)
  assert.doesNotMatch(body, /%(?!25)/)
  assert.doesNotMatch(body, /::/)
  assert.match(summary, /\| Reason \| error; running CI \(line one line two : :notice: :x 100% done\) \|/)
})

test('annotations neutralize workflow commands and encoded newlines', async () => {
  const { warnings, summary } = await runCaptured(
    tempDir(),
    unstackedEvent,
    {},
    async () => {
      throw new Error('::error::pwned ##[warning]x %0A::notice::y')
    },
  )
  assert.equal(warnings.length, 1)
  const body = warnings[0].replace(ANNOTATION, '')
  assert.doesNotMatch(body, /::/)
  assert.doesNotMatch(body, /##\[/)
  assert.doesNotMatch(body, /%0A/)
  assert.match(body, /%250A/)
  assert.doesNotMatch(summary, /::/)
  assert.doesNotMatch(summary, /##\[/)
})

function nonJsonResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON")
    },
  }
}

for (const [status, hint] of [
  [401, /Check the github-token input\./],
  [404, /The stack may have changed; re-run\. If it repeats, add pull-requests: read to the gate job\./],
  [429, /usually temporary/],
  [500, /usually temporary/],
  [502, /usually temporary/],
  [422, /Re-run the job\. If it repeats, open an issue/],
]) {
  test(`a ${status} from the stack lookup warns with its fix`, async () => {
    const { out, warnings, summary } = await runCaptured(
      tempDir(),
      midStackEvent(),
      { 'INPUT_BOTTOM-N': '2' },
      async (url) => {
        assert.match(url, /\/stacks\/50$/)
        return jsonResponse({ message: 'nope' }, status)
      },
    )
    assert.equal(out['should-run'], 'true')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], new RegExp(`stacks/50 → ${status}`))
    assert.match(warnings[0], hint)
    assert.match(summary, new RegExp(`\\| Stack lookup \\| GET .*→ ${status} \\|`))
    if (status === 422) assert.doesNotMatch(warnings[0], /usually temporary/)
  })
}

test('a network error on the stack lookup says it is temporary', async () => {
  const { warnings } = await runCaptured(
    tempDir(),
    midStackEvent(),
    { 'INPUT_BOTTOM-N': '2' },
    async () => {
      throw new TypeError('fetch failed')
    },
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /fetch failed\) This is usually temporary\.$/)
})

test('a 404 from the stack lookup with pr-number set does not blame pr-number', async () => {
  const { out, warnings, summary } = await runCaptured(
    tempDir(),
    unstackedEvent,
    { 'INPUT_BOTTOM-N': '2', 'INPUT_PR-NUMBER': '11' },
    async (url) => {
      if (url.endsWith('/pulls/11')) {
        return jsonResponse({
          number: 11,
          base: { ref: 'feat/auth' },
          stack: { number: 50, position: 2, size: 3, base: { ref: 'main' } },
        })
      }
      return jsonResponse({ message: 'Not Found' }, 404)
    },
  )
  assert.equal(out['should-run'], 'true')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /stacks\/50 → 404/)
  assert.match(warnings[0], /The stack may have changed; re-run\./)
  assert.doesNotMatch(warnings[0], /Check pr-number/)
  assert.doesNotMatch(summary, /Check pr-number/)
})

test('an unreadable event file warns with the generic hint and an Error row', async () => {
  const dir = tempDir()
  const { out, warnings, summary } = await runCaptured(
    dir,
    unstackedEvent,
    { GITHUB_EVENT_PATH: path.join(dir, 'missing.json') },
    async () => {
      throw new Error('no fetch')
    },
  )
  assert.equal(out['should-run'], 'true')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ENOENT/)
  assert.match(warnings[0], /Re-run the job\. If it repeats, open an issue on raulgg\/stack-ci-gate\.$/)
  assert.doesNotMatch(warnings[0], /usually temporary/)
  assert.match(summary, /\| Error \| ENOENT/)
  assert.doesNotMatch(summary, /Stack lookup/)
})

test('a non-JSON event file warns with the generic hint', async () => {
  const dir = tempDir()
  const eventPath = path.join(dir, 'bad.json')
  fs.writeFileSync(eventPath, '{not json')
  const { out, warnings, summary } = await runCaptured(
    dir,
    unstackedEvent,
    { GITHUB_EVENT_PATH: eventPath },
    async () => {
      throw new Error('no fetch')
    },
  )
  assert.equal(out['should-run'], 'true')
  assert.match(warnings[0], /Re-run the job\. If it repeats, open an issue/)
  assert.doesNotMatch(warnings[0], /usually temporary/)
  assert.match(summary, /\| Error \| /)
})

test('a 200 with a non-JSON body from the pull lookup warns with the generic hint', async () => {
  const { out, warnings, summary } = await runCaptured(
    tempDir(),
    unstackedEvent,
    {},
    async () => nonJsonResponse(),
  )
  assert.equal(out['should-run'], 'true')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /not valid JSON/)
  assert.match(warnings[0], /Re-run the job\. If it repeats, open an issue/)
  assert.doesNotMatch(warnings[0], /usually temporary/)
  assert.match(summary, /\| Stack lookup \| /)
})

test('an output write failure with a degraded result exits 1 and still warns', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, unstackedEvent)
  const env = outputDirEnv(dir, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event })
  const { lines, log } = capture()
  const { exitCode, result } = await run(env, {
    log,
    sleep: async () => {},
    fetch: async () => jsonResponse({ message: 'nope' }, 502),
  })
  assert.equal(exitCode, 1)
  assert.equal(result.should_run, true)
  assert.equal(result.degraded, true)
  assert.equal(lines.error.length, 1)
  assert.match(lines.error[0], OUTPUT_ERROR)
  assert.equal(lines.warn.length, 1)
  assert.match(lines.warn[0], ANNOTATION)
  assert.match(readSummary(env), /## Action needed/)
})

test('pull_request_target skips mid-stack quietly and warns when it cannot decide', async () => {
  const skipped = await runCaptured(
    tempDir(),
    midStackEvent({ number: 12 }),
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    async () => {
      throw new Error('no fetch')
    },
  )
  assert.equal(skipped.out['should-run'], 'false')
  assert.deepEqual(skipped.warnings, [])
  assert.match(skipped.summary, /\| Event \| pull_request_target synchronize \|/)

  const degraded = await runCaptured(
    tempDir(),
    unstackedEvent,
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    async () => jsonResponse({ message: 'nope' }, 403),
  )
  assert.equal(degraded.out['should-run'], 'true')
  assert.equal(degraded.warnings.length, 1)
  assert.match(degraded.warnings[0], /pull-requests: read/)
  assert.match(degraded.summary, /## Action needed/)
})

function openedEvent(dir, { baseRef, defaultBranch = 'main', extra = {} }) {
  return writeEvent(dir, {
    action: 'opened',
    repository: { default_branch: defaultBranch },
    pull_request: { number: 42, base: { ref: baseRef }, stack: null },
    ...extra,
  })
}

const WAIT_LINE = /Waited .* for a stack and found none/

/** A fake clock: sleep advances now. */
function gateClock() {
  const state = { t: 1_000_000, sleeps: [] }
  state.now = () => state.t
  state.sleep = async (ms) => {
    state.sleeps.push(ms)
    state.t += ms
  }
  return state
}

test('opened into the default branch fetches once without waiting', async () => {
  const dir = tempDir()
  const env = baseEnv(dir, {
    ...summaryEnv(dir),
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: openedEvent(dir, { baseRef: 'main' }),
  })
  const out = capture()
  let calls = 0
  const { result } = await run(env, {
    log: out.log,
    sleep: async () => {
      throw new Error('should not sleep')
    },
    fetch: async () => {
      calls += 1
      return jsonResponse({ number: 42, base: { ref: 'main' }, stack: null })
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.should_run, true)
  assert.equal(result.degraded, undefined)
  const trace = out.lines.log.find((line) => line.includes('gate-trace'))
  assert.match(trace, / waited_ms=0$/)
  assert.ok(!out.lines.log.some((line) => WAIT_LINE.test(line)))
  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')
  assert.doesNotMatch(summary, /Waited for stack/)
})

test('opened into another base waits for the stack and skips mid-stack', async () => {
  const dir = tempDir()
  const env = baseEnv(dir, {
    ...summaryEnv(dir),
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: openedEvent(dir, { baseRef: 'feat/auth' }),
  })
  const out = capture()
  let pullCalls = 0
  const clock = gateClock()
  const { result } = await run(env, {
    log: out.log,
    sleep: clock.sleep,
    now: clock.now,
    fetch: async (url) => {
      if (String(url).includes('/stacks/')) {
        return jsonResponse({
          pull_requests: [
            { number: 41, state: 'open' },
            { number: 42, state: 'open' },
            { number: 43, state: 'open' },
          ],
        })
      }
      pullCalls += 1
      return jsonResponse({
        number: 42,
        base: { ref: 'feat/auth' },
        stack:
          pullCalls >= 6
            ? { number: 50, position: 2, size: 3, base: { ref: 'main' } }
            : null,
      })
    },
  })
  assert.equal(result.should_run, false)
  assert.deepEqual(clock.sleeps, [1000, 2000, 3000, 5000, 5000])
  const trace = out.lines.log.find((line) => line.includes('gate-trace'))
  assert.match(trace, /waited_ms=16000/)
  assert.ok(!out.lines.log.some((line) => WAIT_LINE.test(line)))
  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')
  assert.match(summary, /\| Waited for stack \| 16 s \|/)
})

test('a long wait that ends without a stack logs one plain line and is not degraded', async () => {
  const dir = tempDir()
  const env = baseEnv(dir, {
    ...summaryEnv(dir),
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: openedEvent(dir, { baseRef: 'release/2' }),
  })
  const out = capture()
  const clock = gateClock()
  const { result } = await run(env, {
    log: out.log,
    sleep: clock.sleep,
    now: clock.now,
    fetch: async () =>
      jsonResponse({ number: 42, base: { ref: 'release/2' }, stack: null }),
  })
  assert.equal(result.should_run, true)
  assert.equal(result.degraded, undefined)
  assert.equal(result.reason, 'not in a stack; running CI')
  const waitLines = out.lines.log.filter((line) => WAIT_LINE.test(line))
  assert.equal(waitLines.length, 1)
  assert.match(waitLines[0], /Waited 40 s/)
  assert.match(waitLines[0], /stack-wait-seconds/)
  assert.ok(!waitLines[0].startsWith('::'))
  assert.deepEqual(out.lines.warn, [])
  assert.deepEqual(out.lines.error, [])
  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')
  assert.match(summary, /\| Waited for stack \| 40 s \|/)
  assert.doesNotMatch(summary, /Action needed|Stack lookup/)
})

test('a short wait that runs out stays quiet', async () => {
  const dir = tempDir()
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: openedEvent(dir, { baseRef: 'feat/auth' }),
    'INPUT_STACK-WAIT-SECONDS': '6',
  })
  const out = capture()
  let calls = 0
  const { result } = await run(env, {
    log: out.log,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      return jsonResponse({ number: 42, base: { ref: 'feat/auth' }, stack: null })
    },
  })
  assert.equal(calls, 4)
  assert.equal(result.should_run, true)
  assert.equal(result.degraded, undefined)
  assert.ok(!out.lines.log.some((line) => WAIT_LINE.test(line)))
  assert.deepEqual(out.lines.warn, [])
  assert.deepEqual(out.lines.error, [])
})

test('stack-wait-seconds 0 fetches once', async () => {
  const dir = tempDir()
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: openedEvent(dir, { baseRef: 'feat/auth' }),
    'INPUT_STACK-WAIT-SECONDS': '0',
  })
  const out = capture()
  let calls = 0
  await run(env, {
    log: out.log,
    sleep: async () => {
      throw new Error('should not sleep')
    },
    fetch: async () => {
      calls += 1
      return jsonResponse({ number: 42, base: { ref: 'feat/auth' }, stack: null })
    },
  })
  assert.equal(calls, 1)
  assert.ok(!out.lines.log.some((line) => WAIT_LINE.test(line)))
})

test('blank stack-wait-seconds uses 40', async () => {
  const dir = tempDir()
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: openedEvent(dir, { baseRef: 'feat/auth' }),
    'INPUT_STACK-WAIT-SECONDS': ' ',
  })
  let slept = 0
  await run(env, {
    log: silent,
    sleep: async (ms) => {
      slept += ms
    },
    fetch: async () =>
      jsonResponse({ number: 42, base: { ref: 'feat/auth' }, stack: null }),
  })
  assert.equal(slept, 40_000)
})

test('invalid stack-wait-seconds fail-opens with an error annotation', async () => {
  const dir = tempDir()
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: openedEvent(dir, { baseRef: 'feat/auth' }),
    'INPUT_STACK-WAIT-SECONDS': '301',
    ...summaryEnv(dir),
  })
  const out = capture()
  const { exitCode, result, error } = await run(env, {
    log: out.log,
    fetch: async () => {
      throw new Error('should not fetch')
    },
  })
  assert.equal(exitCode, 0)
  assert.equal(result.should_run, true)
  assert.equal(result.degraded, true)
  assert.match(result.reason, /^invalid input; running CI/)
  assert.ok(error)
  assert.equal(parseOutputs(env.GITHUB_OUTPUT)['should-run'], 'true')
  assert.equal(out.lines.error.length, 1)
  assert.match(out.lines.error[0], /^::error title=Stack CI Gate::stack-wait-seconds/)
  assert.deepEqual(out.lines.warn, [])
  const summary = readSummary(env)
  assert.match(summary, /\| Stack source \| invalid-input \|/)
  assert.match(summary, /## Action needed\n\nCI ran because the gate could not decide\. Check the input values on the gate step\./)
  assert.doesNotMatch(summary, /Waited for stack/)
})

test('gate-trace lists change keys and never their values', async () => {
  const dir = tempDir()
  const event = writeEvent(dir, {
    action: 'edited',
    repository: { default_branch: 'main' },
    changes: {
      title: { from: 'secret-title-value' },
      base: { ref: { from: 'feat/old' }, sha: { from: 'deadbeef' } },
      'Bad-Key': { from: 'x' },
      'x::warning': { from: 'y' },
    },
    pull_request: {
      number: 12,
      base: { ref: 'feat/auth' },
      stack: { number: 50, position: 2, size: 3, base: { ref: 'main' } },
    },
  })
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
  })
  const out = capture()
  await run(env, {
    log: out.log,
    fetch: async () =>
      jsonResponse({
        pull_requests: [
          { number: 11, state: 'open' },
          { number: 12, state: 'open' },
          { number: 13, state: 'open' },
        ],
      }),
  })
  const trace = out.lines.log.find((line) => line.includes('gate-trace'))
  assert.match(trace, / changes=base,title /)
  assert.match(trace, / waited_ms=0$/)
  assert.doesNotMatch(trace, /secret-title-value|feat\/old|deadbeef|Bad-Key|warning/)
})

function openedRun(dir, { baseRef, defaultBranch = 'main', envExtra = {}, extra = {}, fetch }) {
  const env = baseEnv(dir, {
    ...summaryEnv(dir),
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: openedEvent(dir, { baseRef, defaultBranch, extra }),
    ...envExtra,
  })
  const out = capture()
  const clock = gateClock()
  return run(env, { log: out.log, sleep: clock.sleep, now: clock.now, fetch }).then((res) => ({
    ...res,
    env,
    clock,
    lines: out.lines,
    trace: out.lines.log.find((line) => line.includes('gate-trace')),
    summary: fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'),
  }))
}

function pullBody(base, stack = null) {
  return jsonResponse({ number: 42, base: { ref: base }, stack })
}

test('opened into the default branch waits for the stack with bottom-n 0', async () => {
  let calls = 0
  const { result, clock } = await openedRun(tempDir(), {
    baseRef: 'main',
    envExtra: { 'INPUT_BOTTOM-N': '0', 'INPUT_RUN-TOP': 'true' },
    fetch: async () => {
      calls += 1
      return pullBody('main', calls >= 3 ? { number: 50, position: 1, size: 3, base: { ref: 'main' } } : null)
    },
  })
  assert.equal(calls, 3)
  assert.deepEqual(clock.sleeps, [1000, 2000])
  assert.equal(result.should_run, false)
})

for (const [base, calls] of [
  ['develop', 1],
  ['main', 11],
]) {
  test(`default branch develop: opened into ${base} fetches ${calls} time(s)`, async () => {
    let fetches = 0
    const { result, trace } = await openedRun(tempDir(), {
      baseRef: base,
      defaultBranch: 'develop',
      fetch: async () => {
        fetches += 1
        return pullBody(base)
      },
    })
    assert.equal(fetches, calls)
    assert.equal(result.should_run, true)
    assert.match(trace, base === 'develop' ? / waited_ms=0$/ : / waited_ms=40000$/)
  })
}

test('a pr-number override on opened stops once the fetched PR targets the default branch', async () => {
  const urls = []
  const { result } = await openedRun(tempDir(), {
    baseRef: 'feat/other',
    envExtra: { 'INPUT_PR-NUMBER': '7' },
    fetch: async (url) => {
      urls.push(url)
      return jsonResponse({
        number: 7,
        base: { ref: 'main', repo: { default_branch: 'main' } },
        stack: null,
      })
    },
  })
  assert.equal(urls.length, 1)
  assert.match(urls[0], /\/pulls\/7$/)
  assert.equal(result.should_run, true)
})

test('a 502 mid-wait keeps polling and the PR still skips mid-stack', async () => {
  let calls = 0
  const { result, lines, trace } = await openedRun(tempDir(), {
    baseRef: 'feat/auth',
    fetch: async () => {
      calls += 1
      if (calls === 2) return jsonResponse({ message: 'bad gateway' }, 502)
      return pullBody(
        'feat/auth',
        calls >= 4 ? { number: 50, position: 2, size: 3, base: { ref: 'main' } } : null,
      )
    },
  })
  assert.equal(calls, 4)
  assert.equal(result.should_run, false)
  assert.deepEqual(lines.warn, [])
  assert.match(trace, / waited_ms=6000$/)
})

test('an error mid-wait keeps the action and the real wait in gate-trace and the summary', async () => {
  let calls = 0
  const { result, lines, trace, summary } = await openedRun(tempDir(), {
    baseRef: 'feat/auth',
    fetch: async () => {
      calls += 1
      if (calls === 3) return jsonResponse({ message: 'nope' }, 403)
      return pullBody('feat/auth')
    },
  })
  assert.equal(calls, 3)
  assert.equal(result.should_run, true)
  assert.equal(result.degraded, true)
  assert.equal(lines.warn.length, 1)
  assert.match(trace, /^gate-trace event=pull_request action=opened source=error /)
  assert.match(trace, / waited_ms=3000$/)
  assert.match(summary, /\| Waited for stack \| 3 s \|/)
  assert.match(summary, /\| Event \| pull_request opened \|/)
})

test('a timeout on the last poll fails open with the full wait', async () => {
  const { result, trace } = await openedRun(tempDir(), {
    baseRef: 'feat/auth',
    envExtra: { 'INPUT_STACK-WAIT-SECONDS': '6' },
    fetch: async () => {
      throw new Error('The operation was aborted due to timeout')
    },
  })
  assert.equal(result.should_run, true)
  assert.equal(result.degraded, true)
  assert.match(trace, / waited_ms=6000$/)
})
