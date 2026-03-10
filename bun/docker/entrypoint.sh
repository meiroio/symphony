#!/usr/bin/env bash
set -euo pipefail

if ! codex login status >/dev/null 2>&1; then
  echo "warning: Codex CLI is not authenticated in this container." >&2
  echo "warning: setup flow:" >&2
  echo "warning:   1) docker compose exec symphony codex login --device-auth" >&2
  echo "warning:   2) docker compose exec symphony codex login status" >&2
  echo "warning:   3) docker compose restart symphony" >&2
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "warning: GitHub CLI is not authenticated in this container." >&2
  echo "warning: setup flow:" >&2
  echo "warning:   1) docker compose exec symphony gh auth login" >&2
  echo "warning:   2) docker compose exec symphony gh auth status" >&2
  echo "warning:   3) docker compose restart symphony" >&2
fi

exec "$@"
