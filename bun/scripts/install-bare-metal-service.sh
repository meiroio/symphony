#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  install-bare-metal-service.sh --release-dir /path/to/release [options]

Installs a compiled Symphony release bundle onto a Linux host with systemd.
The script creates a versioned release under the install root, preserves a
shared .env and shared workflows directory across upgrades, and installs a
systemd unit that runs the compiled directory launcher against the shared
workflow directory.

Options:
  --release-dir PATH       Release bundle directory containing symphony and workflows/ (required)
  --install-root PATH      Install root for releases and shared assets (default: /opt/symphony)
  --data-root PATH         Persistent data root for HOME and workspaces (default: /var/lib/symphony)
  --service-home PATH      Service HOME directory. Defaults to the existing user's login home,
                           otherwise <data-root>/home
  --workspace-root PATH    Persistent workspace root written into seeded sample workflows
                           (default: <data-root>/workspaces)
  --service-name NAME      systemd service name (default: symphony)
  --user NAME              Service user (default: symphony)
  --group NAME             Service group (default: <user>)
  --systemd-dir PATH       systemd unit directory (default: /etc/systemd/system)
  --sync-workflows         Replace shared workflows with the release bundle workflows
  --no-start               Install or update the unit, but do not restart the service
  --dry-run                Print actions without changing the host
  --help                   Show this help

Examples:
  sudo ./scripts/install-bare-metal-service.sh --release-dir /tmp/symphony-release
  sudo ./scripts/install-bare-metal-service.sh \
    --release-dir /tmp/symphony-release \
    --workspace-root /srv/symphony/workspaces \
    --sync-workflows
EOF
}

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

run() {
  if (( DRY_RUN )); then
    printf '+'
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
    return 0
  fi

  "$@"
}

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[&|]/\\&/g'
}

require_command() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
  done
}

has_workflow_files() {
  local workflow_dir="$1"
  shopt -s nullglob
  local files=("$workflow_dir"/*.md)
  shopt -u nullglob
  (( ${#files[@]} > 0 ))
}

resolve_user_home() {
  local user="$1"
  local passwd_entry
  local _ignored
  local home

  passwd_entry=$(getent passwd "$user" || true)
  [[ -n "$passwd_entry" ]] || return 1

  IFS=':' read -r _ignored _ignored _ignored _ignored _ignored home _ignored <<< "$passwd_entry"
  [[ -n "$home" ]] || return 1

  printf '%s\n' "$home"
}

write_systemd_unit() {
  local unit_path="$1"
  local current_link="$2"
  local shared_env="$3"
  local shared_workflows="$4"
  local service_user="$5"
  local service_group="$6"
  local service_home="$7"
  local service_path="$service_home/.bun/bin:$service_home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin"
  local unit_text

  unit_text=$(
    cat <<EOF
[Unit]
Description=Symphony orchestration service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$service_user
Group=$service_group
WorkingDirectory=$current_link
Environment=HOME=$service_home
Environment=XDG_CONFIG_HOME=$service_home/.config
Environment=PATH=$service_path
EnvironmentFile=-$shared_env
ExecStart=$current_link/symphony $shared_workflows
Restart=always
RestartSec=5
KillSignal=SIGTERM
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF
  )

  if (( DRY_RUN )); then
    log "Would write $unit_path:"
    printf '%s\n' "$unit_text"
    return 0
  fi

  local tmp_file
  tmp_file=$(mktemp)
  printf '%s\n' "$unit_text" >"$tmp_file"
  install -m 0644 "$tmp_file" "$unit_path"
  rm -f "$tmp_file"
}

seed_or_sync_workflows() {
  local release_workflows="$1"
  local shared_workflows="$2"
  local mode="$3"

  run install -d -m 0755 "$shared_workflows"

  if [[ "$mode" == "seed" ]]; then
    run cp -R "$release_workflows"/. "$shared_workflows"/
    return 0
  fi

  local existing
  shopt -s nullglob
  local workflow_files=("$shared_workflows"/*.md)
  shopt -u nullglob
  for existing in "${workflow_files[@]}"; do
    run rm -f "$existing"
  done

  run cp -R "$release_workflows"/. "$shared_workflows"/
}

rewrite_tmp_workspace_roots() {
  local workflow_dir="$1"
  local workspace_root="$2"
  local escaped_workspace_root
  local file

  escaped_workspace_root=$(escape_sed_replacement "$workspace_root")

  shopt -s nullglob
  local workflow_files=("$workflow_dir"/*.md)
  shopt -u nullglob

  for file in "${workflow_files[@]}"; do
    if ! grep -q '^  root: /tmp/symphony-bun-workspaces$' "$file"; then
      continue
    fi

    run sed -i "s|^  root: /tmp/symphony-bun-workspaces\$|  root: $escaped_workspace_root|" "$file"
  done
}

RELEASE_DIR=""
INSTALL_ROOT="/opt/symphony"
DATA_ROOT="/var/lib/symphony"
SERVICE_NAME="symphony"
SERVICE_USER="symphony"
SERVICE_GROUP=""
SERVICE_HOME=""
SYSTEMD_DIR="/etc/systemd/system"
SYNC_WORKFLOWS=0
START_SERVICE=1
DRY_RUN=0
WORKSPACE_ROOT=""

while (($# > 0)); do
  case "$1" in
    --release-dir)
      [[ $# -ge 2 ]] || fail "--release-dir requires a path"
      RELEASE_DIR="$2"
      shift 2
      ;;
    --install-root)
      [[ $# -ge 2 ]] || fail "--install-root requires a path"
      INSTALL_ROOT="$2"
      shift 2
      ;;
    --data-root)
      [[ $# -ge 2 ]] || fail "--data-root requires a path"
      DATA_ROOT="$2"
      shift 2
      ;;
    --service-home)
      [[ $# -ge 2 ]] || fail "--service-home requires a path"
      SERVICE_HOME="$2"
      shift 2
      ;;
    --workspace-root)
      [[ $# -ge 2 ]] || fail "--workspace-root requires a path"
      WORKSPACE_ROOT="$2"
      shift 2
      ;;
    --service-name)
      [[ $# -ge 2 ]] || fail "--service-name requires a value"
      SERVICE_NAME="$2"
      shift 2
      ;;
    --user)
      [[ $# -ge 2 ]] || fail "--user requires a value"
      SERVICE_USER="$2"
      shift 2
      ;;
    --group)
      [[ $# -ge 2 ]] || fail "--group requires a value"
      SERVICE_GROUP="$2"
      shift 2
      ;;
    --systemd-dir)
      [[ $# -ge 2 ]] || fail "--systemd-dir requires a path"
      SYSTEMD_DIR="$2"
      shift 2
      ;;
    --sync-workflows)
      SYNC_WORKFLOWS=1
      shift
      ;;
    --no-start)
      START_SERVICE=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[[ -n "$RELEASE_DIR" ]] || fail "--release-dir is required"
SERVICE_GROUP="${SERVICE_GROUP:-$SERVICE_USER}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$DATA_ROOT/workspaces}"

EXISTING_SERVICE_HOME=""
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  EXISTING_SERVICE_HOME="$(resolve_user_home "$SERVICE_USER" || true)"
fi

if [[ -z "$SERVICE_HOME" ]]; then
  SERVICE_HOME="${EXISTING_SERVICE_HOME:-$DATA_ROOT/home}"
fi

RELEASE_DIR=$(realpath "$RELEASE_DIR")
INSTALL_ROOT=$(realpath -m "$INSTALL_ROOT")
DATA_ROOT=$(realpath -m "$DATA_ROOT")
SERVICE_HOME=$(realpath -m "$SERVICE_HOME")
WORKSPACE_ROOT=$(realpath -m "$WORKSPACE_ROOT")
SYSTEMD_DIR=$(realpath -m "$SYSTEMD_DIR")

[[ -d "$RELEASE_DIR" ]] || fail "release directory not found: $RELEASE_DIR"
[[ -f "$RELEASE_DIR/symphony" ]] || fail "compiled binary not found: $RELEASE_DIR/symphony"
[[ -d "$RELEASE_DIR/workflows" ]] || fail "workflow directory not found: $RELEASE_DIR/workflows"
has_workflow_files "$RELEASE_DIR/workflows" || fail "workflow directory is empty: $RELEASE_DIR/workflows"

require_command install cp ln rm sed grep realpath getent id chmod chown
if (( DRY_RUN == 0 )); then
  require_command systemctl
  [[ -d /run/systemd/system ]] || fail "systemd does not appear to be running on this host"
  [[ $EUID -eq 0 ]] || fail "run this script as root"
fi

NOLOGIN_SHELL="$(command -v nologin || true)"
if [[ -z "$NOLOGIN_SHELL" ]]; then
  if [[ -x /usr/sbin/nologin ]]; then
    NOLOGIN_SHELL="/usr/sbin/nologin"
  elif [[ -x /sbin/nologin ]]; then
    NOLOGIN_SHELL="/sbin/nologin"
  else
    NOLOGIN_SHELL="/bin/false"
  fi
fi

TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
RELEASE_LABEL="$(basename "$RELEASE_DIR" | tr -cs 'A-Za-z0-9._-' '-')"
TARGET_RELEASE="$INSTALL_ROOT/releases/${TIMESTAMP}-${RELEASE_LABEL}"
CURRENT_LINK="$INSTALL_ROOT/current"
SHARED_DIR="$INSTALL_ROOT/shared"
SHARED_WORKFLOWS="$SHARED_DIR/workflows"
SHARED_ENV="$SHARED_DIR/.env"
UNIT_PATH="$SYSTEMD_DIR/$SERVICE_NAME.service"

log "Deploying Symphony release"
log "  release bundle: $RELEASE_DIR"
log "  install root:   $INSTALL_ROOT"
log "  data root:      $DATA_ROOT"
log "  service name:   $SERVICE_NAME"
log "  service user:   $SERVICE_USER:$SERVICE_GROUP"
log "  service home:   $SERVICE_HOME"
log "  workspace root: $WORKSPACE_ROOT"

if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  require_command groupadd
  run groupadd --system "$SERVICE_GROUP"
fi

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  require_command useradd
  run useradd --system --gid "$SERVICE_GROUP" --home-dir "$SERVICE_HOME" --create-home --shell "$NOLOGIN_SHELL" "$SERVICE_USER"
fi

run install -d -m 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/releases" "$SHARED_DIR"
run install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$DATA_ROOT" "$WORKSPACE_ROOT"
if [[ ! -d "$SERVICE_HOME" ]]; then
  run install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$SERVICE_HOME"
fi
run install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$SERVICE_HOME/.codex" "$SERVICE_HOME/.config" "$SERVICE_HOME/.config/gh" "$SERVICE_HOME/.ssh"

run install -d -m 0755 "$TARGET_RELEASE"
run cp -R "$RELEASE_DIR"/. "$TARGET_RELEASE"/
run chmod 0755 "$TARGET_RELEASE/symphony"

if [[ ! -f "$SHARED_ENV" ]]; then
  if [[ -f "$RELEASE_DIR/.env" ]]; then
    run install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0600 "$RELEASE_DIR/.env" "$SHARED_ENV"
  else
    if (( DRY_RUN )); then
      log "Would create empty env file: $SHARED_ENV"
    else
      install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0600 /dev/null "$SHARED_ENV"
    fi
  fi
  log "Seeded shared env file at $SHARED_ENV"
else
  log "Preserving existing shared env file at $SHARED_ENV"
fi

WORKFLOW_ACTION="preserve"
if [[ ! -d "$SHARED_WORKFLOWS" ]] || ! has_workflow_files "$SHARED_WORKFLOWS"; then
  WORKFLOW_ACTION="seed"
elif (( SYNC_WORKFLOWS )); then
  WORKFLOW_ACTION="sync"
fi

case "$WORKFLOW_ACTION" in
  seed)
    log "Seeding shared workflows from release bundle"
    seed_or_sync_workflows "$RELEASE_DIR/workflows" "$SHARED_WORKFLOWS" "seed"
    rewrite_tmp_workspace_roots "$SHARED_WORKFLOWS" "$WORKSPACE_ROOT"
    ;;
  sync)
    log "Replacing shared workflows from release bundle"
    seed_or_sync_workflows "$RELEASE_DIR/workflows" "$SHARED_WORKFLOWS" "sync"
    rewrite_tmp_workspace_roots "$SHARED_WORKFLOWS" "$WORKSPACE_ROOT"
    ;;
  preserve)
    log "Preserving existing shared workflows at $SHARED_WORKFLOWS"
    ;;
esac

run chown -R "$SERVICE_USER:$SERVICE_GROUP" "$SHARED_DIR" "$DATA_ROOT"
run ln -sfn "$TARGET_RELEASE" "$CURRENT_LINK"

write_systemd_unit "$UNIT_PATH" "$CURRENT_LINK" "$SHARED_ENV" "$SHARED_WORKFLOWS" "$SERVICE_USER" "$SERVICE_GROUP" "$SERVICE_HOME"

if (( DRY_RUN == 0 )); then
  run systemctl daemon-reload
  run systemctl enable "$SERVICE_NAME.service"
  if (( START_SERVICE )); then
    run systemctl restart "$SERVICE_NAME.service"
    run systemctl --no-pager --full status "$SERVICE_NAME.service"
  else
    log "Skipping service restart due to --no-start"
  fi
else
  run systemctl daemon-reload
  run systemctl enable "$SERVICE_NAME.service"
  if (( START_SERVICE )); then
    run systemctl restart "$SERVICE_NAME.service"
    run systemctl --no-pager --full status "$SERVICE_NAME.service"
  fi
fi

log ""
log "Deployment complete."
log "Mutable files are stored outside the versioned release:"
log "  env file:   $SHARED_ENV"
log "  workflows:  $SHARED_WORKFLOWS"
log "  workspaces: $WORKSPACE_ROOT"
log ""
log "If this is the first host setup, authenticate the service user before relying on automation:"
log "  sudo -u $SERVICE_USER env HOME=$SERVICE_HOME XDG_CONFIG_HOME=$SERVICE_HOME/.config codex login --device-auth"
log "  sudo -u $SERVICE_USER env HOME=$SERVICE_HOME XDG_CONFIG_HOME=$SERVICE_HOME/.config gh auth login"
