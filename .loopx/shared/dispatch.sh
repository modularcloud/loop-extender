#!/bin/bash
set -euo pipefail

MODE="${LOOPX_REVIEWER:-telegram}"
case "$MODE" in
  telegram)
    exec ./send-telegram.sh
    ;;
  codex)
    exec ./send-codex.sh
    ;;
  api)
    if [[ ! -x ./node_modules/.bin/tsx ]]; then
      echo "Error: ./node_modules/.bin/tsx not found. Run 'npm install' in $(pwd) to enable LOOPX_REVIEWER=api." >&2
      exit 1
    fi
    exec ./node_modules/.bin/tsx ./send-api.ts
    ;;
  batch)
    if [[ ! -x ./node_modules/.bin/tsx ]]; then
      echo "Error: ./node_modules/.bin/tsx not found. Run 'npm install' in $(pwd) to enable LOOPX_REVIEWER=batch." >&2
      exit 1
    fi
    exec ./node_modules/.bin/tsx ./send-batch.ts
    ;;
  *)
    echo "Error: unknown LOOPX_REVIEWER='$MODE' (expected unset, 'telegram', 'codex', 'api', or 'batch')" >&2
    exit 1
    ;;
esac
