# Changelog

User-facing changes to this action. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [SemVer](https://semver.org/). How to add a bullet and how to cut a version is in [RELEASING.md](RELEASING.md).

## Unreleased

### Added

- The gate step writes a job summary with the decision, the reason, and the stack position.
- When CI runs only because the gate could not decide, the gate step adds a warning annotation and an `Action needed` job summary section with the cause and the fix.
- An empty `github-token` warns only on a stacked pull request that needs the stack listing, so fork and Dependabot pull requests stay quiet.
- `stack-wait-seconds` (default `40`) sets how long `opened` and `reopened` wait for `gh stack submit` to link the stack when the base is not the default branch. Mid-stack PRs from a large submit now skip instead of running.

### Changed

- A failed output write adds a `Stack CI Gate` error annotation that says `should-run` is empty, and the gate step still fails.
- An invalid input still runs CI, and its error annotation is now titled `Stack CI Gate`. The job summary adds an `Action needed` section.
- With `bottom-n` above 1, the force-run label is checked before an unknown remaining depth, so a labeled mid-stack pull request reports `force-run label …` and does not warn when the stack lookup fails.
- On `opened` and `reopened`, a PR into the default branch no longer waits for a stack, because it runs either way.
- The `gate-trace` log line adds `changes` (the names of changed fields on `edited`) and `waited_ms`.

### Fixed

- A missing token or a non-numeric `pr-number` no longer reports `not in a stack`.
- A `pr-number` that is not a plain pull request number, such as `-3`, `0`, `1.5`, `0x10` or `1e3`, now runs CI and warns about the input. Before, `0x10` and `1e3` gated pull requests 16 and 1000, and the others failed on an API error.
- `reason` names the failed lookup when remaining depth is unknown with `bottom-n` above 1.

## 1.1.0 - 2026-10-01

### Added

- Mid-stack pull requests run when they carry the force-run label (`force-run-label`, default `stack-ci:run`). The label only turns a skip into a run.

## 1.0.1 - 2026-09-21

### Changed

- Fail-open `reason` and logs omit GitHub API response bodies and neutralize `::` / `##[` workflow-command sequences.

## 1.0.0 - 2026-09-20

### Added

- Initial GitHub Action: skip redundant CI on mid-stack pull requests after lower-layer changes and rebases.
- Inputs: `bottom-n`, `run-top`, `github-token`, `pr-number`.
- Outputs: `should-run`, `reason`, `is-stacked`, `is-bottom`, `is-top`, `position`, `size`.
- REST fallback on `opened` / `reopened` when `github.event.pull_request.stack` is missing.
- Remaining-depth lookup via the Stacks API when `bottom-n > 1`.

[Unreleased]: https://github.com/raulgg/stack-ci-gate/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/raulgg/stack-ci-gate/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/raulgg/stack-ci-gate/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/raulgg/stack-ci-gate/releases/tag/v1.0.0
