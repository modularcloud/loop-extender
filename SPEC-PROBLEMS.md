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

---

### SP-24: Shadowed loopx resolution is underspecified / possibly contradictory

**Sections:** 2.1, 3.3

The spec currently mixes two incompatible policies:

- **Section 3.3** provides a strong guarantee: bare specifier imports of `"loopx"` are intercepted by a custom module resolve hook (Node) or `NODE_PATH` (Bun) and resolved to the running CLI's package exports. This implies the CLI-provided package always wins.
- **Section 2.1** provides an advisory warning: "Directory scripts must not list `loopx` as their own dependency. Installing a separate version of loopx inside a directory script may cause version mismatches." This implies the behavior is undefined or at least unreliable.

If 3.3's guarantee holds absolutely, then a local `node_modules/loopx` inside a directory script should be overridden — the custom loader intercepts the bare specifier before Node's normal resolution finds the local package. But for Bun, section 3.3 uses `NODE_PATH`, which may not reliably override a local `node_modules/loopx` (Bun's resolver may prefer the closer `node_modules` over `NODE_PATH`).

This directly affects T-MOD-03a and T-DEL-06, which currently assume the stronger guarantee.

**Recommended resolution:** Either (a) strengthen 3.3 to explicitly guarantee the CLI-provided package always wins even when a shadow exists in `node_modules`, and specify how this is enforced per-runtime, or (b) weaken the guarantee to advisory status matching 2.1 and mark the scenario as undefined behavior in v1. Option (b) is simpler and avoids runtime-specific corner cases.

---

### SP-25: Tarball detection with query strings / fragments is under-specified

**Sections:** 10.1, 10.2

Section 10.1 says tarballs are URLs "ending in `.tar.gz` or `.tgz`." Section 10.2 explicitly strips query strings and fragments for archive-name derivation, and TEST-SPEC tests (T-INST-26a) already assume URLs like `pkg.tar.gz?token=abc` are treated as tarballs.

However, the URL `http://example.com/pkg.tar.gz?token=abc` does not literally "end in `.tar.gz`" — the query string follows the extension. Source classification and archive-name derivation need to use consistent URL parsing.

**Recommended resolution:** Define source classification as operating on the parsed URL pathname (with query string and fragment ignored). This makes `http://example.com/pkg.tar.gz?token=abc` match the tarball rule (pathname ends in `.tar.gz`), and aligns source detection with the archive-name stripping behavior already described in 10.2.

---

### SP-26: Async-generator cancellation semantics are not precise enough to test cleanly

**Sections:** 9.1, 9.5

Section 9.1 says: "If the consumer breaks out of the `for await` loop or calls `generator.return()`, loopx terminates the active child process group and cleans up." This conflates two different cancellation modes:

1. **Break after yield:** A normal `break` from `for await` happens after a `yield`, when the previous iteration's child process has already exited and the next iteration has not yet started. There is no "active child process group" to terminate. The observable guarantee is simply that no further iterations start.

2. **Return during pending next:** Calling `generator.return()` while a `next()` is pending (a child process is actively running) requires actually terminating the active child process group.

The current wording does not distinguish these cases, making it unclear what the testable contract is for each. T-API-06 (break after yield) can pass vacuously if it only checks "child is no longer running," since there was no child running at that point.

**Recommended resolution:** Clarify that:
- The observable guarantee for `break` / `for await` completion is that no more iterations start after cancellation.
- The active-child termination guarantee applies specifically to `generator.return()` called during a pending `next()`, and to `signal` abortion mid-iteration.
- Both modes result in the generator completing (no further yields).
