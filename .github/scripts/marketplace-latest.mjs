import fs from 'node:fs'
import { versionFromTag } from './changelog-notes.mjs'

const DEFAULT_REPOSITORY = 'raulgg/stack-ci-gate'
const USER_AGENT = 'stack-ci-gate-marketplace-check (+https://github.com/raulgg/stack-ci-gate)'

export function listingUrl(repository = process.env.GITHUB_REPOSITORY) {
  const repo = String(repository || DEFAULT_REPOSITORY).split('/')[1]
  if (!repo) {
    throw new Error(`expected owner/repo, got ${JSON.stringify(repository)}`)
  }
  return `https://github.com/marketplace/actions/${repo}`
}

export function releaseEditUrl(repository, tag) {
  const repo = String(repository || DEFAULT_REPOSITORY)
  if (!repo.includes('/')) {
    throw new Error(`expected owner/repo, got ${JSON.stringify(repository)}`)
  }
  return `https://github.com/${repo}/releases/edit/${tag}`
}

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
const EMBEDDED_DATA = /\bdata-target\s*=\s*["']react-app\.embeddedData["']/i
const MISSING_TAG = 'Marketplace listing HTML has no latestRelease.tagName'

export function latestTagFromListing(html) {
  for (const match of String(html).matchAll(SCRIPT_TAG)) {
    if (!EMBEDDED_DATA.test(match[1])) continue
    let data
    try {
      data = JSON.parse(match[2])
    } catch {
      throw new Error(MISSING_TAG)
    }
    const tag = data?.payload?.releaseData?.latestRelease?.tagName
    if (typeof tag !== 'string' || tag === '') throw new Error(MISSING_TAG)
    return tag
  }
  throw new Error(MISSING_TAG)
}

export function cmpSemver(left, right) {
  const a = versionFromTag(left).split('.').map(Number)
  const b = versionFromTag(right).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

export function listingCovers(listingTag, releaseTag) {
  return cmpSemver(listingTag, releaseTag) >= 0
}

function mismatchMessage({ tag, listingTag, repository }) {
  return [
    `Marketplace latest is ${listingTag}; this release is ${tag}.`,
    'GitHub has no API for the Marketplace checkbox (it requires 2FA in the browser).',
    `Open ${releaseEditUrl(repository, tag)}`,
    'Check "Publish this Action to the GitHub Marketplace".',
    'Primary category: Continuous integration. Secondary: Utilities.',
    'Update release, then re-run this job.',
  ].join('\n')
}

async function fetchListing(url) {
  const delays = [0, 2000, 5000]
  let lastError
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
        redirect: 'follow',
      })
      if (!response.ok) {
        lastError = new Error(`GET ${url} → ${response.status}`)
        continue
      }
      return await response.text()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError
}

function writeSummary(text) {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (!path) return
  fs.appendFileSync(path, `${text}\n`)
}

if (import.meta.main) {
  try {
    const tag = process.argv[2]
    versionFromTag(tag)
    const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY
    const url = listingUrl(repository)
    const html = await fetchListing(url)
    const listingTag = latestTagFromListing(html)
    if (!listingCovers(listingTag, tag)) {
      const message = mismatchMessage({ tag, listingTag, repository })
      writeSummary(`## Marketplace\n\n${message}\n`)
      throw new Error(message)
    }
    const ok = `Marketplace latest ${listingTag} covers ${tag} (${url})`
    writeSummary(`## Marketplace\n\n${ok}\n`)
    process.stdout.write(`${ok}\n`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
