# Releasing

Consumers should pin `raulgg/stack-ci-gate@v1` for the latest compatible 1.x, or a full tag (`@v1.0.0`) or commit SHA to freeze the tree. Do not pin `@main`.

There is no tag yet. Do not push `v1.0.0` or `v1` until you mean to publish. The first ship is a separate step after this process is on `main`.

## Changelog

`CHANGELOG.md` is the notes file for GitHub Releases. Keep it in Keep a Changelog form.

Add a bullet under `## Unreleased` in the same PR as the change when you touch:

- `action.yml`
- `src/`
- a user-facing README claim (new input, changed skip rule, renamed output)

Skip a bullet for test-only work, this repo's own CI, and internal log lines (`gate-trace`).

Write one sentence under `### Added`, `### Changed`, `### Fixed`, or `### Removed`. Describe what a workflow author sees.

When you cut a version, move the Unreleased bullets into a heading `## X.Y.Z - YYYY-MM-DD`, leave an empty Unreleased section, and add compare links at the bottom. The heading must contain the version string the git tag will use without the `v` prefix (`1.0.0` for tag `v1.0.0`). The release workflow fails if that section is missing.

## Version numbers

After 1.0.0:

- Patch (`v1.0.1`): bugs in the decision, retries, fail-open, docs that correct a claim.
- Minor (`v1.1.0`): a new optional input or output.
- Major (`v2.0.0`): `should-run` means something else, an output is removed, fail-open goes away, or extra permissions are required.

`package.json` already has `"version": "1.0.0"`. Bump it in the same PR that introduces the `## X.Y.Z` heading.

## GitHub Releases

CI creates a GitHub Release when you push an annotated tag that matches `v*.*.*` (for example `v1.0.0`). The release body is that version's section from `CHANGELOG.md`.

CI then force-moves a floating major tag (`v1` for `v1.0.0`) to the same commit. That tag is not a GitHub Release. Do not push `v1` yourself.

```bash
git checkout main
git pull
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

Later patches:

1. PR: Unreleased → `## 1.0.1 - YYYY-MM-DD`, bump `package.json`.
2. Merge to `main`.
3. `git tag -a v1.0.1 -m "v1.0.1" && git push origin v1.0.1`.

CI moves `v1` to `v1.0.1`.

## What not to do

- Tag from a fixture or stack branch. Always tag `main`.
- Push `v1` by hand.
- Use a tag that is not `vMAJOR.MINOR.PATCH`. `v1` and `v1.0` do not create Releases.
- Enable immutable GitHub Releases until you are ready to lock `v1.0.0`. If you enable them, keep `v1` as a git tag with no Release so it can still move.
