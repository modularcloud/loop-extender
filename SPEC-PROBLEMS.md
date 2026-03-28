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
