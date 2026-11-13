import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GITHUB_API_VERSION,
  remainingDepthFromStackPulls,
  resolveContext as resolveContextRaw,
  FETCH_TIMEOUT_MS,
  MIN_WAIT_FETCH_TIMEOUT_MS,
  resolvePull as resolvePullRaw,
  stackWaitDelays,
  waitFetchTimeoutMs,
} from './github.mjs'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

/** Answers the base-head lookup (a PR below exists by default), so tests count only pull fetches. */
function withBaseHead(fetchImpl, list = [{ number: 41 }]) {
  return async (url, init) =>
    String(url).includes('/pulls?') ? jsonResponse(list) : fetchImpl(url, init)
}

// Most tests are about the pull fetch; the base-head lookup has its own tests with resolvePullRaw.
const resolvePull = (opts) =>
  resolvePullRaw({ ...opts, fetchImpl: opts.fetchImpl && withBaseHead(opts.fetchImpl) })
const resolveContext = (opts) =>
  resolveContextRaw({ ...opts, fetchImpl: opts.fetchImpl && withBaseHead(opts.fetchImpl) })

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
  const clock = fakeClock()
  const resolved = await resolvePull({
    eventAction: 'opened',
    eventStack: null,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    token: 't',
    retryDelaysMs: [0, 10, 20],
    sleep: clock.sleep,
    now: clock.now,
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
  assert.deepEqual(clock.sleeps, [10, 20])
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
  assert.equal(resolved.lookupProblem.lookup, 'stack')
  assert.equal(resolved.lookupProblem.network, false)
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
  assert.equal(resolved.lookupProblem.network, true)
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

test('resolveContext reports a PR missing from the stack listing as its own cause', async () => {
  const resolved = await resolveContext({
    eventAction: 'synchronize',
    eventStack: middleStack,
    eventPrNumber: 42,
    eventPrBaseRef: 'feat/auth',
    repo: 'octo/hello',
    bottomN: 2,
    token: 't',
    fetchImpl: async () =>
      jsonResponse({ pull_requests: [{ number: 42, state: 'closed' }, { number: 43, state: 'open' }] }),
  })
  assert.equal(resolved.remainingDepth, null)
  assert.equal(resolved.lookupProblem.kind, 'not-in-stack')
})

test('a failed pull lookup is tagged as the pull lookup', async () => {
  await assert.rejects(
    resolvePull({
      eventAction: 'synchronize',
      eventStack: null,
      eventPrNumber: 42,
      repo: 'octo/hello',
      token: 't',
      fetchImpl: async () => jsonResponse({}, 502),
    }),
    (err) => err.status === 502 && err.lookup === 'pull' && err.network === undefined,
  )
  await assert.rejects(
    resolvePull({
      eventAction: 'synchronize',
      eventStack: null,
      eventPrNumber: 42,
      repo: 'octo/hello',
      token: 't',
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      },
    }),
    (err) => err.lookup === 'pull' && err.network === true,
  )
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

test('stack wait schedule is 0, 1, 2, 3 s, then every 5 s, last step shortened', () => {
  assert.deepEqual(
    stackWaitDelays(40_000),
    [0, 1000, 2000, 3000, 5000, 5000, 5000, 5000, 5000, 5000, 4000],
  )
  assert.equal(stackWaitDelays(40_000).reduce((a, b) => a + b, 0), 40_000)
  assert.deepEqual(stackWaitDelays(6000), [0, 1000, 2000, 3000])
  assert.deepEqual(stackWaitDelays(2000), [0, 1000, 1000])
  assert.deepEqual(stackWaitDelays(0), [0])
})

function countingPullFetch(stackOnCall, body = {}) {
  const state = { calls: 0 }
  state.fetchImpl = async () => {
    state.calls += 1
    return jsonResponse({
      number: 42,
      base: { ref: 'feat/auth' },
      stack: state.calls >= stackOnCall ? middleStack : null,
      ...body,
    })
  }
  return state
}

/** A fake clock: sleep advances now, and fetches can take time too. */
function fakeClock() {
  const state = { t: 1_000_000, sleeps: [] }
  state.now = () => state.t
  state.sleep = async (ms) => {
    state.sleeps.push(ms)
    state.t += ms
  }
  return state
}

const openedPull = {
  eventAction: 'opened',
  eventStack: null,
  eventPrNumber: 42,
  eventPrBaseRef: 'feat/auth',
  prNumberOverride: '',
  repo: 'octo/hello',
  token: 't',
  defaultBranch: 'main',
}

test('opened into the default branch fetches once and does not sleep', async () => {
  const pulls = countingPullFetch(Infinity, { base: { ref: 'main' } })
  const resolved = await resolvePull({
    ...openedPull,
    eventPrBaseRef: 'main',
    fetchImpl: pulls.fetchImpl,
    sleep: async () => {
      throw new Error('should not sleep')
    },
  })
  assert.equal(pulls.calls, 1)
  assert.equal(resolved.stack, null)
  assert.equal(resolved.waitedMs, 0)
  assert.equal(resolved.stackWaitTimedOut, false)
})

test('opened into the default branch still waits with bottom-n 0', async () => {
  const pulls = countingPullFetch(3, { base: { ref: 'main' } })
  const clock = fakeClock()
  const resolved = await resolvePull({
    ...openedPull,
    eventPrBaseRef: 'main',
    bottomN: 0,
    fetchImpl: pulls.fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(pulls.calls, 3)
  assert.deepEqual(clock.sleeps, [1000, 2000])
  assert.equal(resolved.stack.position, 2)
})

test('the default branch comes from the fetched PR when the payload lacks it', async () => {
  const pulls = countingPullFetch(Infinity, {
    base: { ref: 'develop', repo: { default_branch: 'develop' } },
  })
  const resolved = await resolvePull({
    ...openedPull,
    eventPrBaseRef: 'develop',
    defaultBranch: '',
    fetchImpl: pulls.fetchImpl,
    sleep: async () => {
      throw new Error('should not sleep')
    },
  })
  assert.equal(pulls.calls, 1)
  assert.equal(resolved.stackWaitTimedOut, false)
})

for (const [base, calls] of [
  ['develop', 1],
  ['main', 11],
]) {
  test(`with default branch develop, opened into ${base} fetches ${calls} time(s)`, async () => {
    const pulls = countingPullFetch(Infinity, {
      base: { ref: base, repo: { default_branch: 'develop' } },
    })
    const clock = fakeClock()
    const resolved = await resolvePull({
      ...openedPull,
      eventPrBaseRef: base,
      defaultBranch: 'develop',
      fetchImpl: pulls.fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    })
    assert.equal(pulls.calls, calls)
    assert.equal(resolved.stackWaitTimedOut, base === 'main')
  })
}

test('opened into another base waits until the stack appears', async () => {
  const pulls = countingPullFetch(7)
  const clock = fakeClock()
  const resolved = await resolvePull({
    ...openedPull,
    fetchImpl: pulls.fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(pulls.calls, 7)
  assert.deepEqual(clock.sleeps, [1000, 2000, 3000, 5000, 5000, 5000])
  assert.equal(resolved.stack.position, 2)
  assert.equal(resolved.waitedMs, 21_000)
  assert.equal(resolved.stackWaitTimedOut, undefined)
})

test('opened into another base gives up after the full budget', async () => {
  const pulls = countingPullFetch(Infinity)
  const clock = fakeClock()
  const resolved = await resolvePull({
    ...openedPull,
    eventAction: 'reopened',
    fetchImpl: pulls.fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(pulls.calls, 11)
  assert.equal(clock.sleeps.reduce((a, b) => a + b, 0), 40_000)
  assert.equal(resolved.stack, null)
  assert.equal(resolved.waitedMs, 40_000)
  assert.equal(resolved.stackWaitTimedOut, true)
})

test('slow fetches shorten the next sleep so the wait stays within budget', async () => {
  const clock = fakeClock()
  let calls = 0
  const resolved = await resolvePull({
    ...openedPull,
    fetchImpl: async () => {
      calls += 1
      clock.t += 1500
      return jsonResponse({ number: 42, base: { ref: 'feat/auth' }, stack: null })
    },
    sleep: clock.sleep,
    now: clock.now,
  })
  const start = 1_000_000
  // Each sleep loses the 1.5 s the previous fetch took; the last fetch starts by the deadline.
  assert.deepEqual(clock.sleeps.slice(0, 4), [500, 1500, 3500, 3500])
  assert.equal(calls, 11)
  assert.equal(resolved.waitedMs, 40_000)
  // Without the shortening this would be 11 fetches of 1.5 s on top of 40 s of sleep.
  assert.equal(clock.t - start, 40_000 + 1500)
  assert.equal(resolved.stackWaitTimedOut, true)
})

test('a 502 mid-wait keeps polling and the stack still counts', async () => {
  const clock = fakeClock()
  let calls = 0
  const resolved = await resolvePull({
    ...openedPull,
    fetchImpl: async () => {
      calls += 1
      if (calls === 2) return jsonResponse({ message: 'bad gateway' }, 502)
      if (calls === 3) throw new Error('The operation was aborted due to timeout')
      return jsonResponse({
        number: 42,
        base: { ref: 'feat/auth' },
        stack: calls >= 4 ? middleStack : null,
      })
    },
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(calls, 4)
  assert.equal(resolved.stack.position, 2)
  assert.equal(resolved.waitedMs, 6000)
})

for (const status of [401, 403, 404]) {
  test(`a ${status} mid-wait throws at once with the time waited`, async () => {
    const clock = fakeClock()
    let calls = 0
    await assert.rejects(
      resolvePull({
        ...openedPull,
        fetchImpl: async () => {
          calls += 1
          if (calls === 3) return jsonResponse({}, status)
          return jsonResponse({ number: 42, base: { ref: 'feat/auth' }, stack: null })
        },
        sleep: clock.sleep,
        now: clock.now,
      }),
      (err) => err.status === status && err.lookup === 'pull' && err.waitedMs === 3000,
    )
    assert.equal(calls, 3)
  })
}

test('a 5xx on the last attempt throws with the full wait', async () => {
  const clock = fakeClock()
  let calls = 0
  await assert.rejects(
    resolvePull({
      ...openedPull,
      stackWaitMs: 6000,
      fetchImpl: async () => {
        calls += 1
        return jsonResponse({}, 503)
      },
      sleep: clock.sleep,
      now: clock.now,
    }),
    (err) => err.status === 503 && err.waitedMs === 6000,
  )
  assert.equal(calls, 4)
})

test('a 5xx without a wait throws at once', async () => {
  let calls = 0
  await assert.rejects(
    resolvePull({
      ...openedPull,
      eventAction: 'synchronize',
      fetchImpl: async () => {
        calls += 1
        return jsonResponse({}, 502)
      },
    }),
    (err) => err.status === 502 && err.waitedMs === 0,
  )
  assert.equal(calls, 1)
})

test('unknown default branch still waits for the stack', async () => {
  const pulls = countingPullFetch(2, { base: { ref: 'main' } })
  const clock = fakeClock()
  const resolved = await resolvePull({
    ...openedPull,
    eventPrBaseRef: 'main',
    defaultBranch: '',
    fetchImpl: pulls.fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(pulls.calls, 2)
  assert.equal(resolved.waitedMs, 1000)
})

test('stack wait of 0 fetches once', async () => {
  const pulls = countingPullFetch(Infinity)
  const resolved = await resolvePull({
    ...openedPull,
    stackWaitMs: 0,
    fetchImpl: pulls.fetchImpl,
    sleep: async () => {
      throw new Error('should not sleep')
    },
  })
  assert.equal(pulls.calls, 1)
  assert.equal(resolved.waitedMs, 0)
  assert.equal(resolved.stackWaitTimedOut, false)
})

test('a 6 s wait that runs out is not a long wait', async () => {
  const pulls = countingPullFetch(Infinity)
  const clock = fakeClock()
  const resolved = await resolvePull({
    ...openedPull,
    stackWaitMs: 6000,
    fetchImpl: pulls.fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(pulls.calls, 4)
  assert.equal(resolved.waitedMs, 6000)
  assert.equal(resolved.stackWaitTimedOut, false)
})

test('a pr-number override into the default branch stops after the first fetch', async () => {
  const pulls = countingPullFetch(3, { base: { ref: 'main' } })
  const resolved = await resolvePull({
    ...openedPull,
    eventPrNumber: 7,
    eventPrBaseRef: 'feat/other',
    prNumberOverride: '42',
    fetchImpl: pulls.fetchImpl,
    sleep: async () => {
      throw new Error('should not sleep')
    },
  })
  assert.equal(pulls.calls, 1)
  assert.equal(resolved.stack, null)
})

test('a pr-number override into another base waits for the stack', async () => {
  const pulls = countingPullFetch(3)
  const clock = fakeClock()
  const resolved = await resolvePull({
    ...openedPull,
    eventPrNumber: 7,
    eventPrBaseRef: 'main',
    prNumberOverride: '42',
    fetchImpl: pulls.fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(pulls.calls, 3)
  assert.equal(resolved.stack.position, 2)
})

test('a wait fetch gets the time left before the deadline, with a floor', () => {
  assert.equal(waitFetchTimeoutMs(40_000), FETCH_TIMEOUT_MS)
  assert.equal(waitFetchTimeoutMs(9_000), 9_000)
  assert.equal(waitFetchTimeoutMs(500), MIN_WAIT_FETCH_TIMEOUT_MS)
  assert.equal(waitFetchTimeoutMs(-3_000), MIN_WAIT_FETCH_TIMEOUT_MS)
  assert.equal(waitFetchTimeoutMs(9_000, 4_000), 4_000)
})

/** Fetches that hang until their timeout, on a fake clock. */
function hangingPullFetch(clock) {
  const state = { timeouts: [] }
  state.timeoutSignal = (ms) => {
    state.timeouts.push(ms)
    return new AbortController().signal
  }
  state.fetchImpl = async () => {
    clock.t += state.timeouts.at(-1)
    throw new Error('The operation was aborted due to timeout')
  }
  return state
}

test('a hanging API cannot push the wait past the deadline plus the floor', async () => {
  const clock = fakeClock()
  const pulls = hangingPullFetch(clock)
  const start = clock.t
  await assert.rejects(
    resolvePull({
      ...openedPull,
      stackWaitMs: 40_000,
      fetchImpl: pulls.fetchImpl,
      timeoutSignal: pulls.timeoutSignal,
      sleep: clock.sleep,
      now: clock.now,
    }),
    (err) => err.network === true && err.lookup === 'pull',
  )
  assert.ok(clock.t - start <= 40_000 + MIN_WAIT_FETCH_TIMEOUT_MS, `took ${clock.t - start} ms`)
  assert.equal(pulls.timeouts[0], FETCH_TIMEOUT_MS)
  assert.ok(pulls.timeouts.every((ms) => ms <= FETCH_TIMEOUT_MS))
  assert.ok(pulls.timeouts.at(-1) < FETCH_TIMEOUT_MS)
})

test('a slow fetch near the deadline gets a shortened timeout', async () => {
  const clock = fakeClock()
  const timeouts = []
  let calls = 0
  const resolved = await resolvePull({
    ...openedPull,
    stackWaitMs: 10_000,
    timeoutSignal: (ms) => {
      timeouts.push(ms)
      return new AbortController().signal
    },
    fetchImpl: async () => {
      calls += 1
      clock.t += 1_500
      return jsonResponse({ number: 42, base: { ref: 'feat/auth' }, stack: null })
    },
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(resolved.stack, null)
  assert.ok(timeouts.length > 1)
  assert.ok(timeouts.at(-1) < 10_000, `last timeout ${timeouts.at(-1)} ms`)
  assert.ok(timeouts.every((ms) => ms >= MIN_WAIT_FETCH_TIMEOUT_MS))
})

test('stack-wait-seconds 0 keeps the full fetch timeout', async () => {
  const timeouts = []
  await resolvePull({
    ...openedPull,
    stackWaitMs: 0,
    timeoutSignal: (ms) => {
      timeouts.push(ms)
      return new AbortController().signal
    },
    fetchImpl: async () => jsonResponse({ number: 42, base: { ref: 'feat/auth' }, stack: null }),
    sleep: async () => {
      throw new Error('should not sleep')
    },
  })
  assert.deepEqual(timeouts, [FETCH_TIMEOUT_MS])
})

/** A pull fetch plus a base-head lookup that answers with `lookup`. */
function baseHeadFetch({ lookup, stackOnCall = Infinity, body = {} }) {
  const state = { pullCalls: 0, lookups: [] }
  state.fetchImpl = async (url) => {
    if (String(url).includes('/pulls?')) {
      state.lookups.push(String(url))
      return lookup()
    }
    state.pullCalls += 1
    return jsonResponse({
      number: 42,
      base: { ref: 'feat/auth', repo: { owner: { login: 'octo' } } },
      stack: state.pullCalls >= stackOnCall ? middleStack : null,
      ...body,
    })
  }
  return state
}

test('no open PR whose head is the base: decide at once without waiting', async () => {
  const pulls = baseHeadFetch({ lookup: () => jsonResponse([]) })
  const resolved = await resolvePullRaw({
    ...openedPull,
    fetchImpl: pulls.fetchImpl,
    sleep: async () => {
      throw new Error('should not sleep')
    },
  })
  assert.equal(pulls.pullCalls, 1)
  assert.equal(pulls.lookups.length, 1)
  assert.match(pulls.lookups[0], /\/repos\/octo\/hello\/pulls\?state=open&head=octo%3Afeat%2Fauth&per_page=1$/)
  assert.equal(resolved.baseHeadPr, 'none')
  assert.equal(resolved.waitedMs, 0)
  assert.equal(resolved.stack, null)
  assert.equal(resolved.stackWaitTimedOut, false)
})

test('an open PR whose head is the base: keep waiting for the stack', async () => {
  const pulls = baseHeadFetch({ lookup: () => jsonResponse([{ number: 41 }]), stackOnCall: 3 })
  const clock = fakeClock()
  const resolved = await resolvePullRaw({
    ...openedPull,
    fetchImpl: pulls.fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(pulls.lookups.length, 1)
  assert.equal(pulls.pullCalls, 3)
  assert.equal(resolved.baseHeadPr, 'found')
  assert.equal(resolved.stack.position, 2)
})

for (const [name, lookup] of [
  ['403', () => jsonResponse({ message: 'Forbidden' }, 403)],
  ['500', () => jsonResponse({ message: 'oops' }, 500)],
  ['network error', () => Promise.reject(new TypeError('fetch failed'))],
  ['non-array body', () => jsonResponse({ number: 41 })],
]) {
  test(`a base-head lookup ${name} keeps waiting`, async () => {
    const pulls = baseHeadFetch({ lookup, stackOnCall: 3 })
    const clock = fakeClock()
    const resolved = await resolvePullRaw({
      ...openedPull,
      fetchImpl: pulls.fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    })
    assert.equal(pulls.lookups.length, 1)
    assert.equal(pulls.pullCalls, 3)
    assert.equal(resolved.baseHeadPr, 'error')
    assert.equal(resolved.stack.position, 2)
  })
}

test('the default-branch shortcut makes no base-head lookup', async () => {
  const pulls = baseHeadFetch({
    lookup: () => jsonResponse([]),
    body: { base: { ref: 'main' } },
  })
  const resolved = await resolvePullRaw({ ...openedPull, eventPrBaseRef: 'main', fetchImpl: pulls.fetchImpl })
  assert.equal(pulls.pullCalls, 1)
  assert.equal(pulls.lookups.length, 0)
  assert.equal(resolved.baseHeadPr, undefined)
})

test('bottom-n 0 makes no base-head lookup and still waits', async () => {
  const pulls = baseHeadFetch({ lookup: () => jsonResponse([]), stackOnCall: 3 })
  const clock = fakeClock()
  const resolved = await resolvePullRaw({
    ...openedPull,
    bottomN: 0,
    fetchImpl: pulls.fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(pulls.lookups.length, 0)
  assert.equal(pulls.pullCalls, 3)
  assert.equal(resolved.stack.position, 2)
})

test('a pr-number override looks up the fetched PR base', async () => {
  const pulls = baseHeadFetch({
    lookup: () => jsonResponse([]),
    body: { number: 7, base: { ref: 'release/2', repo: { owner: { login: 'octo' } } } },
  })
  const resolved = await resolvePullRaw({
    ...openedPull,
    prNumberOverride: '7',
    fetchImpl: pulls.fetchImpl,
    sleep: async () => {
      throw new Error('should not sleep')
    },
  })
  assert.equal(pulls.pullCalls, 1)
  assert.match(pulls.lookups[0], /head=octo%3Arelease%2F2&/)
  assert.equal(resolved.baseHeadPr, 'none')
  assert.equal(resolved.waitedMs, 0)
})

test('a stack opened top-first decides at once: no open PR has the base as head', async () => {
  const pulls = baseHeadFetch({
    lookup: () => jsonResponse([]),
    body: { base: { ref: 'layer-b', repo: { owner: { login: 'octo' } } } },
  })
  const resolved = await resolvePullRaw({
    ...openedPull,
    eventPrBaseRef: 'layer-b',
    fetchImpl: pulls.fetchImpl,
    sleep: async () => {
      throw new Error('should not sleep')
    },
  })
  assert.equal(pulls.pullCalls, 1)
  assert.match(pulls.lookups[0], /head=octo%3Alayer-b&/)
  assert.equal(resolved.waitedMs, 0)
  assert.equal(resolved.baseHeadPr, 'none')
  assert.equal(resolved.stackWaitTimedOut, false)
})

test('reopened with no open PR whose head is the base decides at once', async () => {
  const pulls = baseHeadFetch({ lookup: () => jsonResponse([]) })
  const resolved = await resolvePullRaw({
    ...openedPull,
    eventAction: 'reopened',
    fetchImpl: pulls.fetchImpl,
    sleep: async () => {
      throw new Error('should not sleep')
    },
  })
  assert.equal(pulls.pullCalls, 1)
  assert.equal(pulls.lookups.length, 1)
  assert.equal(resolved.baseHeadPr, 'none')
  assert.equal(resolved.waitedMs, 0)
  assert.equal(resolved.stackWaitTimedOut, false)
})

test('a first good fetch on the last attempt makes no base-head lookup', async () => {
  const clock = fakeClock()
  const urls = []
  let pullCalls = 0
  const resolved = await resolvePullRaw({
    ...openedPull,
    stackWaitMs: 6000,
    fetchImpl: async (url) => {
      urls.push(String(url))
      if (String(url).includes('/pulls?')) return jsonResponse([])
      pullCalls += 1
      if (pullCalls < 4) return jsonResponse({ message: 'bad gateway' }, 502)
      return jsonResponse({ number: 42, base: { ref: 'feat/auth' }, stack: null })
    },
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(pullCalls, 4)
  assert.deepEqual(
    urls.filter((url) => url.includes('/pulls?state=open&head=')),
    [],
  )
  assert.equal(resolved.stack, null)
  assert.equal(resolved.waitedMs, 6000)
  assert.equal(resolved.baseHeadPr, undefined)
})

/** Good "no stack" fetches, then `last()` on the fourth and final attempt of a 6 s wait. */
function failingLastPoll(last) {
  const state = { calls: 0 }
  state.fetchImpl = async () => {
    state.calls += 1
    if (state.calls === 4) return last()
    return jsonResponse({ number: 42, base: { ref: 'feat/auth' }, labels: [{ name: 'x' }], stack: null })
  }
  return state
}

for (const [name, last] of [
  ['500', () => jsonResponse({ message: 'oops' }, 500)],
  ['429', () => jsonResponse({ message: 'slow down' }, 429)],
  ['network error', () => Promise.reject(new TypeError('fetch failed'))],
]) {
  test(`a ${name} on the last poll after good fetches ends as a normal timeout`, async () => {
    const pulls = failingLastPoll(last)
    const clock = fakeClock()
    const resolved = await resolvePull({
      ...openedPull,
      stackWaitMs: 6000,
      fetchImpl: pulls.fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    })
    assert.equal(pulls.calls, 4)
    assert.equal(resolved.stack, null)
    assert.equal(resolved.source, 'api')
    assert.equal(resolved.prBaseRef, 'feat/auth')
    assert.deepEqual(resolved.labels, ['x'])
    assert.equal(resolved.waitedMs, 6000)
    assert.equal(resolved.baseHeadPr, 'found')
    assert.equal(resolved.stackWaitTimedOut, false)
  })
}

test('a 500 on the last poll of a long wait reports the wait as timed out', async () => {
  const clock = fakeClock()
  let calls = 0
  const resolved = await resolvePull({
    ...openedPull,
    fetchImpl: async () => {
      calls += 1
      if (clock.t - 1_000_000 >= 40_000) return jsonResponse({ message: 'oops' }, 500)
      return jsonResponse({ number: 42, base: { ref: 'feat/auth' }, stack: null })
    },
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(resolved.stack, null)
  assert.equal(resolved.waitedMs, 40_000)
  assert.equal(resolved.stackWaitTimedOut, true)
  assert.ok(calls > 1)
})

test('a 403 on the last poll after good fetches still throws', async () => {
  const pulls = failingLastPoll(() => jsonResponse({ message: 'Forbidden' }, 403))
  const clock = fakeClock()
  await assert.rejects(
    resolvePull({
      ...openedPull,
      stackWaitMs: 6000,
      fetchImpl: pulls.fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    }),
    (err) => err.status === 403 && err.lookup === 'pull' && err.waitedMs === 6000,
  )
  assert.equal(pulls.calls, 4)
})

test('a 500 on the only attempt of a zero wait still throws', async () => {
  let calls = 0
  await assert.rejects(
    resolvePull({
      ...openedPull,
      stackWaitMs: 0,
      fetchImpl: async () => {
        calls += 1
        return jsonResponse({ message: 'oops' }, 500)
      },
    }),
    (err) => err.status === 500 && err.lookup === 'pull' && err.waitedMs === 0,
  )
  assert.equal(calls, 1)
})

for (const body of [null, 'oops', 7]) {
  test(`a ${JSON.stringify(body)} pull request body throws at once with the wait fields`, async () => {
    const clock = fakeClock()
    let calls = 0
    await assert.rejects(
      resolvePull({
        ...openedPull,
        fetchImpl: async () => {
          calls += 1
          if (calls === 3) return jsonResponse(body)
          return jsonResponse({ number: 42, base: { ref: 'feat/auth' }, stack: null })
        },
        sleep: clock.sleep,
        now: clock.now,
      }),
      (err) =>
        err.message === 'unexpected pull request body' &&
        err.lookup === 'pull' &&
        err.waitedMs === 3000 &&
        err.baseHeadPr === 'found',
    )
    assert.equal(calls, 3)
  })
}
