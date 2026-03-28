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
