#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$BUN_DIR/.." && pwd)"

WORKFLOW_PATH="${WORKFLOW_PATH:-$BUN_DIR/WORKFLOW.test.md}"
PORT="${PORT:-8789}"
ISSUE_IDENTIFIER="${ISSUE_IDENTIFIER:-}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-20}"

usage() {
  cat <<USAGE
Usage: $0 [--workflow PATH] [--port PORT] [--issue IDENTIFIER]

Environment overrides:
  WORKFLOW_PATH
  PORT
  ISSUE_IDENTIFIER
  STARTUP_TIMEOUT_SECONDS
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workflow)
      WORKFLOW_PATH="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --issue)
      ISSUE_IDENTIFIER="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -f "$WORKFLOW_PATH" ]]; then
  echo "Workflow file not found: $WORKFLOW_PATH" >&2
  exit 1
fi

if [[ "$WORKFLOW_PATH" != /* ]]; then
  WORKFLOW_PATH="$(cd "$(dirname "$WORKFLOW_PATH")" && pwd)/$(basename "$WORKFLOW_PATH")"
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "PORT must be a non-negative integer. Got: $PORT" >&2
  exit 1
fi

LOG_FILE="$(mktemp -t symphony-bun-smoke.XXXXXX.log)"
STATE_JSON="$(mktemp -t symphony-bun-state.XXXXXX.json)"
REFRESH_JSON="$(mktemp -t symphony-bun-refresh.XXXXXX.json)"
ISSUE_JSON="$(mktemp -t symphony-bun-issue.XXXXXX.json)"

cleanup() {
  if [[ -n "${APP_PID:-}" ]]; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  fi

  rm -f "$STATE_JSON" "$REFRESH_JSON" "$ISSUE_JSON"
}

trap cleanup EXIT

echo "[smoke] Starting Symphony Bun"
echo "[smoke] workflow=$WORKFLOW_PATH"
echo "[smoke] port=$PORT"
echo "[smoke] logs=$LOG_FILE"

(
  cd "$BUN_DIR"
  bun run src/cli.ts "$WORKFLOW_PATH" --port "$PORT" >"$LOG_FILE" 2>&1
) &
APP_PID=$!

base_url="http://127.0.0.1:$PORT"

start_deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
ready=0
while [[ $SECONDS -lt $start_deadline ]]; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/api/v1/state" || true)"
  if [[ "$code" == "200" ]]; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  echo "[smoke] Service did not become ready in ${STARTUP_TIMEOUT_SECONDS}s" >&2
  echo "[smoke] Last logs:" >&2
  tail -n 80 "$LOG_FILE" >&2 || true
  exit 1
fi

echo "[smoke] API is reachable"

state_code="$(curl -sS -o "$STATE_JSON" -w '%{http_code}' "$base_url/api/v1/state")"
refresh_code="$(curl -sS -X POST -H 'content-type: application/json' -d '{}' -o "$REFRESH_JSON" -w '%{http_code}' "$base_url/api/v1/refresh")"
method_code="$(curl -sS -X POST -o /dev/null -w '%{http_code}' "$base_url/api/v1/state")"
not_found_code="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/this-route-does-not-exist")"

if [[ -n "$ISSUE_IDENTIFIER" ]]; then
  issue_code="$(curl -sS -o "$ISSUE_JSON" -w '%{http_code}' "$base_url/api/v1/$ISSUE_IDENTIFIER")"
else
  issue_code="(skipped)"
fi

echo "[smoke] status codes:"
echo "  GET  /api/v1/state       -> $state_code"
echo "  POST /api/v1/refresh     -> $refresh_code"
echo "  POST /api/v1/state       -> $method_code (expect 405)"
echo "  GET  /missing-route      -> $not_found_code (expect 404)"
if [[ -n "$ISSUE_IDENTIFIER" ]]; then
  echo "  GET  /api/v1/$ISSUE_IDENTIFIER -> $issue_code"
fi

echo "[smoke] /api/v1/state payload"
cat "$STATE_JSON"
echo

echo "[smoke] /api/v1/refresh payload"
cat "$REFRESH_JSON"
echo

if [[ -n "$ISSUE_IDENTIFIER" ]]; then
  echo "[smoke] /api/v1/$ISSUE_IDENTIFIER payload"
  cat "$ISSUE_JSON"
  echo
fi

if [[ "$state_code" != "200" || "$refresh_code" != "202" || "$method_code" != "405" || "$not_found_code" != "404" ]]; then
  echo "[smoke] Endpoint contract check failed" >&2
  echo "[smoke] Last logs:" >&2
  tail -n 80 "$LOG_FILE" >&2 || true
  exit 1
fi

echo "[smoke] Endpoint contract checks passed"
echo "[smoke] Last logs"
tail -n 40 "$LOG_FILE" || true

echo "[smoke] Done"
