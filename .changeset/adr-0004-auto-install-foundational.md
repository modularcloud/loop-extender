---
"loop-extender": minor
---

SPEC 10.10: implement post-commit auto-install of workflow dependencies.

After a successful commit phase, `loopx install` now runs `npm install` once per committed workflow with a top-level `package.json`, sequentially (npm children do not overlap), with cwd set to the workflow directory and `process.env` inherited unchanged. Before each spawn, loopx checks `.gitignore` and synthesizes one containing `node_modules` if absent (existing regular files are left unchanged; non-regular entries — symlink, directory, FIFO, socket, etc. — are recorded as safeguard failures, skip `npm install` for that workflow, and contribute to a final aggregate failure report on stderr).

`--no-install` (already parsed at the CLI in a previous change) is now wired through to suppress both `npm install` invocation and `.gitignore` synthesis.

Workflows without a top-level `package.json` are skipped silently. Malformed `package.json` (unreadable, invalid JSON, invalid loopx semver range, or non-regular path) emits at most one warning per workflow per install operation (deduped against preflight warnings) and skips auto-install + safeguard for that workflow.

`npm install` non-zero exit and spawn failure (`npm` not on PATH) both record into the aggregate accumulator and cause `loopx install` to exit 1 at end of pass; partial `node_modules/` and committed workflow files are not rolled back.
