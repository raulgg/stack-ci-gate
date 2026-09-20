# Releasing

Consumers should pin `raulgg/stack-ci-gate@v1` for the latest compatible 1.x, or a full tag (`@v1.0.0`) or commit SHA to freeze the tree. Do not pin `@main`.

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

Bump `package.json` in the same PR that introduces the `## X.Y.Z` heading.

## GitHub Releases

This repository has immutable releases enabled. A published `vMAJOR.MINOR.PATCH` Release locks that git tag: it cannot be moved or deleted while the Release exists, and the tag name cannot be reused if the Release is deleted. Release notes can still be edited.

CI creates a GitHub Release when you push an annotated tag that matches `v*.*.*` (for example `v1.0.0`). The release body is that version's section from `CHANGELOG.md`. If that Release already exists, CI updates the notes and leaves the tag where it is.

CI then force-moves a floating major tag (`v1` for `v1.0.0`) to the same commit. That tag is not a GitHub Release, so it can still move. Do not push `v1` yourself.

```bash
git checkout main
git pull
git tag -a v1.0.1 -m "v1.0.1"
git push origin v1.0.1
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
- Force-push a version tag. Immutable releases and the tag ruleset reject that.
- Create a GitHub Release for `v1`. A Release on that tag would lock it.
