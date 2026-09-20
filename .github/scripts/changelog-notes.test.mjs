import assert from 'node:assert/strict'
import { test } from 'node:test'
import { notesFor, versionFromTag } from './changelog-notes.mjs'

const sample = `# Changelog

## Unreleased

- pending

## 1.0.0 - 2026-09-20

### Added

- Gate stacked CI.

## 0.9.0

- old
`

test('versionFromTag strips v and rejects other shapes', () => {
  assert.equal(versionFromTag('v1.0.0'), '1.0.0')
  assert.equal(versionFromTag('1.2.3'), '1.2.3')
  assert.throws(() => versionFromTag('v1'), /expected vMAJOR.MINOR.PATCH/)
  assert.throws(() => versionFromTag('v1.0.0-rc.1'), /expected vMAJOR.MINOR.PATCH/)
})

test('notesFor reads the matching version section', () => {
  const notes = notesFor(sample, 'v1.0.0')
  assert.match(notes, /Gate stacked CI/)
  assert.doesNotMatch(notes, /pending/)
  assert.doesNotMatch(notes, /old/)
})

test('notesFor accepts a bracketed heading', () => {
  const notes = notesFor('## [1.0.1] - 2026-09-21\n\n- Patch.\n', 'v1.0.1')
  assert.equal(notes, '- Patch.')
})

test('notesFor fails when the heading is missing or empty', () => {
  assert.throws(() => notesFor(sample, 'v9.9.9'), /no heading/)
  assert.throws(() => notesFor('## 1.0.0\n\n## 0.9.0\n- x\n', 'v1.0.0'), /empty/)
})

test('notesFor stops before compare-link footer', () => {
  const notes = notesFor(
    '## 1.0.0 - 2026-09-20\n\n- Gate.\n\n[Unreleased]: https://example/compare/v1.0.0...HEAD\n[1.0.0]: https://example/releases/tag/v1.0.0\n',
    'v1.0.0',
  )
  assert.equal(notes, '- Gate.')
})
