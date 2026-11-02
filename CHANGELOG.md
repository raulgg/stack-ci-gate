# Changelog

User-facing changes to this action. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [SemVer](https://semver.org/). How to add a bullet and how to cut a version is in [RELEASING.md](RELEASING.md).

## Unreleased

### Added

- Remaining depth is resolved for every stacked pull request. The `remaining-depth` output is that index, or empty when it is unknown.
- The gate step writes a job summary with the decision and, when known, the remaining depth and the pull requests where gated CI runs.
- When CI runs only because the gate could not decide, the gate step adds a warning annotation and an `Action needed` job summary section with the cause and the fix.

### Changed

- A failed output write is now an error annotation, because gated jobs may skip without `should-run`.

### Fixed

- A missing token or a non-numeric `pr-number` no longer reports `not in a stack`.
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
