const DEFAULT_API = 'https://api.github.com'

export const GITHUB_API_VERSION = '2026-03-10'
export const FETCH_TIMEOUT_MS = 15_000

/** Immediate fetch, then backoff. Total wait ~6s so `opened` can see the stack. */
export const OPENED_RETRY_DELAYS_MS = [0, 1000, 2000, 3000]

function openStackPulls(pulls) {
  if (!Array.isArray(pulls)) return null
  return pulls.filter((pr) => pr && pr.state === 'open')
}

/** Open PRs, from the start of the list, are remaining-bottom first. */
export function remainingDepthFromStackPulls(pulls, prNumber) {
  const unmerged = openStackPulls(pulls)
  if (unmerged == null) return null
  const index = unmerged.findIndex(
    (pr) => Number(pr.number) === Number(prNumber),
  )
  if (index === -1) return null
  return index + 1
}

function openPullNumbers(pulls) {
  const unmerged = openStackPulls(pulls)
  if (unmerged == null) return null
  const numbers = []
  for (const pr of unmerged) {
    const number = Number(pr.number)
    if (!Number.isInteger(number) || number < 1) continue
    numbers.push(number)
  }
  return numbers
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

async function githubGet(url, { token, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS }) {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'stack-ci-gate',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const err = new Error(`GET ${url} → ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

export async function fetchPullRequest({
  apiUrl = DEFAULT_API,
  repo,
  prNumber,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
}) {
  return githubGet(`${apiUrl}/repos/${repo}/pulls/${prNumber}`, {
    token,
    fetchImpl,
    timeoutMs,
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

/**
 * Event stack is missing on `opened` (PR is created, then stacked). Fetch the
 * PR resource, and retry briefly on opened/reopened. A pr_number override
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
  retryDelaysMs = OPENED_RETRY_DELAYS_MS,
  timeoutMs = FETCH_TIMEOUT_MS,
}) {
  const override = String(prNumberOverride ?? '').trim()
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

  const delays = shouldRetryForStack(eventAction) ? retryDelaysMs : [0]
  let lastPr = null
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i])
    lastPr = await fetchPullRequest({
      apiUrl,
      repo,
      prNumber,
      token,
      fetchImpl,
      timeoutMs,
    })
    const stack = normalizeStack(lastPr.stack)
    if (stack) {
      return {
        prNumber: lastPr.number ?? prNumber,
        prBaseRef: lastPr.base?.ref ?? eventPrBaseRef ?? '',
        stack,
        labels: labelNamesFrom(lastPr.labels),
        source: 'api',
      }
    }
  }

  return {
    prNumber: lastPr?.number ?? prNumber,
    prBaseRef: lastPr?.base?.ref ?? eventPrBaseRef ?? '',
    stack: null,
    labels: labelNamesFrom(lastPr?.labels),
    source: 'api',
  }
}

/**
 * Event/API pull plus remaining depth for every stacked pull request.
 * Listing failures leave remainingDepth null so bottom-n > 1 still fail-opens.
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
  retryDelaysMs,
  timeoutMs = FETCH_TIMEOUT_MS,
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
    retryDelaysMs,
    timeoutMs,
  })

  let remainingDepth = null
  let remainingBottomNumber = null
  let topNumber = null
  if (pull.stack?.number != null && token) {
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
      const numbers = openPullNumbers(pulls)
      if (numbers != null && numbers.length > 0) {
        remainingBottomNumber = numbers[0]
        topNumber = numbers[numbers.length - 1]
      }
    } catch {
      remainingDepth = null
      remainingBottomNumber = null
      topNumber = null
    }
  }

  return { ...pull, remainingDepth, remainingBottomNumber, topNumber }
}
