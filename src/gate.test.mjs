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

test('unknown depth fail-open keeps its reason when the force-run label is present', async () => {
  const dir = tempDir()
  const { result, out } = await runPull(
    dir,
    midStackEvent({
      labels: [{ name: 'stack-ci:run' }],
      number: 12,
      position: 2,
      size: 4,
    }),
    { 'INPUT_BOTTOM-N': '2' },
    async () => jsonResponse({ message: 'nope' }, 500),
  )
  assert.equal(result.should_run, true)
  assert.match(result.reason, /could not determine remaining stack depth/)
  assert.doesNotMatch(result.reason, /force-run/)
  assert.match(out.reason, /could not determine remaining stack depth/)
  assert.doesNotMatch(out.reason, /force-run/)
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
  const { exitCode, result } = await run(env, {
    log: {
      log(msg) {
        logs.push(String(msg))
      },
      error() {},
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
    const { out, warnings, logs, summary } = await runCaptured(
      tempDir(),
      payload,
      { 'INPUT_BOTTOM-N': '2' },
      async () => jsonResponse({ message: 'nope' }, 403),
    )
    assert.equal(out['should-run'], 'true')
    assert.deepEqual(warnings, [])
    assert.match(logs.join('\n'), /Stack lookup failed.*→ 403/)
    assert.match(summary, /\| Stack lookup \| GET .*→ 403 \|/)
    assert.doesNotMatch(summary, /Action needed/)
  })
}

test('no token and no event stack warns instead of reporting a standalone PR', async () => {
  const { out, warnings, summary } = await runCaptured(
    tempDir(),
    unstackedEvent,
    { 'INPUT_GITHUB-TOKEN': '' },
    async () => {
      throw new Error('no fetch')
    },
  )
  assert.equal(out['should-run'], 'true')
  assert.doesNotMatch(out.reason, /not in a stack/)
  assert.match(out.reason, /no token/)
  assert.match(warnings[0], ANNOTATION)
  assert.match(warnings[0], /github-token/)
  assert.match(summary, /## Action needed/)
})

test('no token with bottom-n=2 names the token as the cause', async () => {
  const { out, warnings } = await runCaptured(
    tempDir(),
    midStackEvent(),
    { 'INPUT_BOTTOM-N': '2', 'INPUT_GITHUB-TOKEN': '' },
    async () => {
      throw new Error('no fetch')
    },
  )
  assert.equal(out['should-run'], 'true')
  assert.match(out.reason, /could not determine remaining stack depth.*no token/)
  assert.match(warnings[0], /github-token/)
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

test('a stack listing without this PR warns with bottom-n=2', async () => {
  const { out, warnings } = await runCaptured(
    tempDir(),
    midStackEvent(),
    { 'INPUT_BOTTOM-N': '2' },
    async () => jsonResponse({ number: 50, pull_requests: openPulls(10, 13) }),
  )
  assert.equal(out['should-run'], 'true')
  assert.equal(out.reason, 'could not determine remaining stack depth; running CI')
  assert.match(warnings[0], ANNOTATION)
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
  assert.doesNotMatch(skipped.summary, /Action needed|Stack lookup/)
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
