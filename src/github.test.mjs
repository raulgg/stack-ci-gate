import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GITHUB_API_VERSION,
  remainingDepthFromStackPulls,
  resolvePull,
} from './github.mjs'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

const middleStack = {
  number: 50,
  position: 2,
  size: 3,
  base: { ref: 'main', sha: 'abc' },
}

test('remaining depth counts unmerged PRs from the bottom of the list', () => {
  const pulls = [
    { number: 10, state: 'closed', merged_at: '2026-01-01T00:00:00Z' },
    { number: 11, state: 'open' },
    { number: 12, state: 'open' },
    { number: 13, state: 'open' },
  ]
  assert.equal(remainingDepthFromStackPulls(pulls, 11), 1)
  assert.equal(remainingDepthFromStackPulls(pulls, 12), 2)
  assert.equal(remainingDepthFromStackPulls(pulls, 13), 3)
  assert.equal(remainingDepthFromStackPulls(pulls, 10), null)
  assert.equal(remainingDepthFromStackPulls(null, 11), null)
})

test('event stack is used when pr_number is not overridden', async () => {
  let fetches = 0
  const resolved = await resolvePull({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    prNumberOverride: '',
    repo: 'octo/hello',
    token: 't',
    fetchImpl: async () => {
      fetches += 1
      throw new Error('should not fetch')
    },
  })
  assert.equal(resolved.source, 'event')
  assert.equal(resolved.stack.position, 2)
  assert.equal(fetches, 0)
})

test('opened with no event stack uses API stack (middle → caller will skip)', async () => {
  const resolved = await resolvePull({
    eventAction: 'opened',
    eventStack: null,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    prNumberOverride: '',
    repo: 'octo/hello',
    token: 't',
    retryDelaysMs: [0],
    fetchImpl: async () =>
      jsonResponse({
        number: 42,
        base: { ref: 'feat/auth' },
        stack: middleStack,
      }),
  })
  assert.equal(resolved.source, 'api')
  assert.equal(resolved.stack.position, 2)
  assert.equal(resolved.prBaseRef, 'feat/auth')
})

test('opened retries until stack appears', async () => {
  let calls = 0
  const sleeps = []
  const resolved = await resolvePull({
    eventAction: 'opened',
    eventStack: null,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    token: 't',
    retryDelaysMs: [0, 10, 20],
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetchImpl: async () => {
      calls += 1
      if (calls < 3) {
        return jsonResponse({
          number: 42,
          base: { ref: 'feat/auth' },
          stack: null,
        })
      }
      return jsonResponse({
        number: 42,
        base: { ref: 'feat/auth' },
        stack: middleStack,
      })
    },
  })
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [10, 20])
  assert.equal(resolved.stack.position, 2)
})

test('opened still empty after retries → standalone', async () => {
  const resolved = await resolvePull({
    eventAction: 'opened',
    eventStack: null,
    eventPrNumber: 42,
    eventPrBaseRef: 'main',
    repo: 'octo/hello',
    token: 't',
    retryDelaysMs: [0, 1],
    sleep: async () => {},
    fetchImpl: async () =>
      jsonResponse({
        number: 42,
        base: { ref: 'main' },
        stack: null,
      }),
  })
  assert.equal(resolved.stack, null)
  assert.equal(resolved.source, 'api')
})

test('synchronize without event stack fetches once, no retry', async () => {
  let calls = 0
  await resolvePull({
    eventAction: 'synchronize',
    eventStack: null,
    eventPrNumber: 7,
    eventPrBaseRef: 'main',
    repo: 'octo/hello',
    token: 't',
    retryDelaysMs: [0, 1000, 2000],
    sleep: async () => {
      throw new Error('should not sleep')
    },
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({ number: 7, base: { ref: 'main' }, stack: null })
    },
  })
  assert.equal(calls, 1)
})

test('pr_number override ignores the triggering event stack', async () => {
  const eventStack = {
    number: 50,
    position: 1,
    size: 3,
    base: { ref: 'main' },
  }
  const overrideStack = {
    number: 50,
    position: 2,
    size: 3,
    base: { ref: 'main' },
  }
  const resolved = await resolvePull({
    eventAction: 'synchronize',
    eventStack,
    eventPrNumber: 10,
    eventPrBaseRef: 'main',
    prNumberOverride: '11',
    repo: 'octo/hello',
    token: 't',
    fetchImpl: async (url) => {
      assert.match(url, /\/pulls\/11$/)
      return jsonResponse({
        number: 11,
        base: { ref: 'feat/auth' },
        stack: overrideStack,
      })
    },
  })
  assert.equal(resolved.prNumber, 11)
  assert.equal(resolved.prBaseRef, 'feat/auth')
  assert.equal(resolved.stack.position, 2)
  assert.equal(resolved.source, 'api')
})

test('GET sends API version and abort signal', async () => {
  let init
  await resolvePull({
    eventAction: 'synchronize',
    eventStack: null,
    eventPrNumber: 1,
    eventPrBaseRef: 'main',
    repo: 'octo/hello',
    token: 't',
    fetchImpl: async (_url, options) => {
      init = options
      return jsonResponse({ number: 1, base: { ref: 'main' }, stack: null })
    },
  })
  assert.equal(init.headers['X-GitHub-Api-Version'], GITHUB_API_VERSION)
  assert.equal(init.redirect, 'error')
  assert.ok(init.signal)
})

test('fetch abort becomes a thrown error', async () => {
  await assert.rejects(
    () =>
      resolvePull({
        eventAction: 'synchronize',
        eventStack: null,
        eventPrNumber: 1,
        eventPrBaseRef: 'main',
        repo: 'octo/hello',
        token: 't',
        timeoutMs: 5,
        fetchImpl: async (_url, { signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason))
          }),
      }),
  )
})

test('API failure propagates so the gate can fail open', async () => {
  await assert.rejects(
    () =>
      resolvePull({
        eventAction: 'synchronize',
        eventStack: null,
        eventPrNumber: 1,
        eventPrBaseRef: 'main',
        repo: 'octo/hello',
        token: 't',
        fetchImpl: async () => jsonResponse({ message: 'boom' }, 500),
      }),
    (err) => {
      assert.match(String(err.message), /500/)
      assert.doesNotMatch(String(err.message), /boom/)
      return true
    },
  )
})
