# Spec Problems

Issues discovered during test specification authoring. Each references a SPEC.md section.

---

### SP-01: Env file key validation gap

**Sections:** 8.1, 4.3

`loopx env set` validates key names against `[A-Za-z_][A-Za-z0-9_]*`, but the `.env` file parser (both global and local `-e` files) has no specified behavior for invalid key names. A hand-edited file could contain keys with spaces, leading digits, or other characters that `env set` would reject. The spec should state whether invalid keys in env files are silently ignored, produce warnings, or cause errors.

---

### SP-02: Tarball URL query string handling

**Sections:** 10.2

The single-file install section explicitly states "The filename is derived from the URL's last path segment, with query strings and fragments stripped." The tarball section says "archive-name is the URL's last path segment minus archive extensions" but does not mention stripping query strings or fragments. A URL like `https://example.com/pkg.tar.gz?token=abc` would produce archive-name `pkg.tar.gz?token=abc` after removing `.tar.gz`, which is clearly wrong. The tarball section should specify the same query/fragment stripping.

---

### SP-03: `output()` behavior with arrays

**Section:** 6.5

The spec says: "If called with a non-object value (e.g., a plain string, number, or boolean), the value is serialized as `{ result: String(value) }`." Arrays are objects in JavaScript (`typeof [] === 'object'`), but an array would not have the known fields (`result`, `goto`, `stop`). The spec's "object with no known fields" case says "Calling `output({})` (no known fields) throws an error." So `output([1,2,3])` would presumably throw — but this may surprise users who expect it to be stringified like other non-object values. The spec should explicitly address arrays.

---

### SP-04: Empty stdout not explicitly addressed

**Section:** 2.3

The spec doesn't explicitly describe behavior when stdout is completely empty (0 bytes). Following the parsing rules, it would be: not valid JSON → raw result → `{ result: "" }`. This is the default case for scripts that produce no output, and is important enough to state explicitly. It also means a script that outputs nothing will cause the loop to reset (no `goto`, no `stop`).

---

### SP-05: Concurrent `loopx env set` calls

**Section:** 8.1

The spec does not address concurrent writes to the global env file. Two simultaneous `loopx env set` commands could corrupt the file. The spec should either document this as undefined behavior, or specify a locking mechanism.

---

### SP-06: `goto` to self not explicitly addressed

**Section:** 2.2

The spec doesn't explicitly state whether a script can `goto` itself (e.g., script A outputs `{ goto: "A" }`). The state machine description doesn't prohibit it, and it would consume an iteration count, but this is a natural edge case that should be explicitly addressed.

---

### SP-07: Name restriction violation behavior unspecified

**Section:** 5.4

Section 5.2 (collisions) and 5.3 (reserved names) explicitly say "loopx refuses to start and displays an error." Section 5.4 states the name pattern rule but does not specify the consequence of violation. The behavior should be explicitly stated (presumably also "refuses to start and displays an error").

---

### SP-08: `package.json` `main` field non-string type

**Section:** 5.1

The spec says directories are discovered when they contain "a `package.json` with a `main` field pointing to a file." If `main` is a non-string value (e.g., `"main": 123`, `"main": null`, `"main": true`), the behavior is unspecified. The spec should state whether this is treated as "no `main` field" (directory ignored) or as an error.

---

### SP-09: Help flag interaction with other flags/arguments

**Section:** 4.2

The spec doesn't specify flag parsing precedence. It's unclear what happens with `loopx -n 5 -h`, `loopx myscript -h`, or `loopx -h myscript`. Most CLIs treat `-h` as highest priority (show help regardless of other args), but this should be specified.

---

### SP-10: Multiple `-e` or `-n` flags

**Section:** 4.2

The spec shows `-e <path>` and `-n <count>` as singular options. Behavior when specified multiple times (e.g., `-n 5 -n 10` or `-e .env1 -e .env2`) is undefined. The spec should state whether last-wins, first-wins, or it's an error.

---

### SP-11: `loopx env set` serialization format

**Section:** 8.1, 4.3

The spec describes the `.env` file parsing format in detail (quoted values, no escape sequences, etc.) but does not describe how `loopx env set <name> <value>` serializes the value when writing to the file. If the value contains characters that could interfere with parsing (e.g., leading/trailing quotes, `#` characters, `=` signs), the spec should state whether and how the value is quoted during serialization.

---

### SP-12: Known git host with non-cloneable paths

**Section:** 10.1

The "known git hosts" rule says any URL with hostname `github.com`, `gitlab.com`, or `bitbucket.org` is treated as a git source. This would match URLs like `https://github.com/org/repo/tree/main` or `https://github.com/org/repo/blob/main/file.ts`, which are not cloneable git URLs. The spec should either narrow the rule (e.g., require exactly `/<org>/<repo>` path structure) or state that non-cloneable URLs will produce a git clone error that is surfaced to the user.

---

### SP-13: `default` as explicit script name

**Sections:** 4.1, 5.3

`default` is not in the reserved names list (section 5.3), and has special meaning as the fallback script (section 4.1). The spec doesn't state whether `loopx default` (explicitly naming the default script) is valid. The natural reading suggests it is, since it's just a script name, but it should be stated.

---

### SP-14: `result` coercion of `null` and `undefined` in stdout parsing

**Section:** 2.3

The spec says "If `result` is present but not a string, it is coerced via `String(value)`." For JSON, `null` is a valid value, so `{"result": null}` would produce `String(null)` = `"null"`. JSON does not have `undefined`, but if the parsing implementation were to encounter it somehow, `String(undefined)` = `"undefined"`. The `null` case should be explicitly addressed since `{"result": null}` could reasonably be interpreted as "no result" rather than the string `"null"`.
