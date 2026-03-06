# Symphony Bun

This directory contains the Bun/TypeScript Symphony implementation based on
[`../SPEC.md`](../SPEC.md). The HTTP adapter currently uses Elysia.

## What Is Implemented

- `WORKFLOW.md` loader (YAML front matter + prompt body)
- Last-known-good workflow reload store
- Typed config layer with defaults
- Linear tracker adapter
- Orchestrator loop (poll, dispatch, reconcile, retry, snapshot)
- Workspace manager with hook support
- Codex app-server client
- HTTP status surface:
  - `GET /`
  - `GET /api/v1/state`
  - `GET /api/v1/:issue_identifier`
  - `POST /api/v1/refresh`

## Prerequisites

- Bun installed (`bun --version`)
- For real runs: Codex CLI available as `codex`
- For Linear mode: a Linear API token
- For smoke script: `curl`

## Quick Start

1. Install dependencies.

```bash
cd /Users/vorcigernix/Dev/symphony/bun
bun install
```

2. Export your Linear token.

```bash
export LINEAR_API_KEY="<your-token>"
```

3. Start in development mode using the default workflow at `./WORKFLOW.md`.

```bash
cd /Users/vorcigernix/Dev/symphony/bun
bun dev
```

4. Open the status endpoints.

```bash
curl -s http://127.0.0.1:8789/api/v1/state | jq .
curl -s -X POST http://127.0.0.1:8789/api/v1/refresh | jq .
```

5. Optional: open the dashboard at
`http://127.0.0.1:8789/`.

Run modes:

```bash
cd /Users/vorcigernix/Dev/symphony/bun
bun dev   # NODE_ENV=development
bun prod  # NODE_ENV=production
```

Both commands start `src/cli.ts` with the default config file `./WORKFLOW.md`.

If you need a different workflow or port, pass CLI args after `--`:

```bash
bun run prod -- /absolute/path/to/WORKFLOW.md --port 8790
```

Raw CLI usage:

```bash
bun run src/cli.ts [--port <port>] [path-to-WORKFLOW.md]
```

- If no path is provided, it uses `./WORKFLOW.md` from the current directory.
- `--port` overrides `server.port` from workflow config.

## Workflow File Basics

Your workflow file contains:

- YAML front matter with runtime config
- Prompt body rendered with Liquid variables

Minimal Linear workflow:

```md
---
tracker:
  kind: linear
  project_slug: "YOUR_PROJECT_SLUG"
  api_key: "$LINEAR_API_KEY"
  active_states:
    - Todo
    - In Progress
polling:
  interval_ms: 5000
workspace:
  root: /tmp/symphony-bun-workspaces
agent:
  max_concurrent_agents: 1
  max_turns: 3
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
server:
  port: 8790
---
You are working on issue {{ issue.identifier }}.
Title: {{ issue.title }}
Description:
{{ issue.description }}
{% if attempt %}Continuation attempt {{ attempt }}.{% endif %}
```

`./WORKFLOW.md` is included in this directory and is valid for both `bun dev` and `bun prod`.
For Linear runs in this repo:

- tracked template: `./WORKFLOW.linear.example.md`
- local tokened file (git-ignored): `./WORKFLOW.linear.local.md`

Run the local tokened workflow:

```bash
cd /Users/vorcigernix/Dev/symphony/bun
bun run linear:local
```

## Configuration Reference

All keys live in the YAML front matter of `WORKFLOW.md`.

| Key | Default | Notes |
| --- | --- | --- |
| `tracker.kind` | none | Required. Must be `linear` for runtime dispatch. |
| `tracker.endpoint` | `https://api.linear.app/graphql` | Linear GraphQL endpoint. |
| `tracker.api_key` | `$LINEAR_API_KEY` fallback | Required. Supports `$ENV_VAR`. |
| `tracker.project_slug` | none | Required. |
| `tracker.assignee` | `$LINEAR_ASSIGNEE` fallback | Optional. `"me"` resolves viewer id from Linear token. |
| `tracker.active_states` | `Todo`, `In Progress` | Array or CSV string. |
| `tracker.terminal_states` | `Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done` | Used for reconciliation and cleanup. |
| `polling.interval_ms` | `30000` | Poll cadence. |
| `workspace.root` | `${tmpdir}/symphony_workspaces` | Supports `$ENV_VAR` and `~`. |
| `hooks.after_create` | none | Runs once on new workspace creation. |
| `hooks.before_run` | none | Runs before each run attempt; failure stops run. |
| `hooks.after_run` | none | Runs after each run attempt; failures are logged and ignored. |
| `hooks.before_remove` | none | Runs before workspace cleanup. |
| `hooks.timeout_ms` | `60000` | Hook process timeout. |
| `agent.max_concurrent_agents` | `10` | Global concurrency ceiling. |
| `agent.max_concurrent_agents_by_state` | none | Per-state overrides, example: `{ "in progress": 2 }`. |
| `agent.max_turns` | `20` | Max turns per run before continuation/retry logic. |
| `agent.max_retry_backoff_ms` | `300000` | Retry backoff cap. |
| `codex.command` | `codex app-server` | Shell command started in workspace. |
| `codex.approval_policy` | structured reject policy | String or object. |
| `codex.thread_sandbox` | `workspace-write` | Sent to `thread/start`. |
| `codex.turn_sandbox_policy` | workspaceWrite policy | Object sent to `turn/start`. |
| `codex.turn_timeout_ms` | `3600000` | Max wall time for one turn. |
| `codex.read_timeout_ms` | `5000` | RPC read timeout for request/response calls. |
| `codex.stall_timeout_ms` | `300000` | Restart stalled runs after inactivity. |
| `server.host` | `127.0.0.1` | HTTP bind host. |
| `server.port` | none | HTTP disabled when omitted unless `--port` is passed. |

Notes:

- Workflow file reloads while running. If reload fails, the service keeps the last known good config.
- Empty prompt body falls back to a default prompt template.

## Smoke Test

Fast smoke test (linear validation + HTTP contract checks):

```bash
cd /Users/vorcigernix/Dev/symphony
./bun/scripts/mvp-smoke.sh --workflow ./bun/WORKFLOW.test.md --port 8789
```

`WORKFLOW.test.md` uses dummy Linear credentials so the service can start without a real token.
Tracker calls are expected to fail and log warnings during this smoke check.

Options:

```bash
./bun/scripts/mvp-smoke.sh --help
```

Supported overrides:

- `WORKFLOW_PATH`
- `PORT`
- `ISSUE_IDENTIFIER`
- `STARTUP_TIMEOUT_SECONDS`

Expected output includes:

- `Endpoint contract checks passed`
- `GET /api/v1/state -> 200`
- `POST /api/v1/refresh -> 202`
- `POST /api/v1/state -> 405`
- unknown route -> `404`

For full manual verification (including real Linear + Codex), use
[`docs/mvp-manual-test.md`](./docs/mvp-manual-test.md).

## Local Validation

```bash
cd /Users/vorcigernix/Dev/symphony/bun
bun run typecheck
bun test
```
