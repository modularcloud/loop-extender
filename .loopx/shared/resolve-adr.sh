#!/bin/bash
# Resolves the ADR env var (e.g. ADR=4 or ADR=0004) to a full adr/NNNN-*.md path.
# Outputs: "<zero-padded-number>\t<absolute-file-path>" on stdout.
# Errors to stderr and exits 1 if ADR is unset, non-numeric, missing, or ambiguous.
set -euo pipefail

: "${LOOPX_PROJECT_ROOT:?LOOPX_PROJECT_ROOT must be set}"

if [[ -z "${ADR:-}" ]]; then
  echo "Error: ADR env var is required (e.g. ADR=4 or ADR=0004)" >&2
  exit 1
fi

if ! [[ "$ADR" =~ ^[0-9]+$ ]]; then
  echo "Error: ADR must be numeric (got '$ADR')" >&2
  exit 1
fi

PADDED=$(printf '%04d' "$((10#$ADR))")

shopt -s nullglob
MATCHES=("$LOOPX_PROJECT_ROOT"/adr/"$PADDED"-*.md)
shopt -u nullglob

if [[ ${#MATCHES[@]} -eq 0 ]]; then
  echo "Error: no ADR file found at adr/${PADDED}-*.md under $LOOPX_PROJECT_ROOT" >&2
  exit 1
fi

if [[ ${#MATCHES[@]} -gt 1 ]]; then
  echo "Error: multiple ADR files match adr/${PADDED}-*.md:" >&2
  printf '  %s\n' "${MATCHES[@]}" >&2
  exit 1
fi

printf '%s\t%s\n' "$PADDED" "${MATCHES[0]}"
