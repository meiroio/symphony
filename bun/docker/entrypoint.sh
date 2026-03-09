#!/usr/bin/env bash
set -euo pipefail

if ! codex login status >/dev/null 2>&1; then
  echo "warning: Codex CLI is not authenticated in this container." >&2
  echo "warning: run 'docker compose exec symphony codex login --device-auth' once." >&2
fi

exec "$@"
