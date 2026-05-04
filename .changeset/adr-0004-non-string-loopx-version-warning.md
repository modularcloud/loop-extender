---
"loop-extender": patch
---

SPEC 3.2: workflow-level version checking now correctly warns when `dependencies.loopx` or `devDependencies.loopx` is a non-string value (e.g., a JSON number).

Previously, a workflow `package.json` like `{ "dependencies": { "loopx": 42 } }` was silently treated as if no `loopx` declaration existed — no warning fired and the version check was skipped without diagnostics. Per SPEC 3.2's "Valid JSON but `loopx` version field contains an invalid semver range: A warning is printed to stderr", any value that is not a valid semver range (including non-string types, since semver ranges are strings) must produce the same `invalid-semver` warning class.

The fix applies symmetrically to:
- the runtime workflow-version check (first entry into a workflow during a loop run)
- the install-time preflight check (`loopx install` `dependencies.loopx` validation)
- the post-commit auto-install pass (malformed-`package.json` skip)

`peerDependencies.loopx` and `optionalDependencies.loopx` remain fully invisible at the workflow level, even when malformed, per SPEC 3.2's enumeration of checked fields. Likewise, an invalid range on a non-`loopx` dependency entry is ignored (the check reads only `dependencies.loopx` and `devDependencies.loopx`).
