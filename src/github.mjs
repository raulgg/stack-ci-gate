import { DEFAULT_STACK_WAIT_SECONDS } from './decide.mjs'

const DEFAULT_API = 'https://api.github.com'

export const GITHUB_API_VERSION = '2026-03-10'
export const FETCH_TIMEOUT_MS = 15_000

export const DEFAULT_STACK_WAIT_MS = DEFAULT_STACK_WAIT_SECONDS * 1000

/** A budget up to this long (the ~6 s retry of 1.1.0) stays quiet when it runs out. */
const SHORT_WAIT_MS = 6000

/** A fetch near the deadline still gets this long, so it is not cut off at once. */
export const MIN_WAIT_FETCH_TIMEOUT_MS = 2000

/** During a wait, a fetch may not run past the deadline by more than the floor. */
export function waitFetchTimeoutMs(remainingMs, timeoutMs = FETCH_TIMEOUT_MS) {
  return Math.min(timeoutMs, Math.max(remainingMs, MIN_WAIT_FETCH_TIMEOUT_MS))
}

/** 0, 1, 2, 3 s, then every 5 s, until the delays add up to totalMs. */
export function stackWaitDelays(totalMs) {
  const delays = [0]
  let waited = 0
  let step = 0
  while (waited < totalMs) {
    const next = [1000, 2000, 3000][step++] ?? 5000
    const delay = Math.min(next, totalMs - waited)
    delays.push(delay)
    waited += delay
  }
  return delays
}

/** Open PRs, from the start of the list, are remaining-bottom first. */
export function remainingDepthFromStackPulls(pulls, prNumber) {
  if (!Array.isArray(pulls)) return null
  const unmerged = pulls.filter((pr) => pr && pr.state === 'open')
  const index = unmerged.findIndex(
    (pr) => Number(pr.number) === Number(prNumber),
  )
  if (index === -1) return null
  return index + 1
}

export function normalizeStack(stack) {
  if (stack == null || stack === '' || stack === 'null') return null
  if (typeof stack !== 'object') return null
  return stack
}

export function labelNamesFrom(labels) {
  if (!Array.isArray(labels)) return []
  const names = []
  for (const label of labels) {
    if (label && typeof label.name === 'string') names.push(label.name)
  }
  return names
}

function tagError(err, fields) {
  const tagged = err instanceof Error ? err : new Error(String(err))
  return Object.assign(tagged, fields)
}

async function githubGet(
  url,
  { token, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS, timeoutSignal = AbortSignal.timeout },
) {
  let res
  try {
    res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'stack-ci-gate',
      },
      redirect: 'error',
      signal: timeoutSignal(timeoutMs),
    })
  } catch (err) {
    // A rejected fetch is a network error or the timeout, not an HTTP status.
    throw tagError(err, { network: true })
  }
  if (!res.ok) {
    const err = new Error(`GET ${url} → ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

/**
 * gh stack submit opens PRs bottom-first, so a PR in a new stack has an open
 * PR whose head is its base. 'none' means nothing can be stacked below this
 * PR, so with bottom-n of 1 or more it runs either way. Any failure reports
 * 'error', and the caller keeps waiting.
 */
async function findBaseHeadPr({ apiUrl, repo, pr, token, fetchImpl, timeoutMs, timeoutSignal }) {
  const ref = pr?.base?.ref
  const owner = pr?.base?.repo?.owner?.login || String(repo).split('/')[0]
  if (!ref || !owner) return 'error'
  const head = encodeURIComponent(`${owner}:${ref}`)
  try {
    const list = await githubGet(
      `${apiUrl}/repos/${repo}/pulls?state=open&head=${head}&per_page=1`,
      { token, fetchImpl, timeoutMs, timeoutSignal },
    )
    if (!Array.isArray(list)) return 'error'
    return list.length === 0 ? 'none' : 'found'
  } catch {
    return 'error'
  }
}

export async function fetchPullRequest({
  apiUrl = DEFAULT_API,
  repo,
  prNumber,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  timeoutSignal,
}) {
  return githubGet(`${apiUrl}/repos/${repo}/pulls/${prNumber}`, {
    token,
    fetchImpl,
    timeoutMs,
    timeoutSignal,
  })
}

async function fetchStack({
  apiUrl = DEFAULT_API,
  repo,
  stackNumber,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
}) {
  return githubGet(`${apiUrl}/repos/${repo}/stacks/${stackNumber}`, {
    token,
    fetchImpl,
    timeoutMs,
  })
}

function shouldRetryForStack(eventAction) {
  return eventAction === 'opened' || eventAction === 'reopened'
}

/** A pull request number: digits only, no sign, no leading zero. */
const PR_NUMBER_PATTERN = /^[1-9]\d*$/

function isRetryable(err) {
  return err?.network === true || err?.status === 429 || err?.status >= 500
}

/**
 * With bottom-n of 1 or more, a PR into the default branch is standalone or
 * the remaining bottom, and runs either way, so it does not wait. The fetched
 * PR decides, so a pr-number override or a payload without
 * repository.default_branch still takes the shortcut.
 */
function intoDefaultBranch(pr, defaultBranch, bottomN) {
  if (!(bottomN >= 1)) return false
  const base = pr?.base?.ref
  const branch = pr?.base?.repo?.default_branch || defaultBranch
  return Boolean(base && branch && base === branch)
}

/**
 * Event stack is missing on `opened` (PR is created, then stacked). Fetch the
 * PR resource, and on opened/reopened poll for the stack until stackWaitMs of
 * wall-clock time has passed, unless the base is the default branch. waitedMs
 * is the time from the first fetch to the start of the last one;
 * stackWaitTimedOut is true when a budget longer than the short retry ended
 * without a stack. A 429, 5xx or network error mid-wait is retried while
 * budget remains. On the last attempt it ends the wait as "no stack" when an
 * earlier fetch succeeded, and throws otherwise. A thrown error carries
 * waitedMs. A pr_number override
 * always uses the API and ignores the triggering event's stack.
 * Labels come from that same pull request: the event payload when its stack
 * is used, otherwise the fetched body.
 */
export async function resolvePull({
  eventAction,
  eventStack,
  eventPrNumber,
  eventPrBaseRef,
  eventLabels,
  prNumberOverride,
  repo,
  token,
  apiUrl = DEFAULT_API,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  retryDelaysMs,
  defaultBranch = '',
  stackWaitMs = DEFAULT_STACK_WAIT_MS,
  bottomN = 1,
  timeoutMs = FETCH_TIMEOUT_MS,
  timeoutSignal,
}) {
  const override = String(prNumberOverride ?? '').trim()
  if (override && !PR_NUMBER_PATTERN.test(override)) {
    return {
      prNumber: null,
      prBaseRef: eventPrBaseRef ?? '',
      stack: null,
      labels: [],
      source: 'invalid-pr-number',
    }
  }
  const prNumber = override
    ? Number(override)
    : eventPrNumber == null || eventPrNumber === ''
      ? null
      : Number(eventPrNumber)

  const eventStackNorm = normalizeStack(eventStack)
  if (!override && eventStackNorm) {
    return {
      prNumber,
      prBaseRef: eventPrBaseRef ?? '',
      stack: eventStackNorm,
      labels: labelNamesFrom(eventLabels),
      source: 'event',
    }
  }

  if (prNumber == null || !Number.isFinite(prNumber)) {
    return {
      prNumber: null,
      prBaseRef: eventPrBaseRef ?? '',
      stack: null,
      labels: [],
      source: 'none',
    }
  }

  if (!token) {
    return {
      prNumber,
      prBaseRef: eventPrBaseRef ?? '',
      stack: null,
      labels: [],
      source: 'no-token',
    }
  }

  const polls = shouldRetryForStack(eventAction)
  const delays = !polls ? [0] : (retryDelaysMs ?? stackWaitDelays(stackWaitMs))
  const budgetMs = polls ? delays.reduce((sum, ms) => sum + ms, 0) : 0
  const start = now()
  const deadline = start + budgetMs
  let lastPr = null
  let waitedMs = 0
  let fetchMs = 0
  let baseHeadPr
  for (let i = 0; i < delays.length; i++) {
    // The fetch time counts against the next sleep, so the wait stays in budget.
    const pause = Math.min(Math.max(delays[i] - fetchMs, 0), Math.max(deadline - now(), 0))
    if (i > 0 && pause > 0) await sleep(pause)
    const fetchStart = now()
    waitedMs = fetchStart - start
    const lastAttempt = i === delays.length - 1 || fetchStart >= deadline
    let pr
    try {
      pr = await fetchPullRequest({
        apiUrl,
        repo,
        prNumber,
        token,
        fetchImpl,
        timeoutMs: budgetMs > 0 ? waitFetchTimeoutMs(deadline - fetchStart, timeoutMs) : timeoutMs,
        timeoutSignal,
      })
      // A 200 with a body that is not an object is not retried: like an
      // unparsable body, it is not a known transient failure.
      if (pr === null || typeof pr !== 'object') throw new Error('unexpected pull request body')
    } catch (err) {
      const tagged = tagError(err, { lookup: 'pull', waitedMs, baseHeadPr })
      if (!isRetryable(tagged)) throw tagged
      if (lastAttempt) {
        // An earlier fetch already said "no stack", so the wait ends as a timeout.
        if (lastPr) break
        throw tagged
      }
      fetchMs = now() - fetchStart
      continue
    }
    fetchMs = now() - fetchStart
    lastPr = pr
    const stack = normalizeStack(lastPr.stack)
    if (stack) {
      return {
        prNumber: lastPr.number ?? prNumber,
        prBaseRef: lastPr.base?.ref ?? eventPrBaseRef ?? '',
        stack,
        labels: labelNamesFrom(lastPr.labels),
        source: 'api',
        waitedMs,
        baseHeadPr,
      }
    }
    if (intoDefaultBranch(lastPr, defaultBranch, bottomN)) break
    // On the last attempt the lookup could not shorten the wait, so skip it.
    if (budgetMs > 0 && bottomN >= 1 && baseHeadPr === undefined && !lastAttempt) {
      const lookupStart = now()
      baseHeadPr = await findBaseHeadPr({
        apiUrl,
        repo,
        pr: lastPr,
        token,
        fetchImpl,
        timeoutMs: waitFetchTimeoutMs(deadline - lookupStart, timeoutMs),
        timeoutSignal,
      })
      fetchMs += now() - lookupStart
      if (baseHeadPr === 'none') break
    }
    if (fetchStart >= deadline) break
  }

  return {
    prNumber: lastPr?.number ?? prNumber,
    prBaseRef: lastPr?.base?.ref ?? eventPrBaseRef ?? '',
    stack: null,
    labels: labelNamesFrom(lastPr?.labels),
    source: 'api',
    waitedMs,
    baseHeadPr,
    stackWaitTimedOut:
      polls &&
      budgetMs > SHORT_WAIT_MS &&
      baseHeadPr !== 'none' &&
      !intoDefaultBranch(lastPr, defaultBranch, bottomN),
  }
}

function pullLookupProblem(pull, token, bottomN) {
  if (pull.source === 'invalid-pr-number') {
    return { kind: 'invalid-pr-number', message: 'pr-number is not a pull request number' }
  }
  // Fork and Dependabot pull requests get no secrets. Unless the PR is known
  // to be stacked and needed the stack listing, an empty token stays quiet.
  if (pull.source === 'no-token') {
    return { kind: 'no-token', quiet: true, message: 'no token to read the stack' }
  }
  if (!token && bottomN > 1 && pull.stack != null) {
    return { kind: 'no-token', message: 'no token to read the stack' }
  }
  return null
}

/**
 * Event/API pull plus remaining depth when bottom-n > 1.
 * Listing failures leave remainingDepth null so decide fail-opens,
 * and lookupProblem says why.
 */
export async function resolveContext({
  eventAction,
  eventStack,
  eventPrNumber,
  eventPrBaseRef,
  eventLabels,
  prNumberOverride,
  repo,
  token,
  apiUrl = DEFAULT_API,
  fetchImpl = globalThis.fetch,
  sleep,
  now,
  retryDelaysMs,
  defaultBranch,
  stackWaitMs,
  timeoutMs = FETCH_TIMEOUT_MS,
  bottomN,
}) {
  const pull = await resolvePull({
    eventAction,
    eventStack,
    eventPrNumber,
    eventPrBaseRef,
    eventLabels,
    prNumberOverride,
    repo,
    token,
    apiUrl,
    fetchImpl,
    sleep,
    now,
    retryDelaysMs,
    defaultBranch,
    stackWaitMs,
    bottomN,
    timeoutMs,
  })

  let remainingDepth = null
  let lookupProblem = pullLookupProblem(pull, token, bottomN)
  if (bottomN > 1 && pull.stack?.number != null && token) {
    try {
      const stackPayload = await fetchStack({
        apiUrl,
        repo,
        stackNumber: pull.stack.number,
        token,
        fetchImpl,
        timeoutMs,
      })
      const pulls = stackPayload?.pull_requests
      remainingDepth = remainingDepthFromStackPulls(pulls, pull.prNumber)
      if (remainingDepth == null && Array.isArray(pulls)) {
        lookupProblem = {
          kind: 'not-in-stack',
          lookup: 'stack',
          message: 'this pull request is not open in the stack listing',
        }
      }
    } catch (err) {
      remainingDepth = null
      lookupProblem = {
        lookup: 'stack',
        message: err instanceof Error ? err.message : String(err),
        status: err?.status,
        network: err?.network === true,
      }
    }
  }

  return { ...pull, remainingDepth, lookupProblem }
}
