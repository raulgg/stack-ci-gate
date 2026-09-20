# Changelog

User-facing changes to this action. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [SemVer](https://semver.org/). How to add a bullet and how to cut a version is in [RELEASING.md](RELEASING.md).

## Unreleased

### Changed

- Usage example sets `contents: read` and `pull-requests: read` on the `gate` job, uses `github.token`, and puts the action on `pull_request` so the job does not get the base repository token and secrets from `pull_request_target`.
- README states that `@v1` tracks the latest 1.x and that a commit SHA freezes the tree.
- Fail-open `reason` and logs omit GitHub API response bodies and neutralize `::` / `##[` workflow-command sequences.

## 1.0.0 - 2026-09-20

### Added

- Initial GitHub Action: skip redundant CI on mid-stack pull requests after lower-layer changes and rebases.
- Inputs: `bottom-n`, `run-top`, `github-token`, `pr-number`.
- Outputs: `should-run`, `reason`, `is-stacked`, `is-bottom`, `is-top`, `position`, `size`.
- REST fallback on `opened` / `reopened` when `github.event.pull_request.stack` is missing.
- Remaining-depth lookup via the Stacks API when `bottom-n > 1`.

[Unreleased]: https://github.com/raulgg/stack-ci-gate/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/raulgg/stack-ci-gate/releases/tag/v1.0.0
