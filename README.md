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

Pin a major tag (`@v1` in these examples). It moves with compatible releases. A version tag or a SHA from [Releases](https://github.com/raulgg/stack-ci-gate/releases) stays put. Do not pin `@main`.

The example adds `merge_group` for a merge queue (`should-run` is `'true'` on that event). The gate job lists `contents: read` and `pull-requests: read` so they stay if the workflow later grants write elsewhere. Use `pull_request`. `pull_request_target` would give this job the base repository token and secrets.

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
      - id: gate
        uses: raulgg/stack-ci-gate@v1

  test:
    needs: gate
    if: needs.gate.outputs.should-run == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

Jobs that should still run on every layer (lint, labeler) omit `needs: gate` and the `if:`.

### Inputs

| Name           | Default               | Purpose                                                                 |
| -------------- | --------------------- | ----------------------------------------------------------------------- |
| `bottom-n`     | `1`                   | How many PRs at the remaining bottom always run.                        |
| `run-top`      | `true`                | Also run the top PR (the full set of changes).                          |
| `github-token` | `${{ github.token }}` | Reads stack membership. Needs `pull-requests: read` on the gate job.    |
| `pr-number`    | event PR              | Override which PR to gate on `pull_request`. Leave unset in the recipe. |

### Outputs

All strings. Compare with `== 'true'` / `== 'false'`. Gate jobs with `should-run`. Use `is-bottom` or `is-top` when a job should run only there; add those names to `jobs.gate.outputs` first.

| Name         | Meaning                                      |
| ------------ | -------------------------------------------- |
| `should-run` | `'true'` if the jobs you gated should run.   |
| `reason`     | Why, also in the gate job log.               |
| `is-stacked` | This PR is in a stack.                       |
| `is-bottom`  | Remaining bottom (base is the stack base).   |
| `is-top`     | Top of the stack.                            |
| `position`   | Stack position, or empty.                    |
| `size`       | Stack size, or empty.                        |

### How `should-run` is decided

| When                                                                              | `should-run` |
| --------------------------------------------------------------------------------- | ------------ |
| Standalone PR, `merge_group`, `push`, `workflow_dispatch`                         | `'true'`     |
| Remaining bottom (up to `bottom-n` open PRs from the current bottom)              | `'true'`     |
| Top of the stack, if `run-top` is true                                            | `'true'`     |
| Mid-stack, above `bottom-n`                                                       | `'false'`    |
| Error, bad knobs, or unreadable stack                                             | `'true'`     |

Remaining bottom is the PR whose base is the stack base. After a partial merge that is not `position == 1`. A 1-PR stack is both bottom and top.

The action never cancels the run. `merge_group` always runs.

### `pull_request` types

The gate job only runs when the workflow starts. List every type this action needs:

| Type | Why this action needs it |
| ---- | ------------------------ |
| `opened` | First run, including `gh stack submit`. |
| `synchronize` | Pushes and rebases. |
| `reopened` | The PR is opened again. |
| `edited` | After a bottom merge, the next PR is retargeted at the stack base. That remaining bottom needs a run. |
| `stacked` | `gh stack link` on PRs that already existed. |

GitHub's default is `opened`, `synchronize`, `reopened`. Without `edited`, a remaining-bottom retarget never starts the gate. Without `stacked`, linking already-open PRs never starts it.

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
