import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ConfigError,
  decide,
  parseBottomN,
  parseForceRunLabel,
  parseRunTop,
} from './decide.mjs'

function stackOf({ position, size, base = 'main' }) {
  return {
    number: 50,
    position,
    size,
    base: { ref: base, sha: 'abc' },
  }
}

const defaults = { eventName: 'pull_request', bottomN: 1, runTop: true }

test('standalone — no stack → should_run=true', () => {
  const result = decide({
    ...defaults,
    stack: null,
    prBaseRef: 'main',
  })
  assert.equal(result.should_run, true)
  assert.equal(result.is_stacked, false)
  assert.match(result.reason, /not in a stack/)
})

test('lowest of 3, bottom_n=1 → should_run=true, is_bottom', () => {
  const result = decide({
    ...defaults,
    stack: stackOf({ position: 1, size: 3 }),
    prBaseRef: 'main',
  })
  assert.equal(result.should_run, true)
  assert.equal(result.is_bottom, true)
  assert.equal(result.is_top, false)
  assert.equal(result.position, '1')
  assert.equal(result.size, '3')
  assert.match(result.reason, /lowest unmerged/)
})

test('middle of 3, defaults → should_run=false', () => {
  const result = decide({
    ...defaults,
    stack: stackOf({ position: 2, size: 3 }),
    prBaseRef: 'feat/auth',
  })
  assert.equal(result.should_run, false)
  assert.equal(result.is_bottom, false)
  assert.equal(result.is_top, false)
  assert.match(result.reason, /middle of stack/)
})

test('top of 3, run_top=true → should_run=true, is_top', () => {
  const result = decide({
    ...defaults,
    runTop: true,
    stack: stackOf({ position: 3, size: 3 }),
    prBaseRef: 'feat/api',
  })
  assert.equal(result.should_run, true)
  assert.equal(result.is_top, true)
  assert.match(result.reason, /top of stack/)
})

test('top of 3, run_top=false → should_run=false', () => {
  const result = decide({
    ...defaults,
    runTop: false,
    stack: stackOf({ position: 3, size: 3 }),
    prBaseRef: 'feat/api',
  })
  assert.equal(result.should_run, false)
})

test('bottom_n=2 on remaining depth 2 of 4 → should_run=true', () => {
  const result = decide({
    ...defaults,
    bottomN: 2,
    stack: stackOf({ position: 2, size: 4 }),
    prBaseRef: 'feat/auth',
    remainingDepth: 2,
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /remaining depth 2 is within bottom-n=2/)
})

test('after partial merge, former middle is lowest via base-ref even if position != 1', () => {
  const result = decide({
    ...defaults,
    stack: stackOf({ position: 2, size: 3 }),
    prBaseRef: 'main',
  })
  assert.equal(result.should_run, true)
  assert.equal(result.is_bottom, true)
  assert.equal(result.position, '2')
  assert.match(result.reason, /lowest unmerged/)
})

test('single-layer stack is lowest and top, should_run=true', () => {
  const result = decide({
    ...defaults,
    stack: stackOf({ position: 1, size: 1 }),
    prBaseRef: 'main',
  })
  assert.equal(result.should_run, true)
  assert.equal(result.is_bottom, true)
  assert.equal(result.is_top, true)
})

test('merge_group → should_run=true', () => {
  const result = decide({
    eventName: 'merge_group',
    bottomN: 1,
    runTop: true,
    stack: stackOf({ position: 2, size: 3 }),
    prBaseRef: 'feat/auth',
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /not a pull_request event/)
})

test('workflow_dispatch → should_run=true', () => {
  const result = decide({
    eventName: 'workflow_dispatch',
    bottomN: 1,
    runTop: true,
    stack: null,
    prBaseRef: '',
  })
  assert.equal(result.should_run, true)
})

test('pull_request_target uses the same should_run table', () => {
  const result = decide({
    eventName: 'pull_request_target',
    bottomN: 1,
    runTop: true,
    stack: stackOf({ position: 2, size: 3 }),
    prBaseRef: 'feat/auth',
  })
  assert.equal(result.should_run, false)
})

test('bottom_n=0 and run_top=true runs only the top', () => {
  const lowest = decide({
    ...defaults,
    bottomN: 0,
    runTop: true,
    stack: stackOf({ position: 1, size: 3 }),
    prBaseRef: 'main',
  })
  const top = decide({
    ...defaults,
    bottomN: 0,
    runTop: true,
    stack: stackOf({ position: 3, size: 3 }),
    prBaseRef: 'feat/api',
  })
  assert.equal(lowest.should_run, false)
  assert.equal(top.should_run, true)
})

test('missing remaining depth for bottom_n>1 fail-opens', () => {
  const result = decide({
    ...defaults,
    bottomN: 2,
    stack: stackOf({ position: 2, size: 4 }),
    prBaseRef: 'feat/auth',
    remainingDepth: null,
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /could not determine remaining stack depth/)
})

test('invalid stack metadata fail-opens', () => {
  const result = decide({
    ...defaults,
    stack: { position: 'nope', size: 3, base: { ref: 'main' } },
    prBaseRef: 'main',
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /invalid stack metadata/)
})

test('stack without base.ref fail-opens instead of skipping the bottom', () => {
  const result = decide({
    ...defaults,
    stack: { number: 50, position: 1, size: 3 },
    prBaseRef: 'main',
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /invalid stack metadata/)
})

test('PR stack with empty prBaseRef fail-opens', () => {
  const result = decide({
    ...defaults,
    stack: stackOf({ position: 1, size: 3 }),
    prBaseRef: '',
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /invalid stack metadata/)
})

test('parseBottomN accepts integers and empty default', () => {
  assert.equal(parseBottomN(undefined), 1)
  assert.equal(parseBottomN(''), 1)
  assert.equal(parseBottomN('0'), 0)
  assert.equal(parseBottomN('2'), 2)
  assert.throws(() => parseBottomN('1.5'), ConfigError)
  assert.throws(() => parseBottomN('-1'), ConfigError)
  assert.throws(() => parseBottomN('nope'), ConfigError)
})

test('parseRunTop accepts booleans and empty default', () => {
  assert.equal(parseRunTop(undefined), true)
  assert.equal(parseRunTop(''), true)
  assert.equal(parseRunTop('true'), true)
  assert.equal(parseRunTop('FALSE'), false)
  assert.throws(() => parseRunTop('yes'), ConfigError)
})

const force = {
  labelNames: ['stack-ci:run'],
  forceRunLabel: 'stack-ci:run',
}
const FORCE_REASON = 'force-run label stack-ci:run'

function midStack(extra = {}) {
  return {
    ...defaults,
    stack: stackOf({ position: 2, size: 3 }),
    prBaseRef: 'feat/auth',
    ...extra,
  }
}

test('mid-stack without labels still skips', () => {
  const result = decide(midStack())
  assert.equal(result.should_run, false)
  assert.match(result.reason, /middle of stack/)
})

test('mid-stack with a different label still skips', () => {
  const result = decide(midStack({ labelNames: ['bug'], forceRunLabel: 'stack-ci:run' }))
  assert.equal(result.should_run, false)
  assert.match(result.reason, /middle of stack/)
})

test('mid-stack with the force-run label runs and names the label', () => {
  const result = decide(midStack(force))
  assert.equal(result.should_run, true)
  assert.equal(result.reason, FORCE_REASON)
  assert.equal(result.is_bottom, false)
  assert.equal(result.position, '2')
})

test('force-run matches when the label is one of several', () => {
  const result = decide(
    midStack({ labelNames: ['bug', 'stack-ci:run'], forceRunLabel: 'stack-ci:run' }),
  )
  assert.equal(result.should_run, true)
  assert.equal(result.reason, FORCE_REASON)
})

test('empty force-run label disables the feature', () => {
  const result = decide(midStack({ labelNames: ['stack-ci:run'], forceRunLabel: '' }))
  assert.equal(result.should_run, false)
  assert.match(result.reason, /middle of stack/)
})

test('force-run label match is case-sensitive', () => {
  const result = decide(
    midStack({ labelNames: ['Stack-CI:Run'], forceRunLabel: 'stack-ci:run' }),
  )
  assert.equal(result.should_run, false)
  assert.match(result.reason, /middle of stack/)
})

test('remaining bottom keeps its reason when the force-run label is present', () => {
  const result = decide({
    ...defaults,
    ...force,
    stack: stackOf({ position: 2, size: 3 }),
    prBaseRef: 'main',
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /lowest unmerged/)
  assert.doesNotMatch(result.reason, /force-run/)
})

test('top keeps its reason when the force-run label is present', () => {
  const result = decide({
    ...defaults,
    ...force,
    stack: stackOf({ position: 3, size: 3 }),
    prBaseRef: 'feat/api',
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /top of stack/)
  assert.doesNotMatch(result.reason, /force-run/)
})

test('top with run-top false runs because of the force-run label', () => {
  const result = decide({
    ...defaults,
    ...force,
    runTop: false,
    stack: stackOf({ position: 3, size: 3 }),
    prBaseRef: 'feat/api',
  })
  assert.equal(result.should_run, true)
  assert.equal(result.reason, FORCE_REASON)
  assert.equal(result.is_top, true)
  assert.equal(result.is_bottom, false)
})

test('bottom-n match keeps the remaining-depth reason when the label is present', () => {
  const result = decide({
    ...defaults,
    ...force,
    bottomN: 2,
    stack: stackOf({ position: 2, size: 4 }),
    prBaseRef: 'feat/auth',
    remainingDepth: 2,
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /remaining depth 2 is within bottom-n=2/)
  assert.doesNotMatch(result.reason, /force-run/)
})

test('unknown remaining depth keeps the fail-open reason when the label is present', () => {
  const result = decide({
    ...defaults,
    ...force,
    bottomN: 2,
    stack: stackOf({ position: 2, size: 4 }),
    prBaseRef: 'feat/auth',
    remainingDepth: null,
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /could not determine remaining stack depth/)
  assert.doesNotMatch(result.reason, /force-run/)
})

test('standalone keeps its reason when the force-run label is present', () => {
  const result = decide({
    ...defaults,
    ...force,
    stack: null,
    prBaseRef: 'main',
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /not in a stack/)
  assert.doesNotMatch(result.reason, /force-run/)
})

test('invalid stack keeps its reason when the force-run label is present', () => {
  const result = decide({
    ...defaults,
    ...force,
    stack: { position: 'nope', size: 3, base: { ref: 'main' } },
    prBaseRef: 'main',
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /invalid stack metadata/)
  assert.doesNotMatch(result.reason, /force-run/)
})

test('merge_group ignores the force-run label', () => {
  const result = decide({
    eventName: 'merge_group',
    bottomN: 1,
    runTop: true,
    stack: stackOf({ position: 2, size: 3 }),
    prBaseRef: 'feat/auth',
    ...force,
  })
  assert.equal(result.should_run, true)
  assert.match(result.reason, /not a pull_request event/)
  assert.doesNotMatch(result.reason, /force-run/)
})

test('pull_request_target mid-stack force-runs on the label', () => {
  const result = decide({
    eventName: 'pull_request_target',
    bottomN: 1,
    runTop: true,
    stack: stackOf({ position: 2, size: 3 }),
    prBaseRef: 'feat/auth',
    ...force,
  })
  assert.equal(result.should_run, true)
  assert.equal(result.reason, FORCE_REASON)
})

test('parseForceRunLabel defaults when missing and disables on empty', () => {
  assert.equal(parseForceRunLabel(undefined), 'stack-ci:run')
  assert.equal(parseForceRunLabel(null), 'stack-ci:run')
  assert.equal(parseForceRunLabel(''), '')
  assert.equal(parseForceRunLabel('   '), '')
  assert.equal(parseForceRunLabel('  ship it  '), 'ship it')
})
