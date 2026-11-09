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
  assert.match(summary, /\| Remaining bottom \| no \|/)
  assert.match(summary, /\| Top \| no \|/)
  assert.match(summary, /\| Position \| 2 \|/)
  assert.match(summary, /\| Size \| 3 \|/)
  assert.match(summary, /\| Event \| pull_request synchronize \|/)
  assert.match(summary, /\| Stack source \| event \|/)
  const fields = ['Decision', 'Reason', 'Stacked', 'Remaining bottom', 'Top', 'Position', 'Size', 'Event', 'Stack source']
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
  assert.match(summary, /\| Remaining bottom \| yes \|/)
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

test('an output write failure does not change should-run', async () => {
  const dir = tempDir()
  const outputDir = path.join(dir, 'output-dir')
  fs.mkdirSync(outputDir)
  const warnings = []
  const event = writeEvent(dir, midStackEvent({ number: 12 }))
  const env = baseEnv(dir, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
    GITHUB_OUTPUT: outputDir,
    ...summaryEnv(dir),
  })
  const { exitCode, result } = await run(env, {
    log: { log() {}, error() {}, warn(msg) { warnings.push(String(msg)) } },
    fetch: noFetch().fetch,
  })
  assert.equal(exitCode, 0)
  assert.equal(result.should_run, false)
  assert.match(readSummary(env), /\| Decision \| Skip gated jobs \|/)
  assert.match(warnings.join('\n'), /Could not write gate outputs/)
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
  assert.match(summary, /force-run label bad: :name# \[x\/y/)
  assert.doesNotMatch(summary, /::/)
  assert.doesNotMatch(summary, /##\[/)
})

test('error summary omits the API response body', async () => {
  const dir = tempDir()
  const { result, env } = await runPull(
    dir,
    { action: 'synchronize', pull_request: { number: 42, base: { ref: 'feat/auth' }, stack: null } },
    summaryEnv(dir),
    async () => jsonResponse({ message: '::error::pwned ##[warning]x' }, 502),
  )
  const summary = readSummary(env)
  assert.equal(result.should_run, true)
  assert.match(summary, /\| Stack source \| error \|/)
  assert.doesNotMatch(summary, /pwned/)
  assert.doesNotMatch(summary, /::/)
  assert.doesNotMatch(summary, /##\[/)
})
