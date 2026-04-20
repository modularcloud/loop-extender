# Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to manage versions and publishing.

## Adding a changeset

When you make a user-facing change to `loop-extender`, create a changeset:

```bash
npx changeset
```

Pick the packages that changed, the semver bump (patch/minor/major), and describe the change. Commit the generated `.changeset/*.md` file with your PR.

## How releases work

1. On merge to `main`, the GitHub Action opens (or updates) a **"Version Packages"** PR that aggregates pending changesets, bumps `packages/loop-extender/package.json`, and regenerates `CHANGELOG.md`.
2. Merging that PR triggers `npm publish` with provenance, creates a git tag, and publishes a GitHub Release with the changelog.

No manual tagging. No publish on every tag. The Version Packages PR is the human gate.
