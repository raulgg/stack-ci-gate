import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cmpSemver,
  latestTagFromListing,
  listingCovers,
  listingUrl,
  releaseEditUrl,
} from './marketplace-latest.mjs'

const sample = '{"slug":"stack-ci-gate","latestRelease":{"tagName":"v1.0.1","name":"v1.0.1","isPrerelease":false}} uses: raulgg/stack-ci-gate@v1'

test('latestTagFromListing reads latestRelease.tagName, not README pins', () => {
  assert.equal(latestTagFromListing(sample), 'v1.0.1')
  assert.throws(() => latestTagFromListing('<html>no payload</html>'), /latestRelease/)
})

test('listingUrl uses the repo name as the Marketplace slug', () => {
  assert.equal(
    listingUrl('raulgg/stack-ci-gate'),
    'https://github.com/marketplace/actions/stack-ci-gate',
  )
  assert.throws(() => listingUrl('nopath'), /owner\/repo/)
})

test('releaseEditUrl points at the existing Release', () => {
  assert.equal(
    releaseEditUrl('raulgg/stack-ci-gate', 'v1.0.2'),
    'https://github.com/raulgg/stack-ci-gate/releases/edit/v1.0.2',
  )
})

test('listingCovers accepts an equal or newer listing tag', () => {
  assert.equal(cmpSemver('v1.0.2', 'v1.0.1'), 1)
  assert.equal(listingCovers('v1.0.1', 'v1.0.1'), true)
  assert.equal(listingCovers('v1.0.2', 'v1.0.1'), true)
  assert.equal(listingCovers('v1.0.1', 'v1.0.2'), false)
})
