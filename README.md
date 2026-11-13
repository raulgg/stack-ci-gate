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

1. Trigger on `opened`, `synchronize`, `reopened`, and `edited`. GitHub's default omits `edited`. Add `labeled` only if you use the force-run label. [Why those types](#pull_request-types)

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
      # A crash before the gate decides leaves should-run empty, and the jobs below run.
      continue-on-error: true
```

3. Skip mid-stack jobs:

```yaml
needs: gate
if: ${{ !cancelled() && needs.gate.outputs.should-run != 'false' }}
```

The gate writes only `'true'` or `'false'`. If the gate job fails or is skipped, `should-run` is empty and the job runs. `!cancelled()` is what lets it run after a failed gate job. See [What fails open](#what-fails-open) for the exceptions.

Do not add job-level `if:` filters on events to the gate job or to required jobs. [A skipped run can replace a failure](#a-skipped-run-can-replace-a-failure)

Gated jobs start after the gate decides: a few seconds, or up to `stack-wait-seconds` (default 40) on `opened` and `reopened`. See [Waiting for the stack](#waiting-for-the-stack-on-opened).

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
        # A crash before the gate decides leaves should-run empty, and the jobs below run.
        continue-on-error: true

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

Only gated jobs need the gate. Jobs that run on every layer, such as `lint` or labeler, omit `needs: gate` and the `if:`, and start at once.

With `!cancelled()`, a job also runs when another job in its `needs` failed. When a gated job needs other jobs too, add `&& needs.<other>.result == 'success'` for each of them. This checks direct needs only. If a job further up the chain can fail while a direct need still succeeds, add that job to `needs` and check it too.

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

All outputs are strings. Gate jobs with `should-run != 'false'`, so an empty output still runs them. Compare the other outputs with `== 'true'` or `== 'false'`. Use `is-bottom` or `is-top` when a job should run only there, and add those names to `jobs.gate.outputs` first. A job gated on `is-bottom == 'true'` or `is-top == 'true'` still skips when the gate fails, because neither is `'true'` then.

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

The gate job only runs when the workflow starts. The recipe lists GitHub's default (`opened`, `synchronize`, `reopened`) plus `edited`. `labeled` is opt-in, and `stacked` is optional.

| Type | Recipe | What it covers | If you leave it out |
| ---- | ------ | -------------- | ------------------- |
| `opened` | Required | First run, including `gh stack submit`. | No first run. |
| `synchronize` | Required | Pushes and rebases, including the cascade rebase after a bottom merge. | No run on new commits. |
| `reopened` | Required | The PR is opened again. | A reopened PR has no run until the next push. |
| `edited` | Recommended | Base changes with no push. Also every title and body edit. | A retarget with no rebase leaves the remaining bottom with only its mid-stack result. [Details](#why-edited-stays-unfiltered) |
| `stacked` | Optional | A PR added to a stack. | Almost nothing. A PR whose `opened` run never started has no run until the next push or edit. If its check is required, it stays Pending and blocks merging until then. |
| `labeled` | Opt-in | Any added label. [Force-run](#force-run-without-a-push) | Nothing. The label forces a run on the next push or edit. |

`stacked` almost never adds coverage:

- In a week of data from one repo, 30 of 31 `stacked` runs repeated a head SHA that `opened` or `synchronize` had already tested.
- A PR whose stack is not linked within `stack-wait-seconds` of opening fails open on `opened` and runs in full.
- `github.event.pull_request.stack` is on every `pull_request` event of a PR that is in a stack at that moment, so `stacked` is not needed to read it.
- actionlint 1.7.12 reports `stacked` as an invalid activity type. It is in the [webhook reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request), but not on the Actions [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request) page.

### Why `edited` stays unfiltered

After a bottom merge, GitHub retargets the next PR at the stack base, which fires `edited`, and usually rebases the rest of the stack, which fires `synchronize`. In a test on 2026-11-12, squash, rebase and merge-commit merges, with delete-branch-on-merge both on and off, each did both within a few seconds.

`edited` is the only run when a base change comes with no push:

- The cascade rebase does not happen and the PR has no merge conflict. The stack gets a **Rebase stack** button instead.
- Someone changes the base by hand (`gh pr edit --base`, or the UI). That includes PR chains outside GitHub stacks, which get no cascade rebase.

Without `edited`, the remaining bottom then keeps only its mid-stack result. Its gated checks show Skipped, and a Skipped required check counts as passing. See [A skipped run can replace a failure](#a-skipped-run-can-replace-a-failure).

It does not help while the PR has a merge conflict. No workflow runs until the conflict is resolved, and that push fires `synchronize`. In a merge queue, the `merge_group` run always runs gated jobs.

Every edit, including title and body edits, reruns CI. On a standalone, bottom or top PR that is full CI. On a mid-stack PR it is the gate and the jobs that run on every layer. Bots that rewrite PR bodies count too. In a week of data from one repo, `edited` started 84 runs that billed 564 minutes, and 66 of those runs were title or body edits.

Do not filter title and body edits with a job-level `if:`. The filtered run still reports its jobs, as Skipped, and a Skipped required job replaces an earlier failure on the same commit. [A skipped run can replace a failure](#a-skipped-run-can-replace-a-failure)

### Force-run without a push

Add `labeled` only if you want the force-run label to start a run without a push. Without `labeled`, the label takes effect on the next push or edit. With it, any added label reruns CI. Do not filter other labels with a job-level `if:`, for the same reason as `edited`. Labels added with `GITHUB_TOKEN` never start runs. Labels added by apps or PATs do.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited, labeled]
```

### See a result without a push: `workflow_dispatch`

**A dispatched run never satisfies or clears a required check** ([GitHub docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated)). Use it only to see a result. In a test on 2026-11-12, a dispatched `test` Success on the PR head left a PR whose `pull_request` `test` had failed BLOCKED.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

- It works only once the workflow is on the default branch.
- It tests the branch head, not the merge ref.
- Gated jobs run in full, because the gate fails open off `pull_request`.
- Key the concurrency group as above. A key on `github.head_ref || github.ref_name` is shared with pull request runs, so a dispatch can cancel the run your required check needs.
- `cancel-in-progress` is safe: no run is a filtered no-op, so the newer run always reports the gate's decision for the PR's current place in the stack.

### Waiting for the stack on `opened`

`gh stack submit` opens every PR first and links them into a stack a few seconds later. So on `opened`, the gate can't see the stack yet. On `opened` and `reopened` it checks again about every 5 seconds, for up to `stack-wait-seconds` (default 40). Other events decide in a few seconds.

**No wait.** With `bottom-n` of 1 or more (the default), these PRs are decided at once, because they run CI either way:

- A PR into the default branch.
- A PR whose base branch no open PR comes from, so nothing can be stacked below it. Checking this costs one API request.

A stack opened top-first by hand also decides at once, so every PR in it runs CI on `opened`.

The bottom PR of a new stack is usually one of these. Its `opened` run reports `is-stacked` as `'false'`, with empty `position` and `size`. Later events, such as `synchronize`, `edited` or `stacked`, report its place in the stack.

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

- A retarget with no push starts only an `edited` run. If you leave `edited` out and the cascade rebase does not happen, the remaining bottom has no run on its new base. A push or `gh stack rebase` starts a `pull_request` run. Run workflow (`workflow_dispatch`) does not satisfy a required check ([GitHub docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated)). See [`workflow_dispatch`](#see-a-result-without-a-push-workflow_dispatch).
- Workflows do not run on `pull_request` activity while the PR has a merge conflict ([Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)). See [Why `edited` stays unfiltered](#why-edited-stays-unfiltered).
- `pull_request` runs test the merge ref. The same head SHA can test a different tree after the base moves.
- Path filters on a stacked PR compare against the stack base, as if the PR targets it.
- A bottom merge done with `GITHUB_TOKEN`, such as `gh stack merge` in a workflow, retargets the next PR but does not rebase it, and starts no `edited` or `synchronize` run. In a live test, that PR kept its mid-stack results, with the gated job Skipped, and GitHub showed it as mergeable. Merge the bottom with a user token instead, or push to the next PR (`gh stack rebase`) after the merge.
- Unverified: a mid-stack PR removed from its stack with `gh stack unstack` may keep its Skipped checks with no new run. The webhook reference has no `unstacked` action.

## You might not need this action

GitHub documents conditions for "lowest unmerged or top" in [Optimizing CI for stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests). On a job it looks like this:

```yaml
if: >
  github.event.pull_request.stack == null ||
  github.event.pull_request.stack.base.ref == github.event.pull_request.base.ref ||
  github.event.pull_request.stack.position == github.event.pull_request.stack.size
```

That expression covers lowest unmerged and top. It is enough when you have one workflow and accept a full run on `opened`. GitHub's snippets use `stack != null && …`. Copying that onto a test job skips standalone pull requests.

This action skips mid-stack on `gh stack submit` when the stack is linked within `stack-wait-seconds` (default 40) of `opened`. With `bottom-n` of 1 or more, a PR into the default branch is decided at once. A submit that links later than the wait runs those PRs in full (safe, just costly). The `if:` above treats a missing `stack` as standalone, so every layer runs on `opened`.

## Required checks

A job skipped by `if:` reports **Success**. GitHub will merge a PR whose required check was skipped this way.

A skipped step also leaves its job **Success**, because the job ran. If a required check should mean that step ran, put the step in its own job and skip that job. Keep `needs: gate` on the job, and give the job `if: ${{ !cancelled() }}`. Then skip only the steps that should not run on every layer:

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

### A skipped run can replace a failure

A later run that skips a required job on the same commit replaces an earlier **Failure** for that check, and a failing PR can become mergeable.

This was tested live. With `test` required, a PR had `test` Failure and was blocked. A title edit started a run whose job-level `if:` skipped the gate job, `test` reported Skipped, and GitHub reported the PR mergeable.

- **Do not** add job-level `if:` filters on events (title or body edits, labels, drafts) to the gate job or to required jobs of a gated workflow.
- **Do instead** filter optional types (`labeled`, `stacked`, draft types) with `on:` types, so the event starts no run. `edited` is the exception: keep it, remove the filter, and accept the reruns.

Mid-stack Skipped checks are by design.

The same mechanism means a PR that failed CI and later became mid-stack on the same commit shows its gated checks as Skipped until it becomes the remaining bottom or the top again.

### What fails open

The recipe runs gated jobs when the gate fails. Two parts cover two different failures:

- `continue-on-error: true` on the gate step covers a failed gate step: an error inside the action, or a failed output write. The step's conclusion is Success, so the gate job succeeds with `should-run` empty, and `!= 'false'` runs the gated jobs.
- `!cancelled()` on the jobs that need the gate covers a gate job that fails outside its step: the action fails to download during job setup, the runner is lost, or an earlier step such as checkout fails. `should-run` is then empty, and `!= 'false'` runs the job. When the gate job times out, GitHub reports it as cancelled, but the run is not cancelled, so `!cancelled()` stays true and the gated jobs run (tested live). Without a status function, GitHub skips the jobs that need a failed job, and a job skipped because a needed job failed [may not block merging](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks).

A skipped gate job also leaves `should-run` empty, so the gated jobs run.

Not covered: a cancelled run, a workflow that never starts, and jobs gated on `is-bottom == 'true'` or `is-top == 'true'`. A cancelled run reports its gated jobs as Cancelled, which does not pass a required check, so the PR stays blocked until a new run (tested live). A gate that already wrote `'false'` before its step failed still skips the gated jobs.

Requiring the `gate` job as a check is optional extra protection. A failed gate job then blocks the merge even if a gated job is not required. Before you require it:

- Required check names must be unique across workflows. With a `gate` job in two workflows, give each job its own `name:`. See [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
- A workflow with `paths:` filters does not start for some pull requests, and a required `gate` from it stays Pending and blocks the PR.
- In a repo with a merge queue, the workflow needs `merge_group`, or a required `gate` stays Pending in the queue.

### One-job layout

When the gate is a step in the job it gates, give the step `id: gate` and check that step's output. With `continue-on-error: true` the step's conclusion is Success, so the gated steps need no status function.

```yaml
test:
  runs-on: ubuntu-latest
  permissions:
    contents: read
    pull-requests: read
  steps:
    - uses: actions/checkout@v4
    - run: npm run lint
    - id: gate
      uses: raulgg/stack-ci-gate@v1
      continue-on-error: true
    - run: npm test
      if: steps.gate.outputs.should-run != 'false'
```

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
