---
"loop-extender": patch
---

SPEC §10.11: materialize a symlinked top-level workflow directory as a real directory at install time.

Previously, `loopx install` errored ("Workflow source is not a directory") when a selected workflow's top-level entry in the source was a symlink to an in-source directory. `copyWorkflow` now resolves a top-level symlink via `fs.realpathSync` before walking the source tree, so the materialized destination at `.loopx/<alias>/` is a real directory whose contents are copied from the symlink target. The post-commit `.gitignore` safeguard and `npm install` auto-install pass then run normally against the materialized workflow.
