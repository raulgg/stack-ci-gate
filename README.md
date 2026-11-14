<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/stack-ci-gate-action-dark.png">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/stack-ci-gate-action-light.png">
  <img alt="Stack CI Gate" src=".github/assets/stack-ci-gate-action-light.png">
</picture>

# Stack CI Gate

[![Test](https://github.com/raulgg/stack-ci-gate/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/raulgg/stack-ci-gate/actions/workflows/test.yml?query=branch%3Amain)
[![Marketplace](https://img.shields.io/badge/Marketplace-v1-blue)](https://github.com/marketplace/actions/stack-ci-gate)
[![Release](https://img.shields.io/github/v/release/raulgg/stack-ci-gate)](https://github.com/raulgg/stack-ci-gate/releases/latest)
[![License: MIT](https://img.shields.io/github/license/raulgg/stack-ci-gate)](LICENSE)

This GitHub Action is a CI gate to optimize GitHub stacked PRs (gh stack). It skips redundant CI on [GitHub's stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs). GitHub Actions still run as if each pull request targets the stack base, so a workflow for `main` runs for every pull request in the stack. Checks run again when you rebase.

This action uses stack metadata so the jobs you gate run on the bottom of the remaining stack, and on the top if you leave that on. Mid-stack pull requests skip those jobs.

## Quick start

1. Trigger on these four `pull_request` types. GitHub's default omits `edited`. [Why those types](#pull_request-types)

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
```

2. Add a `gate` job that always runs and lists `pull-requests: read`. The restricted token default is only `contents` and `packages`.

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
      continue-on-error: true # if the gate breaks, jobs still run
```

3. Skip mid-stack jobs:

```yaml
needs: gate
if: ${{ !cancelled() && needs.gate.outputs.should-run != 'false' }}
```

If the gate fails, `should-run` is empty and the job runs.

### Have an agent set this up for you

Open your repo in a coding agent and send the prompt below. It sets up the gate and installs the skill.

```text
Gate the pull_request workflows in this repo. Follow https://github.com/raulgg/stack-ci-gate/blob/main/README.md and keep their triggers, filters, permissions, and jobs.
From recent Actions run times, gate long work so a bottom run and a top run are enough. Skip a step when the rest of its job should still run.
Install the skill: `npx skills add raulgg/stack-ci-gate -y`
Summarize what you gated, what still runs on every layer, and which mid-stack checks report Success without running.
```

## Usage

Pin a major tag (`@v1` in these examples). It moves with compatible releases. A version tag or a SHA from [Releases](https://github.com/raulgg/stack-ci-gate/releases) stays put. Do not pin `@main`.

The example adds `merge_group` for a merge queue. On that event, `should-run` is `'true'`. The gate job lists `contents: read` and `pull-requests: read` so those permissions stay if the workflow later grants write elsewhere. Use `pull_request`. `pull_request_target` would give this job the base repository token and secrets.

```yaml
name: CI

on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
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
        continue-on-error: true # if the gate breaks, jobs still run

  test:
    needs: gate
    if: ${{ !cancelled() && needs.gate.outputs.should-run != 'false' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run lint
```

Jobs that run on every layer, such as `lint`, omit `needs: gate` and the `if:`.

With `!cancelled()`, a job also runs when another job in its `needs` failed. If a gated job needs other jobs, add `&& needs.<other>.result == 'success'` for each.

To gate steps inside one job, add the gate as a step with `continue-on-error: true`, and put `if: steps.gate.outputs.should-run != 'false'` on those steps.

### Inputs

| Name                 | Default               | Purpose                                                                                     |
| -------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `bottom-n`           | `1`                   | How many PRs at the remaining bottom always run.                                            |
| `run-top`            | `true`                | Also run the top PR (the full set of changes).                                              |
| `force-run-label`    | `stack-ci:run`        | Label that forces a mid-stack run. Create it in the repo. Empty disables.                   |
| `stack-wait-seconds` | `40`                  | Seconds to wait for the stack on `opened` and `reopened` when another open PR could sit below this one. 0 to 100. See [Waiting for the stack](#waiting-for-the-stack-on-opened). |
| `github-token`       | `${{ github.token }}` | Reads stack membership. Needs `pull-requests: read` on the gate job.                        |
| `pr-number`          | event PR              | Override which PR to gate on `pull_request`. Leave unset in the recipe.                     |

### Outputs

All outputs are strings. Gate jobs with `should-run != 'false'`. Compare the other outputs with `== 'true'` or `== 'false'`. Use `is-bottom` or `is-top` when a job should run only there, and add those names to `jobs.gate.outputs` first. Those jobs skip when the gate fails.

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
| Mid-stack, above `bottom-n`, with the force-run label                             | `'true'`     |
| Mid-stack, above `bottom-n`, without the force-run label                          | `'false'`    |
| Error, bad knobs, or unreadable stack                                             | `'true'`     |

Remaining bottom is the PR whose base is the stack base. After a partial merge, remaining bottom is not `position == 1`. A 1-PR stack is both bottom and top.

The label stays until someone removes it, and it can only turn a skip into a run.

The action never cancels the run. `merge_group` always runs.

### `pull_request` types

The gate job only runs when the workflow starts. List every type this action needs:

| Type | Why this action needs it |
| ---- | ------------------------ |
| `opened` | First run, including `gh stack submit`. |
| `synchronize` | Pushes and rebases. |
| `reopened` | The PR is opened again. |
| `edited` | After a bottom merge, the next PR is retargeted at the stack base. That remaining bottom needs a run. |

GitHub's default is `opened`, `synchronize`, `reopened`. Without `edited`, a remaining-bottom retarget never starts the gate. With it, every title or body edit also starts a run. Do not filter those with a job-level `if:` (see [Required checks](#required-checks)).

Two more types are optional:

- `labeled` starts a force-run without a push. Any added label starts a run. Only the force-run label turns a skip into a run. A workflow that leaves out `labeled` still force-runs on the next push or edit while the label is on the pull request.
- `stacked` starts a run on `gh stack link` for PRs that already existed. `opened` or `synchronize` has almost always tested that commit already.

### Waiting for the stack on `opened`

`gh stack submit` opens every PR first and links them into a stack a few seconds later. So on `opened`, the gate can't see the stack yet. On `opened` and `reopened` it checks again about every 5 seconds, for up to `stack-wait-seconds` (default 40). Other events decide in a few seconds.

**No wait.** With `bottom-n` of 1 or more (the default), these PRs are decided at once, because they run CI either way:

- A PR into the default branch.
- A PR whose base branch no open PR comes from, so nothing can be stacked below it. Checking this costs one API request.

A stack opened top-first by hand also decides at once, so every PR in it runs CI on `opened`.

The bottom PR of a new stack is usually one of these. Its `opened` run reports `is-stacked` as `'false'`, with empty `position` and `size`. Later events report its place in the stack.

**Full wait, then CI runs.** These PRs wait the full `stack-wait-seconds`, so their gated jobs start that much later:

- A chain of PRs outside a GitHub stack, opened bottom-first.
- A PR into a long-lived branch that has its own open PR, such as `develop` with an open `develop` → `main` PR.

**With `bottom-n: 0`, every PR waits.** The bottom PR should skip too, and on `opened` it looks just like a standalone PR. So a standalone PR waits the full time before it runs. The bottom PR of an N-PR submit waits longest, about 4.5 × N − 7.5 seconds, so 40 covers about 10 PRs.

**Picking a value.** In a test, `gh stack submit` opened PRs about 4.5 seconds apart. The second PR of an N-PR submit needed about 4.5 × N − 12 seconds of wait. Both formulas count the wait from the gate's first check, about 5 seconds after the PR opens.

| `stack-wait-seconds` | When to use it |
| -------------------- | -------------- |
| `0` | Your repo doesn't use `gh stack submit`. |
| `6` | You want 1.1.0's wait. |
| `40` (default) | Covers a submit of about 11 PRs. |
| `100` (maximum) | Covers a submit of about 25 PRs. |

In a bigger submit than the wait covers, the lowest mid-stack PRs run CI.

**What the wait costs.**

- A separate gate job takes about the wait plus 5 seconds. Up to a wait of about 50 seconds, that's 1 billed minute.
- A wait above about 50 seconds makes it 2 billed minutes. Only PRs that wait the full time pay it: the lowest mid-stack PRs of a large submit, and the full-wait cases above.
- In a one-job layout the wait runs in a job that runs anyway, so there's no gate job to pay for. Put the gate step after the steps that run on every layer.

## Known gaps

- No `pull_request` run starts while the PR has a merge conflict. Resolve it and push.
- A `workflow_dispatch` run [does not satisfy a required check](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated). Push or run `gh stack rebase` instead.
- A bottom merge made with `GITHUB_TOKEN`, such as `gh stack merge` in a workflow, starts no run on the next PR. That PR keeps its Skipped checks and looks mergeable (tested live). Merge with a user token, or run `gh stack rebase` after the merge.
- Path filters on a stacked PR compare against the stack base.

## You might not need this action

GitHub documents conditions for "lowest unmerged or top" in [Optimizing CI for stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests). On a job it looks like this:

```yaml
if: >
  github.event.pull_request.stack == null ||
  github.event.pull_request.stack.base.ref == github.event.pull_request.base.ref ||
  github.event.pull_request.stack.position == github.event.pull_request.stack.size
```

That expression covers lowest unmerged and top. It is enough when you have one workflow and accept a full run on `opened`. GitHub's snippets use `stack != null && …`. Copying that onto a test job skips standalone pull requests.

This action skips mid-stack on `gh stack submit`. The `if:` above treats a missing `stack` as standalone, so every layer runs on `opened`.

## Required checks

A job skipped by `if:` reports **Success**. GitHub will merge a PR whose required check was skipped this way.

A skipped step also leaves its job **Success**, because the job ran. If a required check should mean that step ran, put the step in its own job and skip that job. Keep `needs: gate` on the job, with `if: ${{ !cancelled() }}`. Then skip only the steps that should not run on every layer:

```yaml
test:
  needs: gate
  if: ${{ !cancelled() }}
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: npm test
    - run: npm run e2e
      if: needs.gate.outputs.should-run != 'false'
```

The job still uses a runner, including `services:`. If no step in the job should run on a mid-stack pull request, skip the job instead.

Keep a `gate` job that always runs, and put `if:` on the jobs you gate. The workflow still starts, the job names are reported, and mid-stack pull requests stay mergeable.

You are trusting CI on the lowest unmerged pull request, which targets the stack base, and the top, which is the full set of changes. If every layer must be tested independently, do not skip those jobs.

A workflow that never starts (path filters, `[skip ci]`, workflow-level `if:`) leaves required checks **Pending** and blocks merge.

Do not filter events (title edits, labels, drafts) with a job-level `if:` on the gate job or on a required job. A run that skips a required job replaces an earlier **Failure** on the same commit, and the failing PR becomes mergeable. Remove the type from `on:` instead, except `edited`: keep it and accept the reruns.

## Install the skill

The skill is optional. Install it at project level, or globally, and an agent will set up this action when you use stacks. The jobs you gate run on the bottom of the remaining stack and on the top. On a smaller edit, or when you create, submit, link, rebase, or restack, the agent reminds you once. If it edits a workflow, it leaves that edit uncommitted.

```bash
npx skills add raulgg/stack-ci-gate
```

The command above installs the skill at project level. Add `-g` to install it globally (user-level) instead of project-level: `npx skills add raulgg/stack-ci-gate -g`.

## License

[MIT](LICENSE)

---

<sub>Inspired by [Graphite CI](https://github.com/withgraphite/graphite-ci-action).</sub>
