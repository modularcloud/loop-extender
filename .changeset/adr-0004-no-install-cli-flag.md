---
"loop-extender": patch
---

SPEC 4.2 / 10.10 / 11.3: recognize `--no-install` as a boolean install-scoped flag in the install CLI parser, and list it in `loopx install -h` / `--help` output.

`parseInstallArgs` now accepts `--no-install` (no operand) with duplicate-flag rejection (`Error: duplicate --no-install flag`). The `-h` / `--help` short-circuit suppresses both the duplicate-flag error and any source acquisition (no network activity, `.loopx/` untouched). Common single-character candidates (`-n`, `-N`, `-i`, `-I`) remain rejected as unknown install-scoped short flags — `--no-install` has no short form per SPEC 4.2.

The flag's behavioral effect (suppressing auto-install of workflow dependencies) is wired only at the parser layer in this change; the auto-install pipeline itself is a separate larger work-item per Spec 10.10.
