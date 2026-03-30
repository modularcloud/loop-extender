# Spec Problems

Issues discovered during test specification authoring. Each references a SPEC.md section.

*SP-01 through SP-14 have been resolved and incorporated into SPEC.md.*

---

### SP-15: Unmatched quote behavior in env file parsing

**Section:** 8.1

The spec says values may be "optionally wrapped" in double or single quotes, which are stripped. It does not define behavior when quotes are unmatched (e.g., `KEY="hello` or `KEY='world`). The most conservative reading is that "wrapped" requires both opening and closing quotes — an unmatched quote is not wrapping, so the literal value (including the quote character) is preserved. This should be stated explicitly.

**Recommended resolution:** If quotes are not matched (opening quote without a corresponding closing quote of the same type at the end of the value), the value is treated literally — no quotes are stripped.

---

### SP-16: `loopx install` script name derivation from tarball URL edge cases

**Sections:** 10.2

When deriving `archive-name` from a tarball URL, the spec strips `.tar.gz` and `.tgz` extensions. However, if the resulting name violates script name restrictions (e.g., starts with `-`, contains invalid characters), the install should fail with a clear error rather than silently creating an invalid script. The spec mentions name validation in section 10.3 ("The script name is validated against reserved name and name restriction rules before being saved"), which covers this, but it would be clearer to note that this applies to derived names, not just user-visible ones.

**Status:** Low priority — the existing 10.3 rule covers this implicitly.

---

### SP-17: Install validation is narrower than discovery validation

**Sections:** 10.2, 5.1

Section 10.2 says git/tarball installs succeed if the resulting directory contains a `package.json` with a `main` pointing to a supported extension. Section 5.1 defines a valid directory script more strictly: `package.json` must be readable JSON, `main` must be a string, must not escape the directory, and must point to an existing file.

This leaves install behavior under-specified for repos/tarballs whose `main` is missing, unreadable, or escapes the directory.

**Recommended resolution:** After clone/extract, validate the installed directory using the same directory-script rules as section 5.1. On failure, remove the destination and exit with code 1.

---

### SP-18: Missing-dependency error wording is Node-specific

**Section:** 2.1

The spec says that if `node_modules/` is missing and a directory script fails to import a package, the result is "a normal Node.js module resolution error." Bun is also a supported runtime, so that wording is inaccurate there.

**Recommended resolution:** Change to "the active runtime's normal module resolution error."

---

### SP-19: "Directory scripts must not list loopx as a dependency" is normative but not enforceable

**Section:** 2.1

The spec says directory scripts "must not" list loopx as their own dependency, but no validation or failure behavior is defined. Section 3.3 also says bare imports of `"loopx"` are intercepted and resolved to the running CLI's package, which makes this more of an advisory note than a runtime rule.

**Recommended resolution:** Rephrase as advisory language ("should not" / "not recommended"), and explicitly state that v1 does not validate or reject this.

---

### SP-20: `org/repo` shorthand is ambiguous when the repo segment ends in `.git`

**Section:** 10.1

The shorthand rule expands `<org>/<repo>` to `https://github.com/<org>/<repo>.git`. As written, an input like `org/repo.git` would expand to `https://github.com/org/repo.git.git`.

**Recommended resolution:** Either forbid `.git` in shorthand input or strip a trailing `.git` before expansion.

---

### SP-21: `org/repo` shorthand expansion is inconsistent across the spec

**Sections:** 4.3, 10.1

Section 4.3 says the shorthand expands to `https://github.com/org/repo` (no `.git` suffix). Section 10.1 says it expands to `https://github.com/<org>/<repo>.git` (with `.git` suffix). These are not the same rule, and the difference matters for source detection (rule 2 vs rule 3 in section 10.1).

T-INST-01 currently asserts only "treated as a git source" rather than the exact expanded string, which is safe until this is resolved.

**Recommended resolution:** Pick one canonical normalization rule and use it consistently in both sections. The `.git` suffix version (10.1) is more explicit and avoids ambiguity with known-host pathname matching.

---

### SP-22: `run()` error timing is underspecified

**Sections:** 9.1, 9.3, 9.5

The spec does not clearly say whether `run()`:
- throws synchronously at call time for validation/discovery errors, or
- always returns a generator and throws only when iteration begins (first `next()`)

This matters for library ergonomics and for tests like T-API-20a (missing script), T-API-22/23 (invalid maxIterations). The current test spec softens these tests to assert only that an error occurs before any child execution, not exactly when.

**Recommended resolution:** Define one model explicitly. A natural choice: `run()` snapshots options/cwd immediately but surfaces all errors when iteration begins (first `next()` or equivalent). This matches a natural async-generator implementation where the generator function body runs lazily.

---

### SP-23: `loopx version` output format is under-specified

**Sections:** 4.3, 3.4

The spec says `loopx version` "prints the installed version of loopx and exits," but it does not define whether stdout must be:

- the bare version string, e.g. `1.2.3`
- a labeled string, e.g. `loopx 1.2.3`
- or whether a trailing newline is required

TEST-SPEC.md currently assumes exact equality with `package.json`'s `version` field (T-CLI-01, T-MOD-21), which is stricter than the current spec text.

**Recommended resolution:** Define `loopx version` as printing the bare package version string followed by a newline, with no additional text.
