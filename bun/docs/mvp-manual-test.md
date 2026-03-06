# MVP Manual Test Checklist

This checklist verifies that Symphony Bun is usable end-to-end for MVP.

## 1. Prerequisites

- Bun installed (`bun --version`)
- Dependencies installed:

```bash
cd /Users/vorcigernix/Dev/symphony/bun
bun install
```

- Type safety and unit test baseline green:

```bash
cd /Users/vorcigernix/Dev/symphony/bun
bun run typecheck
bun test
```

## 2. Fast Local Smoke (HTTP contract)

Run the automated endpoint smoke test:

```bash
cd /Users/vorcigernix/Dev/symphony
./bun/scripts/mvp-smoke.sh --workflow ./bun/WORKFLOW.test.md --port 8789
```

Pass criteria:

- `GET /api/v1/state` returns `200`
- `POST /api/v1/refresh` returns `202`
- `POST /api/v1/state` returns `405`
- unknown route returns `404`
- script exits with `Endpoint contract checks passed`

Notes:

- `WORKFLOW.test.md` intentionally uses dummy Linear credentials.
- During smoke, tracker fetches can fail and log warnings; that is expected for this check.

## 3. Real Linear + Codex Smoke (required before MVP signoff)

Create a workflow file for your test Linear project (example below):

```md
---
tracker:
  kind: linear
  project_slug: "<your-linear-project-slug>"
  api_key: "$LINEAR_API_KEY"
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
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
```

Set auth and start service:

```bash
export LINEAR_API_KEY="<your-token>"
cd /Users/vorcigernix/Dev/symphony/bun
bun run src/cli.ts /absolute/path/to/WORKFLOW.linear.md --port 8790
```

While running, verify:

1. Open `http://127.0.0.1:8790/api/v1/state` repeatedly.
2. Move one test issue into `Todo` in that Linear project.
3. Confirm workspace is created under `/tmp/symphony-bun-workspaces/<ISSUE_IDENTIFIER_SANITIZED>`.
4. Confirm `/api/v1/state` shows the issue in `running` during execution.
5. Confirm the issue eventually leaves `running` and either:
   - finishes cleanly and may requeue continuation briefly, or
   - enters retry queue with a clear error.
6. Move the issue to terminal state (`Done`/`Closed`).
7. Confirm the running session is terminated on next reconciliation and workspace cleanup occurs for terminal issue.

Pass criteria:

- No orchestrator crash.
- Polling and refresh continue working.
- Runtime state transitions visible through `/api/v1/state`.
- Terminal-state reconciliation stops runs reliably.

## 4. Manual API Contract Checks

With service running:

```bash
curl -i http://127.0.0.1:8790/api/v1/state
curl -i -X POST http://127.0.0.1:8790/api/v1/refresh
curl -i -X POST http://127.0.0.1:8790/api/v1/state
curl -i http://127.0.0.1:8790/does-not-exist
```

Expected status codes:

- `/api/v1/state` -> `200`
- `/api/v1/refresh` -> `202`
- wrong method on known route -> `405`
- unknown route -> `404`

## 5. MVP Exit Decision

MVP can be considered test-complete when all are true:

- `bun run typecheck` passes
- `bun test` passes
- HTTP contract smoke script passes
- real Linear+Codex smoke pass criteria are met at least once on a test project
