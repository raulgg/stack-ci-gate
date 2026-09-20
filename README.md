# Stack CI Gate

[Stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs) are a chain of smaller, independently reviewable layers. GitHub Actions still runs as if each pull request targets the **stack base**, so a workflow for `main` runs for every pull request in the stack, not just the bottom one. A large stack multiplies CI usage. Checks run again when you rebase, including after you change a [lower layer](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests#making-changes-to-a-lower-layer) and rebase the branches above it (`gh stack rebase --upstack`).

This action uses [stack metadata](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests) so those extra runs happen only where they are needed. You choose how many pull requests at the bottom of the remaining stack always run CI, and whether the **top** pull request (the full set of changes) runs as well. Mid-stack pull requests skip the jobs you gate: jobs that do not need to run on every layer after a lower-layer change or a cascading rebase.

Add a `gate` job, read `should-run`, and only run those jobs when `needs.gate.outputs.should-run == 'true'`. The action reads `github.event.pull_request.stack`, and the Pulls REST API when that field is missing (`opened` never includes `stack`).

## Usage

The example pins `@v1`. That tag is the latest 1.x and moves when a new 1.x is tagged. A commit SHA stays on that tree: `raulgg/stack-ci-gate@dc6d1ab44cd57a67eea8049697cece1274a8b30f` (`v1.0.0`). Do not pin `@main`. User-facing changes are in [CHANGELOG.md](CHANGELOG.md). How to cut a version is in [RELEASING.md](RELEASING.md).

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

Add `needs: gate` and the `if:` to each job that should not run on every pull request in the stack. Jobs that should still run on every layer (lint, labeler) omit both.

The same `if:` works on a step. Keep `needs: gate` on the job and omit the job-level `if:`, then skip only the steps that should not run on every layer:

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

Work that should run only on the remaining bottom, or only on the top, uses `is-bottom` or `is-top` in `if:`. Add those names to `jobs.gate.outputs` first, the same way as `should-run`.

`stacked` is the webhook GitHub fires when a PR joins a stack. Keep it in `types` so `should-run` is re-evaluated when that happens. The action also fetches stack membership on `opened`, so a just-created stack is still gated correctly if `stacked` is not delivered.

## Inputs

| Name           | Default               | Purpose                                                                                                                                                  |
| -------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bottom-n`     | `1`                   | How many PRs at the bottom of the **remaining** stack run CI.                                                                                            |
| `run-top`      | `true`                | Also run CI on the top PR of the stack.                                                                                                                  |
| `github-token` | `${{ github.token }}` | Reads pull request and stack metadata. Needs `pull-requests: read`. `${{ github.token }}` expires when the job ends.                                     |
| `pr-number`    | event PR              | Override PR number on `pull_request`. Loads stack from the API; ignores the triggering event’s `stack`. Ignored on other events.                         |

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

`should-run = true` means the jobs you gated should run.

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

Lowest unmerged is **not** `position == 1`. GitHub documents `position == 1` as the original bottom of the stack object, which can disagree with the remaining bottom after a partial merge. This action uses `stack.base.ref == pull_request.base.ref`. For `bottom-n > 1` it lists the stack via `GET /repos/{owner}/{repo}/stacks/{number}` and counts **open** PRs from the bottom.

A 1-PR stack is both lowest and top; `should-run` is true.

## `opened` vs `stacked`

GitHub creates a pull request, then adds it to a stack. `pull_request.opened` never includes `stack`. Default `on: pull_request` only runs for `opened`, `synchronize`, and `reopened`.

If the action treated a missing stack as a standalone PR, `gh stack submit` would run the gated jobs on every layer.

When the event has no `stack`, the action calls `GET /repos/{owner}/{repo}/pulls/{number}`. On `opened` and `reopened` it retries for a few seconds so a just-created stack is visible. If the PR is still not in a stack, it runs CI (standalone).

## You might not need this action

GitHub already documents conditions for "lowest unmerged or top" in [Optimizing CI for stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests). Their examples put `if:` on a step after checkout. On a job it looks like this:

```yaml
if: >
  github.event.pull_request.stack == null ||
  github.event.pull_request.stack.base.ref == github.event.pull_request.base.ref ||
  github.event.pull_request.stack.position == github.event.pull_request.stack.size
```

That expression covers lowest unmerged and top. It is enough if you have one workflow and accept a full run on `opened`. `pull_request.opened` never includes `stack`. GitHub's snippets use `stack != null && …`. Copy that onto a test job and standalone pull requests skip.

The action is simpler in every case. Each gated job uses `needs: gate` and `if: needs.gate.outputs.should-run == 'true'`. The action fail-opens on errors and never skips `merge_group`, even with one test job.

It skips mid-stack on `gh stack submit`. The `if:` above treats a missing `stack` as standalone, so every layer runs on `opened`. Set `bottom-n` and `run-top` on the gate job. `bottom-n` counts remaining open PRs from the current bottom. GitHub's `position` is the original index, so `position <= 2` is wrong after a partial merge.

## Required checks

A job skipped by `if:` reports **Success**. GitHub will merge a PR whose required check was skipped this way.

A skipped step also leaves its job **Success**, because the job ran. If a required check should mean that step ran, put the step in its own job and skip that job.

That is why a `gate` job that always runs, plus `if:` on the jobs you gate, works: the workflow still starts, the job names are reported, and mid-stack pull requests stay mergeable.

Those jobs did not run on the mid-stack pull requests. You are trusting CI on the **lowest unmerged** pull request (it targets the stack base) and the **top** (the full set of changes). If every layer must be tested independently, do not skip those jobs.

A **workflow** that never starts (path filters, `[skip ci]`, workflow-level `if:`) leaves required checks **Pending** and blocks merge. Do not skip the whole workflow.

## Fail open

Network errors, unreadable payloads, invalid knobs, and unknown events run CI. The action never cancels the workflow run. It never skips `merge_group` (merge queue).

## Development

```bash
npm test
```

Zero runtime dependencies. The action is plain Node 24 ESM (`src/gate.mjs`).

---

Inspired by [Graphite CI](https://github.com/withgraphite/graphite-ci-action).
