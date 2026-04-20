# Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to manage versions and publishing.

## Adding a changeset

When you make a user-facing change to `loop-extender`, create a changeset:

```bash
npx changeset
```

Pick the packages that changed, the semver bump (patch/minor/major), and describe the change. Commit the generated `.changeset/*.md` file with your PR.

## How releases work

On merge to `main`, the GitHub Action checks for pending `.changeset/*.md` files. If any exist, it:

1. Runs `changeset version` to bump `packages/loop-extender/package.json` and regenerate `CHANGELOG.md`.
2. Commits the bump back to `main` as `chore(release): version packages`.
3. Runs `npm publish` (with provenance) and creates the git tag.

One PR, one merge, one release. The PR itself is the human gate — review the changeset and bump level before merging, because there is no second review step.
