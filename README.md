# Loop Extender (loopx)

[![CI](https://github.com/modularcloud/loop-extender/actions/workflows/ci.yml/badge.svg)](https://github.com/modularcloud/loop-extender/actions/workflows/ci.yml)

loopx is a CLI tool that automates repeated execution ("loops") of scripts, primarily designed to wrap agent CLIs. It provides a scriptable loop engine with structured output, control flow between scripts, environment variable management, and a script installation mechanism.

## Status

**Production ready.** All 1068 tests pass with zero type errors. The implementation is fully conformant with [SPEC.md](./SPEC.md), including [ADR-0002](./adr/0002-run-subcommand.md) (`run` subcommand).

## Quick Start

```bash
npm install -g loop-extender

# Create a script
mkdir -p .loopx
echo 'import { output } from "loopx"; output({ result: "hello", stop: true });' > .loopx/hello.ts

# Run it
loopx run hello
```

## Features

- **Loop engine** with goto-based control flow between scripts
- **Structured output** parsing (JSON with `result`, `goto`, `stop` fields)
- **Script types**: Bash (`.sh`), JavaScript (`.js`/`.jsx`), TypeScript (`.ts`/`.tsx`), directory scripts with `package.json`
- **Environment management** via `loopx env set/remove/list` and `-e` local overrides
- **Script installation** from GitHub repos, git URLs, tarballs, and single-file URLs
- **Programmatic API** with `run()` (async generator) and `runPromise()`
- **Signal handling** with proper process group forwarding and grace periods
- **CLI delegation** for local version pinning via `node_modules/.bin/loopx`

## Running Tests

```bash
npm install
npm run build

# Run all tests
npx vitest run

# Run by suite
npx vitest run tests/harness/   # Infrastructure validation
npx vitest run tests/unit/       # Unit tests
npx vitest run tests/e2e/        # End-to-end tests
npx vitest run tests/fuzz/       # Property-based fuzz tests
```

## Test Architecture

| Suite | Files | Purpose | Timeout |
|-------|-------|---------|---------|
| harness | `tests/harness/` | Infrastructure validation | 10s |
| unit | `tests/unit/` | Parser and type tests | 5s |
| e2e | `tests/e2e/` | Black-box CLI and API tests | 30s |
| signals | `tests/e2e/signals.test.ts` | Signal handling (serial) | 60s |
| fuzz | `tests/fuzz/` | Property-based parser tests | 120s |
| typecheck | `tests/unit/types.test.ts` | Compile-time type verification | - |

## Requirements

- **Node.js** >= 20.6 (for `module.register()`)
- **Bun** >= 1.0 (alternative runtime)
- **Platform**: POSIX-only (macOS, Linux)

## AI Agent Skill

loopx ships with an [agent skill](./plugin/skills/loopx/SKILL.md) that helps AI coding agents create loopx workflows from plain English descriptions.

**Install via [skills.sh](https://skills.sh):**

```bash
npx skills add modularcloud/loop-extender
```

**Install via Claude Code plugin marketplace:**

```
/plugin marketplace add modularcloud/loop-extender
/plugin install loopx@loop-extender
```

## Documentation

See [SPEC.md](./SPEC.md) for the full product specification and [TEST-SPEC.md](./TEST-SPEC.md) for the test specification.
