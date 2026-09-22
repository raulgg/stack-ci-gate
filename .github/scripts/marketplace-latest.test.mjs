import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cmpSemver,
  latestTagFromListing,
  listingCovers,
  listingUrl,
  releaseEditUrl,
} from './marketplace-latest.mjs'

function listingPage(body) {
  return `<html><p>uses: raulgg/stack-ci-gate@v1</p><script type="application/json">{"latestRelease":{"tagName":"v9.9.9"}}</script>${body}</html>`
}

test('latestTagFromListing reads embedded releaseData, not nearby tag names', () => {
  const page = listingPage(`
    <script data-target="react-app.embeddedData" type="application/json">
      {
        "payload": {
          "releaseData": {
            "latestRelease": {
              "name": "v1.0.1",
              "isPrerelease": false,
              "tagName": "v1.0.1"
            }
          }
        }
      }
    </script>`)
  assert.equal(latestTagFromListing(page), 'v1.0.1')
  assert.throws(() => latestTagFromListing(listingPage('')), /latestRelease/)
  assert.throws(
    () =>
      latestTagFromListing(
        listingPage(
          '<script data-target="react-app.embeddedData" type="application/json">{"payload":{}}</script>',
        ),
      ),
    /latestRelease/,
  )
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
