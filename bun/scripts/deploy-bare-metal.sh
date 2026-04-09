#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy-bare-metal.sh --ssh-target user@host [options]

Builds or reuses a compiled Symphony release bundle locally, uploads it to a
remote Linux host via scp, and invokes the remote systemd installer there.

Options:
  --ssh-target USER@HOST   Remote SSH target (required)
  --ssh-port PORT          Remote SSH port
  --identity FILE          SSH identity file
  --release-dir PATH       Existing local release bundle to upload
  --workflow-dir PATH      Local workflow directory to package when building
  --target TARGET          Bun compile target when building (default: bun-linux-x64)
  --env-file PATH          Local env file copied into the release bundle before upload
  --remote-stage-dir PATH  Remote temporary staging directory (default: /tmp/symphony-deploy)
  --install-root PATH      Remote install root passed to the installer (default: /opt/symphony)
  --data-root PATH         Remote persistent data root (default: /var/lib/symphony)
  --workspace-root PATH    Remote persistent workspace root
  --service-name NAME      Remote systemd service name (default: symphony)
  --user NAME              Remote service user (default: symphony)
  --group NAME             Remote service group
  --systemd-dir PATH       Remote systemd unit directory (default: /etc/systemd/system)
  --sync-workflows         Replace shared remote workflows with bundle workflows
  --no-start               Install or update the remote service, but do not restart it
  --no-sudo                Run the remote installer directly instead of through sudo
  --keep-stage             Leave the uploaded bundle and installer in the remote staging directory
  --dry-run                Print actions without executing them
  --help                   Show this help

Examples:
  ./scripts/deploy-bare-metal.sh --ssh-target deploy@example.com
  ./scripts/deploy-bare-metal.sh \
    --ssh-target root@example.com \
    --target bun-linux-arm64 \
    --workflow-dir ./workflows \
    --sync-workflows \
    --no-sudo
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

run_in_root() {
  if (( DRY_RUN )); then
    printf '+ (cd %q &&' "$ROOT_DIR"
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf ')\n'
    return 0
  fi

  (
    cd "$ROOT_DIR"
    "$@"
  )
}

require_command() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
  done
}

resolve_existing_path() {
  local path="$1"
  (
    cd "$(dirname "$path")"
    printf '%s/%s\n' "$(pwd -P)" "$(basename "$path")"
  )
}

shell_join() {
  local joined=""
  local arg
  for arg in "$@"; do
    printf -v joined '%s%q ' "$joined" "$arg"
  done
  printf '%s' "${joined% }"
}

ssh_run() {
  local remote_command="$1"
  local wrapped_command

  wrapped_command=$(printf 'bash -lc %q' "$remote_command")

  if (( DRY_RUN )); then
    printf '+'
    for arg in "${SSH_BASE[@]}" "$SSH_TARGET" "$wrapped_command"; do
      printf ' %q' "$arg"
    done
    printf '\n'
    return 0
  fi

  "${SSH_BASE[@]}" "$SSH_TARGET" "$wrapped_command"
}

ssh_run_tty() {
  local remote_command="$1"
  local wrapped_command

  wrapped_command=$(printf 'bash -lc %q' "$remote_command")

  if (( DRY_RUN )); then
    printf '+'
    for arg in "${SSH_BASE[@]}" -t "$SSH_TARGET" "$wrapped_command"; do
      printf ' %q' "$arg"
    done
    printf '\n'
    return 0
  fi

  "${SSH_BASE[@]}" -t "$SSH_TARGET" "$wrapped_command"
}

SCRIPTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "$SCRIPTS_DIR/.." && pwd -P)"

SSH_TARGET=""
SSH_PORT=""
IDENTITY_FILE=""
RELEASE_DIR=""
WORKFLOW_DIR=""
BUILD_TARGET="bun-linux-x64"
ENV_FILE=""
REMOTE_STAGE_DIR="/tmp/symphony-deploy"
INSTALL_ROOT="/opt/symphony"
DATA_ROOT="/var/lib/symphony"
WORKSPACE_ROOT=""
SERVICE_NAME="symphony"
SERVICE_USER="symphony"
SERVICE_GROUP=""
SYSTEMD_DIR="/etc/systemd/system"
SYNC_WORKFLOWS=0
START_SERVICE=1
USE_SUDO=1
KEEP_STAGE=0
DRY_RUN=0

while (($# > 0)); do
  case "$1" in
    --ssh-target)
      [[ $# -ge 2 ]] || fail "--ssh-target requires a value"
      SSH_TARGET="$2"
      shift 2
      ;;
    --ssh-port)
      [[ $# -ge 2 ]] || fail "--ssh-port requires a value"
      SSH_PORT="$2"
      shift 2
      ;;
    --identity)
      [[ $# -ge 2 ]] || fail "--identity requires a path"
      IDENTITY_FILE="$2"
      shift 2
      ;;
    --release-dir)
      [[ $# -ge 2 ]] || fail "--release-dir requires a path"
      RELEASE_DIR="$2"
      shift 2
      ;;
    --workflow-dir)
      [[ $# -ge 2 ]] || fail "--workflow-dir requires a path"
      WORKFLOW_DIR="$2"
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || fail "--target requires a value"
      BUILD_TARGET="$2"
      shift 2
      ;;
    --env-file)
      [[ $# -ge 2 ]] || fail "--env-file requires a path"
      ENV_FILE="$2"
      shift 2
      ;;
    --remote-stage-dir)
      [[ $# -ge 2 ]] || fail "--remote-stage-dir requires a path"
      REMOTE_STAGE_DIR="$2"
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
    --no-sudo)
      USE_SUDO=0
      shift
      ;;
    --keep-stage)
      KEEP_STAGE=1
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

[[ -n "$SSH_TARGET" ]] || fail "--ssh-target is required"

require_command ssh scp basename dirname pwd cp chmod

if [[ -z "$RELEASE_DIR" ]]; then
  require_command bun
else
  RELEASE_DIR="$(resolve_existing_path "$RELEASE_DIR")"
fi

if [[ -n "$WORKFLOW_DIR" ]]; then
  WORKFLOW_DIR="$(resolve_existing_path "$WORKFLOW_DIR")"
fi

if [[ -n "$ENV_FILE" ]]; then
  ENV_FILE="$(resolve_existing_path "$ENV_FILE")"
fi

SSH_BASE=(ssh)
SCP_BASE=(scp)

if [[ -n "$SSH_PORT" ]]; then
  SSH_BASE+=(-p "$SSH_PORT")
  SCP_BASE+=(-P "$SSH_PORT")
fi

if [[ -n "$IDENTITY_FILE" ]]; then
  IDENTITY_FILE="$(resolve_existing_path "$IDENTITY_FILE")"
  SSH_BASE+=(-i "$IDENTITY_FILE")
  SCP_BASE+=(-i "$IDENTITY_FILE")
fi

if [[ -z "$RELEASE_DIR" ]]; then
  build_cmd=(bun run scripts/build-release.ts --target "$BUILD_TARGET")
  if [[ -n "$WORKFLOW_DIR" ]]; then
    build_cmd=(
      bun run scripts/build-release.ts
      "$WORKFLOW_DIR"
      --target
      "$BUILD_TARGET"
    )
  fi

  log "Building release bundle locally"
  run_in_root "${build_cmd[@]}"
  RELEASE_DIR="$ROOT_DIR/dist/release/$BUILD_TARGET"
fi

if (( DRY_RUN == 0 )) || [[ -d "$RELEASE_DIR" ]]; then
  [[ -d "$RELEASE_DIR" ]] || fail "release directory not found: $RELEASE_DIR"
  [[ -f "$RELEASE_DIR/symphony" ]] || fail "compiled binary not found: $RELEASE_DIR/symphony"
  [[ -d "$RELEASE_DIR/workflows" ]] || fail "workflow directory not found: $RELEASE_DIR/workflows"
else
  log "Skipping local release validation in dry-run mode: $RELEASE_DIR"
fi

if [[ -n "$ENV_FILE" ]]; then
  log "Injecting env file into release bundle"
  run cp "$ENV_FILE" "$RELEASE_DIR/.env"
fi

REMOTE_INSTALLER="$REMOTE_STAGE_DIR/install-bare-metal-service.sh"
REMOTE_RELEASE_DIR="$REMOTE_STAGE_DIR/$(basename "$RELEASE_DIR")"

log "Uploading release bundle to $SSH_TARGET"
ssh_run "$(printf 'rm -rf %q && mkdir -p %q' "$REMOTE_STAGE_DIR" "$REMOTE_STAGE_DIR")"
run "${SCP_BASE[@]}" "$SCRIPTS_DIR/install-bare-metal-service.sh" "$SSH_TARGET:$REMOTE_INSTALLER"
run "${SCP_BASE[@]}" -r "$RELEASE_DIR" "$SSH_TARGET:$REMOTE_STAGE_DIR/"

remote_install_args=(
  "$REMOTE_INSTALLER"
  --release-dir
  "$REMOTE_RELEASE_DIR"
  --install-root
  "$INSTALL_ROOT"
  --data-root
  "$DATA_ROOT"
  --service-name
  "$SERVICE_NAME"
  --user
  "$SERVICE_USER"
  --systemd-dir
  "$SYSTEMD_DIR"
)

if [[ -n "$WORKSPACE_ROOT" ]]; then
  remote_install_args+=(--workspace-root "$WORKSPACE_ROOT")
fi

if [[ -n "$SERVICE_GROUP" ]]; then
  remote_install_args+=(--group "$SERVICE_GROUP")
fi

if (( SYNC_WORKFLOWS )); then
  remote_install_args+=(--sync-workflows)
fi

if (( START_SERVICE == 0 )); then
  remote_install_args+=(--no-start)
fi

if (( DRY_RUN )); then
  remote_install_args+=(--dry-run)
fi

remote_install_command="$(shell_join "${remote_install_args[@]}")"
if (( USE_SUDO )); then
  remote_install_command="sudo ${remote_install_command}"
fi

remote_exec_command="$(printf 'chmod +x %q && %s' "$REMOTE_INSTALLER" "$remote_install_command")"

log "Running remote installer on $SSH_TARGET"
if (( USE_SUDO )); then
  ssh_run_tty "$remote_exec_command"
else
  ssh_run "$remote_exec_command"
fi

if (( KEEP_STAGE == 0 )); then
  log "Cleaning remote staging directory"
  ssh_run "$(printf 'rm -rf %q' "$REMOTE_STAGE_DIR")"
fi

log ""
log "Deploy complete."
log "Remote release bundle: $REMOTE_RELEASE_DIR"
log "Remote installer:      $REMOTE_INSTALLER"
