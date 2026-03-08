# Symphony Bun (WIP)

This directory contains an in-progress Bun/TypeScript implementation of Symphony based on [`../SPEC.md`](../SPEC.md).

## Current Scope

Implemented foundation:

- `WORKFLOW.md` loader and parsing (`yaml front matter + prompt body`)
- Last-known-good workflow reload store
- Typed config layer with defaults and `$VAR` resolution
- Linear tracker read client (candidate fetch, state fetch, terminal fetch)
- Workspace manager with sanitized per-issue directories and hook execution
- Orchestrator core loop (poll, reconcile, dispatch, retries, snapshot)
- Codex app-server protocol client (initialize/thread/start/turn/start + streaming events)
- Optional HTTP server with:
  - `GET /`
  - `GET /api/v1/state`
  - `GET /api/v1/:issue_identifier`
  - `POST /api/v1/refresh`

## Runtime

```bash
cd bun
bun install
bun run src/cli.ts /absolute/path/to/WORKFLOW.md --port 8787
```

If no workflow path is passed, the CLI uses `./WORKFLOW.md` from the current working directory.

Single-workflow shortcuts from `package.json`:

```bash
cd bun
bun run dev
bun run start
```

Run multiple workflows in one process:

```bash
cd bun
bun run src/cli.ts ./workflows/WORKFLOW.linear.local.md ./workflows/WORKFLOW.linear.team-review.local.md
```

Notes:

- One Symphony service is started per workflow file.
- Each workflow should use a distinct `server.port` to avoid HTTP port conflicts.
- `--port` override is only valid when running a single workflow.
- When running multiple workflows, Symphony also starts an aggregate dashboard on `127.0.0.1:8788` by default.
- Override aggregate dashboard port with `--dashboard-port <port>` (multi-workflow mode only) or `SYMPHONY_DASHBOARD_PORT`.
- Optional: set `workflow.id` in workflow front matter for a stable identity in logs and API payloads.

Example with explicit aggregate dashboard port:

```bash
cd bun
bun run src/cli.ts --dashboard-port 8788 ./workflows/WORKFLOW.linear.local.md ./workflows/WORKFLOW.linear.team-review.local.md
```

Run all workflows from the `workflows/` directory:

```bash
cd bun
bun run workflows
```

`bun run workflows` is the directory-mode launcher:

- It loads every `.md` workflow file from `./workflows`.
- Files are discovered alphabetically.
- Startup fails if the directory contains no workflow files.
- This is the simplest way to run the whole local or production workflow set.
- To use a different directory, run `bun run src/run-workflows.ts /absolute/path/to/workflows`.

## Aggregate Dashboard

The aggregate dashboard is available only when Symphony is running more than one workflow in the same process.

Default URL:

```bash
http://127.0.0.1:8788
```

What it shows:

- workflow list on the left
- selected workflow detail on the right
- running agents
- retry queue
- polling state
- token totals
- raw JSON inspector for debugging

Operator controls:

- click a workflow to inspect it
- filter workflows by id or path
- `j` / `k` or arrow keys to move selection
- `r` to trigger refresh
- toggle `Auto Sweep` to pause or resume auto-refresh

Dashboard port configuration:

- `bun run src/cli.ts <workflow...>`: use `--dashboard-port <port>` or `SYMPHONY_DASHBOARD_PORT`
- `bun run workflows`: use `SYMPHONY_DASHBOARD_PORT`

Example:

```bash
cd bun
SYMPHONY_DASHBOARD_PORT=8799 bun run workflows
```

## Testing

```bash
cd bun
bun test
bun run typecheck
```

## Local Test Flow

Use this sequence when validating local changes before pushing:

1. Install dependencies.

```bash
cd /Users/vorcigernix/Dev/symphony/bun
bun install
```

2. Run static checks and unit tests.

```bash
cd /Users/vorcigernix/Dev/symphony/bun
bun run typecheck
bun test
```

3. Run the HTTP contract smoke test.

```bash
cd /Users/vorcigernix/Dev/symphony
./bun/scripts/mvp-smoke.sh --workflow ./bun/WORKFLOW.test.md --port 8789
```

4. Run against the real Symphony Linear project.

Project:

- [`Symphony` in Linear](https://linear.app/meiro-io/project/symphony-2f9fcdc281e6/overview)
- `project_slug`: `symphony-2f9fcdc281e6`

Workflow file:

- Start from `./WORKFLOW.linear.sample.md`.
- Copy it to `./workflows/WORKFLOW.linear.local.md` and fill in your project slug/token setup.
- Use `./workflows/WORKFLOW.linear.local.md` (git-ignored).
- Do not commit tokens; keep secrets local.
- Configure `repositories` so each issue workspace clones the correct repo(s) automatically.
- Make sure `repositories[].remote` points to the correct repository for that workflow.
- For team-wide review automation, start from `./WORKFLOW.linear.team-review.sample.md` and use `tracker.team_key` (for example `PIP`) instead of `project_slug`.
- For phased software-factory automation (Define -> In Progress -> Code Review -> Design Review -> Testing -> Done), start from `./WORKFLOW.linear.software-factory.sample.md`.
- For the TimeTracking factory specifically, start from `./WORKFLOW.linear.timetracking.factory.sample.md`.
- Label-based routing is supported via `tracker.required_labels`; combine it with `active_states: ["*"]` for label-first workflows.
- Current team-review local flow uses wildcard routing and applies label `crok` on approved reviews; human manually decides QA routing.

```bash
cd /Users/vorcigernix/Dev/symphony/bun
bun run src/cli.ts ./workflows/WORKFLOW.linear.local.md --port 8790
```

Notes:

- `WORKFLOW.test.md` uses dummy Linear credentials, so tracker calls can fail with
  warnings during smoke; this is expected.
- If `workflows/WORKFLOW.linear.local.md` uses `api_key: "$LINEAR_API_KEY"`, export your
  token in the same shell before starting the service.
- `repositories[].checkout` supports env references (for example `"$SYMPHONY_DEFAULT_BRANCH"`).
- If a repository checkout branch is omitted or env resolution is missing, Symphony falls back to `SYMPHONY_DEFAULT_BRANCH` (or `main` when unset).
- `prompt.variables` values are exposed to templates under `vars.*` (example: `{{ vars.testing_command }}`).
- `agent.continuation_states` controls which states auto-retry immediately after a successful run.
- For full MVP verification details, use
  [`docs/mvp-manual-test.md`](./docs/mvp-manual-test.md).
- `repositories` entries are cloned on workspace creation, so the agent works in a deterministic repo layout.
- On subsequent runs for the same workspace, Symphony attempts `git fetch` + `git pull --ff-only` for configured repositories when the working tree is clean.
- If a repository has local changes, pull is skipped for safety and work continues with current workspace state.
- Team scope is supported directly in polling (`tracker.team_key` / `tracker.team_id`); a separate webhook is not required for team visibility.

## Manual MVP Validation

Fast local smoke:

```bash
cd /Users/vorcigernix/Dev/symphony
./bun/scripts/mvp-smoke.sh --workflow ./bun/WORKFLOW.test.md --port 8789
```

Full manual checklist (including real Linear + Codex validation):

- [`docs/mvp-manual-test.md`](./docs/mvp-manual-test.md)

## HTTP Framework Choices

The current adapter uses Elysia, and the core remains framework-agnostic. You can swap to:

1. Bare `Bun.serve` for minimal dependencies.
2. Hono for lightweight edge-style routing.
3. Fastify (Node compatibility mode) for richer middleware ecosystems.
