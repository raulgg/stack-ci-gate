# Stack CI Gate

[![Test](https://github.com/raulgg/stack-ci-gate/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/raulgg/stack-ci-gate/actions/workflows/test.yml?query=branch%3Amain)
[![Marketplace](https://img.shields.io/badge/Marketplace-v1-blue)](https://github.com/marketplace/actions/stack-ci-gate)
[![Release](https://img.shields.io/github/v/release/raulgg/stack-ci-gate)](https://github.com/raulgg/stack-ci-gate/releases/latest)
[![License: MIT](https://img.shields.io/github/license/raulgg/stack-ci-gate)](LICENSE)

This GitHub Action skips redundant CI on [GitHub's stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs). GitHub Actions still run as if each pull request targets the **stack base**, so a workflow for `main` runs for every pull request in the stack, not just the bottom one. Checks run again when you rebase.

This action uses stack metadata so the jobs you gate run on the bottom of the remaining stack, and on the top if you leave that on. Mid-stack pull requests skip.

## Quick start

1. Trigger on all five `pull_request` types. GitHub's default omits `stacked` and `edited`. [Why those types](#pull_request-types)

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited, stacked]
```

2. Add a `gate` job that always runs. This job lists `pull-requests: read`. The restricted token default is only `contents` and `packages`.

```yaml
gate:
  runs-on: ubuntu-latest
  permissions:
    contents: read
    pull-requests: read
  outputs:
    should-run: ${{ steps.gate.outputs.should-run }}
  steps:
    - id: gate
      uses: raulgg/stack-ci-gate@v1
```

3. Skip mid-stack jobs:

```yaml
needs: gate
if: needs.gate.outputs.should-run == 'true'
```

## Usage

`@v1` tracks the latest 1.x. A version tag (`@v1.0.1`) or a commit SHA from the [Release](https://github.com/raulgg/stack-ci-gate/releases) stays on that tree. Do not pin `@main`.

```yaml
name: CI

on:
  pull_request:
    types: [opened, synchronize, reopened, edited, stacked]
  merge_group:

permissions:
  contents: read

jobs:
  gate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      should-run: ${{ steps.gate.outputs.should-run }}
    steps:
      - name: Gate stacked CI
        id: gate
        uses: raulgg/stack-ci-gate@v1
        with:
          bottom-n: 1
          run-top: true

  test:
    needs: gate
    if: needs.gate.outputs.should-run == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

The `gate` job lists its own `permissions`, so it keeps `contents: read` and `pull-requests: read` even if the workflow later grants write elsewhere. The example uses `pull_request`. `pull_request_target` would give this job the base repository token and secrets.

Jobs that should still run on every layer (lint, labeler) omit `needs: gate` and the `if:`.

Work that should run only on the remaining bottom, or only on the top, uses `is-bottom` or `is-top` in `if:`. Add those names to `jobs.gate.outputs` first, the same way as `should-run`.

## Inputs

| Name           | Default               | Purpose                                                                                                                          |
| -------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `bottom-n`     | `1`                   | How many PRs at the bottom of the **remaining** stack run CI.                                                                    |
| `run-top`      | `true`                | Also run CI on the top PR of the stack.                                                                                          |
| `github-token` | `${{ github.token }}` | Reads pull request and stack metadata. Needs `pull-requests: read`.                                                              |
| `pr-number`    | event PR              | Override PR number on `pull_request`. Loads stack from the API; ignores the triggering event's `stack`. Ignored on other events. |

## Outputs

All strings. Compare with `== 'true'` / `== 'false'`.

| Name         | Meaning                                                                               |
| ------------ | ------------------------------------------------------------------------------------- |
| `should-run` | `'true'` means the jobs or steps you gated should run.                                |
| `reason`     | Why, also printed in the gate job log.                                                |
| `is-stacked` | A stack object was resolved.                                                          |
| `is-bottom`  | This PR currently targets the stack base (`stack.base.ref == pull_request.base.ref`). |
| `is-top`     | `stack.position == stack.size`.                                                       |
| `position`   | Stack position, or empty.                                                             |
| `size`       | Stack size, or empty.                                                                 |

## How `should-run` is decided

| Condition                                                                                       | `should-run`                      |
| ----------------------------------------------------------------------------------------------- | --------------------------------- |
| Not a `pull_request` / `pull_request_target` event (`workflow_dispatch`, `merge_group`, `push`) | `true`                            |
| Error / API failure / unreadable stack                                                          | `true` (fail open)                |
| Invalid input for `bottom-n` or `run-top`                                                       | `true` (fail open; logs an error) |
| No stack after the event payload and API fallback                                               | `true` (standalone PR)            |
| Lowest unmerged, and remaining depth ≤ `bottom-n`                                               | `true`                            |
| Remaining depth ≤ `bottom-n`                                                                    | `true`                            |
| `run-top` and this PR is top                                                                    | `true`                            |
| Else (mid-stack, above `bottom-n`)                                                              | `false`                           |

Lowest unmerged is not `position == 1`. GitHub documents `position == 1` as the original bottom of the stack object, which can disagree with the remaining bottom after a partial merge. This action uses `stack.base.ref == pull_request.base.ref`. For `bottom-n > 1` it lists the stack via `GET /repos/{owner}/{repo}/stacks/{number}` and counts **open** PRs from the bottom.

A 1-PR stack is both lowest and top; `should-run` is true.

Network errors, unreadable payloads, invalid knobs, and unknown events run CI. The action never cancels the workflow run. It never skips `merge_group` (merge queue).

## `pull_request` types

A `types` list replaces GitHub's default. Bare `on: pull_request` runs only for `opened`, `synchronize`, and `reopened`. The example also names `edited` and `stacked`, which sit outside that default.

The action reads whichever event started the job. Leave a type off `on.pull_request.types` and GitHub never starts the workflow for that activity, so `should-run` is not recomputed.

| Type | When it fires | Why the example includes it |
| ---- | ------------- | --------------------------- |
| `opened` | The pull request is created | First run. Payload has no `stack`. |
| `synchronize` | New commits on the head branch | Pushes and rebases. Usually includes `stack`. |
| `reopened` | A closed pull request is reopened | Fetches and retries if `stack` is missing. |
| `edited` | Title, body, or base branch changed | Remaining-bottom retarget after a merge. |
| `stacked` | The pull request joins a stack | `gh stack link` recomputes `should-run`. |

`opened` never includes `stack`. On `opened` and `reopened`, if the payload has no `stack`, the action calls `GET /repos/{owner}/{repo}/pulls/{number}` and retries for a few seconds. If the pull request is still unstacked, it runs CI. That retry is what lets `gh stack submit` skip mid-stack on the first run. `stacked` runs again if the retry misses.

Include `stacked` so `gh stack link` on already-open pull requests recomputes `should-run`. If link changes a base, GitHub also sends `edited`. The action GETs once with no retry and skips mid-stack only if that fetch, or the payload, already has `stack`. Linking by branch name can also send `synchronize`. Omit `stacked` and, when the bases were already a chain, those layers keep the checks from when they were standalone.

## You might not need this action

GitHub already documents conditions for "lowest unmerged or top" in [Optimizing CI for stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests). On a job it looks like this:

```yaml
if: >
  github.event.pull_request.stack == null ||
  github.event.pull_request.stack.base.ref == github.event.pull_request.base.ref ||
  github.event.pull_request.stack.position == github.event.pull_request.stack.size
```

That expression covers lowest unmerged and top. It is enough if you have one workflow and accept a full run on `opened`. GitHub's snippets use `stack != null && …`. Copy that onto a test job and standalone pull requests skip.

This action skips mid-stack on `gh stack submit`. The `if:` above treats a missing `stack` as standalone, so every layer runs on `opened`.

## Required checks

A job skipped by `if:` reports **Success**. GitHub will merge a PR whose required check was skipped this way.

A skipped step also leaves its job **Success**, because the job ran. If a required check should mean that step ran, put the step in its own job and skip that job. Keep `needs: gate` on the job and omit the job-level `if:`, then skip only the steps that should not run on every layer:

```yaml
test:
  needs: gate
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: npm test
    - run: npm run e2e
      if: needs.gate.outputs.should-run == 'true'
```

The job still uses a runner, including `services:`. If no step in the job should run on a mid-stack pull request, skip the job instead.

Keep a `gate` job that always runs, and put `if:` on the jobs you gate. The workflow still starts, the job names are reported, and mid-stack pull requests stay mergeable.

You are trusting CI on the lowest unmerged pull request (it targets the stack base) and the top (the full set of changes). If every layer must be tested independently, do not skip those jobs.

A workflow that never starts (path filters, `[skip ci]`, workflow-level `if:`) leaves required checks **Pending** and blocks merge.

## Development

```bash
npm test
```

Zero runtime dependencies.

## License

[MIT](LICENSE)

Inspired by [Graphite CI](https://github.com/withgraphite/graphite-ci-action).
