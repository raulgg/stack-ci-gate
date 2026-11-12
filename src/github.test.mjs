import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GITHUB_API_VERSION,
  remainingDepthFromStackPulls,
  resolveContext,
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

test('event stack returns label names and does not fetch', async () => {
  let fetches = 0
  const resolved = await resolvePull({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    eventLabels: [{ name: 'stack-ci:run' }, { color: 'red' }, null],
    prNumberOverride: '',
    repo: 'octo/hello',
    token: 't',
    fetchImpl: async () => {
      fetches += 1
      throw new Error('should not fetch')
    },
  })
  assert.equal(fetches, 0)
  assert.deepEqual(resolved.labels, ['stack-ci:run'])
  assert.equal(resolved.source, 'event')
})

test('event stack with no labels array returns no names and does not fetch', async () => {
  let fetches = 0
  const resolved = await resolvePull({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    token: 't',
    fetchImpl: async () => {
      fetches += 1
      throw new Error('should not fetch')
    },
  })
  assert.equal(fetches, 0)
  assert.deepEqual(resolved.labels, [])
})

test('opened retry uses labels from the response that includes the stack', async () => {
  let calls = 0
  const resolved = await resolvePull({
    eventAction: 'opened',
    eventStack: null,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    eventLabels: [{ name: 'from-event' }],
    repo: 'octo/hello',
    token: 't',
    retryDelaysMs: [0, 10, 20],
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1
      if (calls < 3) {
        return jsonResponse({
          number: 42,
          base: { ref: 'feat/auth' },
          stack: null,
          labels: [{ name: 'bug' }],
        })
      }
      return jsonResponse({
        number: 42,
        base: { ref: 'feat/auth' },
        stack: middleStack,
        labels: [{ name: 'stack-ci:run' }],
      })
    },
  })
  assert.equal(calls, 3)
  assert.deepEqual(resolved.labels, ['stack-ci:run'])
  assert.equal(resolved.stack.position, 2)
})

test('pr_number override returns API labels, not event labels', async () => {
  const resolved = await resolvePull({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 10,
    eventPrBaseRef: 'main',
    eventLabels: [{ name: 'stack-ci:run' }],
    prNumberOverride: '11',
    repo: 'octo/hello',
    token: 't',
    fetchImpl: async (url) => {
      assert.match(url, /\/pulls\/11$/)
      return jsonResponse({
        number: 11,
        base: { ref: 'feat/auth' },
        stack: middleStack,
        labels: [{ name: 'bug' }],
      })
    },
  })
  assert.deepEqual(resolved.labels, ['bug'])
  assert.equal(resolved.prNumber, 11)
  assert.equal(resolved.source, 'api')
})

test('resolveContext fetches remaining depth for a stacked pull request', async () => {
  const calls = []
  let init
  const resolved = await resolveContext({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 12,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    bottomN: 2,
    token: 't',
    fetchImpl: async (url, options) => {
      calls.push(url)
      init = options
      assert.match(url, /\/repos\/octo\/hello\/stacks\/50$/)
      return jsonResponse({
        number: 50,
        pull_requests: [
          { number: 10, state: 'closed' },
          { number: 11, state: 'open' },
          { number: 12, state: 'open' },
          { number: 13, state: 'open' },
        ],
      })
    },
  })
  assert.deepEqual(
    calls.map((url) => url.replace(/.*\/repos\/octo\/hello/, '')),
    ['/stacks/50'],
  )
  assert.equal(init.redirect, 'error')
  assert.equal(init.headers['X-GitHub-Api-Version'], GITHUB_API_VERSION)
  assert.equal(resolved.remainingDepth, 2)
  assert.equal(resolved.prNumber, 12)
  assert.equal(resolved.source, 'event')
})

test('resolveContext leaves remaining depth unknown when the stacks GET fails', async () => {
  const resolved = await resolveContext({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    bottomN: 2,
    token: 't',
    fetchImpl: async () => jsonResponse({ message: 'boom' }, 404),
  })
  assert.equal(resolved.remainingDepth, null)
  assert.equal(resolved.stack.position, 2)
  assert.equal(resolved.lookupProblem.status, 404)
  assert.match(resolved.lookupProblem.message, /stacks\/50 → 404/)
  assert.doesNotMatch(resolved.lookupProblem.message, /boom/)
})

test('resolveContext reports a thrown stack lookup without a status', async () => {
  const fetchImpl = async (url) => {
    throw new Error(`timed out ${url}`)
  }
  const resolved = await resolveContext({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    bottomN: 2,
    token: 't',
    fetchImpl,
  })
  assert.equal(resolved.lookupProblem.status, undefined)
  assert.match(resolved.lookupProblem.message, /timed out/)
})

test('resolveContext has no lookup problem when the stacks GET succeeds', async () => {
  const resolved = await resolveContext({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    bottomN: 2,
    token: 't',
    fetchImpl: async () =>
      jsonResponse({ pull_requests: [{ number: 42, state: 'open' }] }),
  })
  assert.equal(resolved.lookupProblem, null)
})

test('resolveContext reports a missing token with no event stack', async () => {
  const resolved = await resolveContext({
    eventAction: 'synchronize',
    eventStack: null,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    bottomN: 2,
    token: '',
  })
  assert.equal(resolved.source, 'no-token')
  assert.equal(resolved.lookupProblem.kind, 'no-token')
  assert.equal(resolved.lookupProblem.quiet, true)
})

test('resolveContext reports a non-numeric pr-number without fetching', async () => {
  const resolved = await resolveContext({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    prNumberOverride: 'abc',
    repo: 'octo/hello',
    bottomN: 2,
    token: 't',
    fetchImpl: async () => {
      throw new Error('no fetch')
    },
  })
  assert.equal(resolved.source, 'invalid-pr-number')
  assert.equal(resolved.stack, null)
  assert.equal(resolved.lookupProblem.kind, 'invalid-pr-number')
})

for (const value of ['-3', '0', '1.5', '0x10', '1e3', '012', '+4', '12abc']) {
  test(`pr-number ${JSON.stringify(value)} is invalid and does not fetch`, async () => {
    const resolved = await resolveContext({
      eventAction: 'synchronize',
      eventStack: middleStack,
      eventPrNumber: 42,
      eventPrBaseRef: 'feat/auth',
      prNumberOverride: value,
      repo: 'octo/hello',
      bottomN: 2,
      token: 't',
      fetchImpl: async () => {
        throw new Error('no fetch')
      },
    })
    assert.equal(resolved.source, 'invalid-pr-number')
    assert.equal(resolved.prNumber, null)
    assert.equal(resolved.lookupProblem.kind, 'invalid-pr-number')
  })
}

test('pr-number with surrounding whitespace is a valid override', async () => {
  const calls = []
  const resolved = await resolvePull({
    eventAction: 'synchronize',
    eventStack: null,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    prNumberOverride: ' 11 ',
    repo: 'octo/hello',
    token: 't',
    fetchImpl: async (url) => {
      calls.push(url)
      return jsonResponse({ number: 11, base: { ref: 'main' }, stack: null })
    },
  })
  assert.equal(resolved.prNumber, 11)
  assert.match(calls[0], /\/pulls\/11$/)
})

test('resolveContext does not fetch the stack listing without a token', async () => {
  let fetches = 0
  const resolved = await resolveContext({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    bottomN: 2,
    token: '',
    fetchImpl: async () => {
      fetches += 1
      throw new Error('no fetch')
    },
  })
  assert.equal(fetches, 0)
  assert.equal(resolved.remainingDepth, null)
  assert.equal(resolved.source, 'event')
  assert.equal(resolved.lookupProblem.kind, 'no-token')
  assert.equal(resolved.lookupProblem.quiet, undefined)
})

test('resolveContext skips the stack listing when bottom-n is 1', async () => {
  let fetches = 0
  const resolved = await resolveContext({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    bottomN: 1,
    token: 't',
    fetchImpl: async () => {
      fetches += 1
      throw new Error('no fetch')
    },
  })
  assert.equal(fetches, 0)
  assert.equal(resolved.remainingDepth, null)
  assert.equal(resolved.lookupProblem, null)
})

test('resolveContext does not report a missing token when bottom-n is 1', async () => {
  const resolved = await resolveContext({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    bottomN: 1,
    token: '',
  })
  assert.equal(resolved.source, 'event')
  assert.equal(resolved.lookupProblem, null)
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
