## Fuzz Test F-ENV-04 vs Unit Tests: Trailing Whitespace Trimming

The fuzz test F-ENV-04 (tests/fuzz/env-parsing.fuzz.test.ts, line ~473) generates duplicate key test data where `lastValue` can include trailing whitespace (e.g., `" "`). The test expects `parseEnvFile()` to return the value WITHOUT trimming trailing whitespace.

However, unit test "KEY= with trailing whitespace → empty string after trim" (tests/unit/parse-env.test.ts) explicitly asserts that `FOO=   ` produces `""` (empty string after trimming).

The SPEC.md (section 8.1) clearly states: "the value is everything after it to the end of the line (trimmed of trailing whitespace)".

The fuzz test has a comment on line 480: `// Note: the value may have trailing whitespace trimmed per spec.` — acknowledging the trimming, but the assertion at line 481 doesn't account for it.

**Impact**: F-ENV-04 unit-level "duplicate keys resolved by last occurrence" fails with counterexample `A=\nA= ` where expected value is `" "` but parser correctly returns `""`.

**Resolution**: The fuzz test's expected value generator should either (a) filter out values that are pure whitespace, or (b) trim `lastValue` before comparing. The parser implementation is correct per spec and unit tests.
