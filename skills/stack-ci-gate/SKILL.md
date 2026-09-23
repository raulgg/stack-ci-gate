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

A pull request workflow is gated when a step uses `raulgg/stack-ci-gate` at any ref and another job or step compares that job's `should-run` to `'true'`. When the root `action.yml` has `name: Stack CI Gate`, `uses: ./` counts as this action. Treat a comment as ungated, and treat a gate job the same way when no other job or step checks it.

Mark each file as a gated pull request workflow, an ungated pull request workflow, or neither.

On Suggest, when every pull request workflow is already gated, or the repo has none, make the workflow edit this task asked for, then stop. Do not mention this gate.

Asked and Rewrite continue to step 4. Suggest continues when an ungated pull request workflow remains.

## 4. Act

Asked. Run Apply the gate on the ungated pull request workflows in scope. If the user named workflow files, those files are the scope. If they named none and are agreeing to a suggestion, the scope is the files that suggestion named. If they named no file and are not answering a suggestion, the scope is every ungated pull request workflow. Leave the gate off a named file that is not a pull request workflow, and say so in the reply.

Stop when each file you edited matches the done check under Apply the gate. When no file in scope needs the gate, or the repo has no pull request workflow, reply with one sentence that names the files already gated, or says that the repo has no pull request workflow.

Rewrite. Make the workflow edit this task asked for. For the gate, edit only that workflow. When it is a pull request workflow, run Apply the gate on it. When it is not, leave the gate off.

When another ungated pull request workflow remains, and this conversation has not already asked, name each one in the same reply and ask whether to gate it too. Leave those files unchanged.

Stop when the file this task is creating or rewriting is saved with this task's edits. When that file is a pull request workflow, it also matches the done check under Apply the gate. Any ask names each other ungated pull request workflow.

Suggest. Make the workflow edit this task asked for. If this conversation has already asked, do not mention this gate. If it has not, name each ungated pull request workflow and ask whether to gate them. Stop when that edit is saved. When you ask, the reply names each ungated pull request workflow.

## Apply the gate

Asked and Rewrite run this on each pull request workflow they gate.

If `pull_request` has no `types` list, set it to `opened`, `synchronize`, `reopened`, `edited`, and `stacked`. If it has a list, add any of those five that are missing. Keep every other trigger, type, branch filter, and path filter.

Add this job when the file has none yet. The step id stays `gate`. When a job id `gate` already exists, name this job `stack-gate`. Use that id in `needs` and `if`.

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

The job matches that YAML. It runs for every event that starts the workflow. `should-run` can be `'false'` on `pull_request` and `pull_request_target`. On every other event, including `push`, `schedule`, and `merge_group`, it is `'true'`, so gated work still runs there.

Look at recent Actions run durations and at what the steps do. Choose what skips on a mid-stack pull request. Gate work that takes long enough that a run on the bottom and the top is enough. Leave short checks on every layer, such as lint and format. Skip the whole job when nothing in it should run mid-stack. Skip a step when the rest of the job should still run.

On a gated job, append the gate job id to `needs` and keep the other dependencies. When `needs` is a single job, make it a list. Set `if: needs.<gate-job>.outputs.should-run == 'true'`. When the job already has an `if`, wrap that expression in parentheses and add `&& needs.<gate-job>.outputs.should-run == 'true'`.

On a gated step, put that same `if` on the step. Append the gate job id to the job's `needs` the same way. Leave the job's `if` as it was.

When a job that runs on every layer `needs` a job you are about to gate, leave that dependency running on every layer. A skipped job skips the jobs that need it.

Add the types, the gate job, and those `needs` and `if` lines. Leave every other key as it was.

You are done when each edited file has the five types, one gate job in that shape, and each chosen job or step compares `should-run` to `'true'`. In the reply, name what you gated, what still runs on every layer, and which gated checks a mid-stack pull request will report as Success without running.
