---
name: stack-ci-gate
description: Gate CI for a GitHub pull request stack. Use when creating or editing GitHub Actions workflows, when creating, submitting, linking, rebasing, or restacking a GitHub stack, or when the user asks to set up the gate.
---

# Stack CI Gate

Pick the first matching case. Change the gate only in the files that case allows, and leave workflow edits uncommitted.

## 1. Pick the case

1. Asked. The user named this skill, asked to set up the gate, or agreed to a suggestion already made in this conversation.
2. Rewrite. This task creates a workflow file. It is also Rewrite when the task adds or replaces more than half the jobs in one resulting workflow file, or more than half the steps. Count steps across that file.
3. Suggest. This task creates, submits, links, rebases, or restacks a GitHub stack. Editing a workflow is Suggest as well, unless the edit is already Rewrite. A pin, a name, a comment, an action version, one job, or one step is Suggest.
4. Stop. Any other task.

Stop ends the skill, and the reply does not mention this gate. Asked, Rewrite, and Suggest continue at step 2.

## 2. Decide whether a stack counts

```bash
gh api --paginate "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/stacks"
```

A stack counts when any listed stack is `open: true`. A closed stack counts when its latest `pull_requests[].merged_at` is within 90 days. If every `merged_at` is null, compare that stack's `created_at` with the same 90 days. This task also counts when it just closed the last stack and the command returns an empty list. A failed command does not count.

Note whether a stack counts. Keep the stack number and the date you used, or keep a note that this task just closed the last stack.

If the case is Asked and no stack counts, stop after one sentence. Say that no listed stack counts, or that the stacks command failed, and do not edit a workflow.

If the case is Rewrite or Suggest and no stack counts, make the workflow edit this task asked for, then stop. Do not mention this gate.

If a stack counts, go to step 3.

## 3. Classify the workflows

GitHub runs workflow files only from `.github/workflows` in this repository. Read every file there.

A pull request workflow has `pull_request` in `on`: a key under `on`, a bare `on: pull_request`, or an item in a list such as `on: [push, pull_request]`. A file that only has `pull_request_target` is not a pull request workflow.

A pull request workflow is gated when a step uses `raulgg/stack-ci-gate` at any ref and another job or step compares that job's `should-run` to `'true'` with `==` or to `'false'` with `!=`. When the root `action.yml` has `name: Stack CI Gate`, `uses: ./` counts as this action. Treat a comment as ungated, and treat a gate job the same way when no other job or step checks it.

A gated pull request workflow is outdated when any job or step compares `should-run` with `== 'true'`, when the gate step has no `continue-on-error: true`, when a job that lists the gate job in `needs` has an `if` without `!cancelled()`, or when the gate job or a job that lists it in `needs` has a job-level `if` that filters on the event, such as `github.event.action`, `github.event.changes`, `github.event.label`, or `github.event.pull_request.draft`. In a one-job layout, where the gate is a step in the job it gates, only the first two apply, plus an event filter on that job.

Mark each file as a gated pull request workflow, an outdated gated pull request workflow, an ungated pull request workflow, or neither. On Suggest, an outdated workflow counts as gated.

On Suggest, when every pull request workflow is already gated, or the repo has none, make the workflow edit this task asked for, then stop. Do not mention this gate.

Asked and Rewrite continue to step 4. Suggest continues when an ungated pull request workflow remains.

## 4. Act

Asked. Run Apply the gate on the ungated and outdated pull request workflows in scope. If the user named workflow files, those files are the scope. If they named none and are agreeing to a suggestion, the scope is the files that suggestion named. If they named no file and are not answering a suggestion, the scope is every ungated or outdated pull request workflow. Leave the gate off a named file that is not a pull request workflow, and say so in the reply.

Stop when each file you edited matches the done check under Apply the gate. When no file in scope needs the gate, or the repo has no pull request workflow, reply with one sentence that names the files already gated, or says that the repo has no pull request workflow.

Rewrite. Make the workflow edit this task asked for. For the gate, edit only that workflow. When it is an ungated or outdated pull request workflow, run Apply the gate on it. When it is not a pull request workflow, leave the gate off.

When another ungated pull request workflow remains, and this conversation has not already asked, name each one in the same reply and ask whether to gate it too. Leave those files unchanged.

Stop when the file this task is creating or rewriting is saved with this task's edits. When that file is a pull request workflow, it also matches the done check under Apply the gate. Any ask names each other ungated pull request workflow.

Suggest. Make the workflow edit this task asked for. If this conversation has already asked, do not mention this gate. If it has not, name each ungated pull request workflow and ask whether to gate them. Stop when that edit is saved. When you ask, the reply names each ungated pull request workflow.

## Apply the gate

Asked and Rewrite run this on each pull request workflow they gate.

If `pull_request` has no `types` list, set it to `opened`, `synchronize`, `reopened`, `edited`, `stacked`, and `labeled`. If it has a list, add any of those six that are missing. Keep every other trigger, type, branch filter, and path filter.

`labeled` lets a `stack-ci:run` label force a mid-stack run without a push. Leave `labeled` out when this workflow will not use the force-run label.

Add this job when the file has no job that uses this action yet. When it already has one, keep it and add `continue-on-error: true` to its gate step. The step id stays `gate`. When a job id `gate` already exists, name this job `stack-gate`. Use that id in `needs` and `if`.

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
      continue-on-error: true
```

The job matches that YAML. It runs for every event that starts the workflow. `should-run` can be `'false'` on `pull_request` and `pull_request_target`. On every other event, including `push`, `schedule`, and `merge_group`, it is `'true'`, so gated work still runs there.

Look at recent Actions run durations and at what the steps do. Choose what skips on a mid-stack pull request. Gate work that takes long enough that a run on the bottom and the top is enough. Leave short checks on every layer, such as lint and format. Skip the whole job when nothing in it should run mid-stack. Skip a step when the rest of the job should still run.

On a gated job, append the gate job id to `needs` and keep the other dependencies. When `needs` is a single job, make it a list. Set `if: ${{ !cancelled() && needs.<gate-job>.outputs.should-run != 'false' }}`. `!cancelled()` runs the job when the gate job fails. If the gate job is skipped or fails, `should-run` is empty and the job runs. `!cancelled()` also runs the job when another job in its `needs` fails, so add `&& needs.<other>.result == 'success'` for each other job in `needs`.

On a gated step, put `if: needs.<gate-job>.outputs.should-run != 'false'` on the step. Append the gate job id to the job's `needs` the same way, and give the job `if: ${{ !cancelled() }}` plus the same `needs.<other>.result == 'success'` checks.

When the job already has an `if`, remove any `should-run == 'true'` comparison from it, and do not keep it next to the new check. Then wrap what is left in parentheses and add it with `&&` after the status checks. Strip its `${{ }}` first. When what is left already calls a status function such as `always()`, keep it and ask the user how a failed gate job should affect that job.

Do not add a job-level `if` that filters on the event (title or body edits, labels, drafts) to the gate job or to a job that lists it in `needs`. When one is already there, flag it in the reply and tell the user why: a later run that skips a required job on the same commit replaces an earlier Failure, so a failing pull request can become mergeable. GitHub showed this live. Suggest removing that event's type from `on` instead.

In a one-job layout, put `continue-on-error: true` on the gate step and replace each `steps.gate.outputs.should-run == 'true'` with `steps.gate.outputs.should-run != 'false'`. Use the gate step's own `id`. Those steps need no status function.

When a job that runs on every layer `needs` a job you are about to gate, leave that dependency running on every layer. A skipped job skips the jobs that need it.

Add the types, the gate job, and those `needs` and `if` lines. Leave every other key as it was.

You are done when each edited file has `opened`, `synchronize`, `reopened`, `edited`, and `stacked`, has `labeled` unless this workflow will not use the force-run label, has one gate job in that shape with `continue-on-error: true` on the gate step, no job or step compares `should-run` with `== 'true'`, each chosen job or step compares `should-run` with `!= 'false'`, each job that lists the gate job in `needs` has `!cancelled()` and `needs.<other>.result == 'success'` for its other needs in its `if`, each gated job also has `needs.<gate-job>.outputs.should-run != 'false'` there, and you added no job-level `if` that filters on the event. In the reply, flag each job-level event filter on the gate job or a job that lists it in `needs`, and why. Name what you gated, what still runs on every layer, and which gated checks a mid-stack pull request will report as Success without running. Say that the user can also require the gate job as a check, that required job names must be unique across workflows, and that a required gate stays Pending in a workflow with `paths:` filters, or in a merge queue repo whose workflow lacks `merge_group`.
