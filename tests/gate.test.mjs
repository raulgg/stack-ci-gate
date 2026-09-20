import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { run } from '../src/gate.mjs'

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
