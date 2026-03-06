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
- Copy it to `./WORKFLOW.linear.local.md` and fill in your project slug/token setup.
- Use `./WORKFLOW.linear.local.md` (git-ignored).
- Do not commit tokens; keep secrets local.

```bash
cd /Users/vorcigernix/Dev/symphony/bun
bun run src/cli.ts ./WORKFLOW.linear.local.md --port 8790
```

Notes:

- `WORKFLOW.test.md` uses dummy Linear credentials, so tracker calls can fail with
  warnings during smoke; this is expected.
- If `WORKFLOW.linear.local.md` uses `api_key: "$LINEAR_API_KEY"`, export your
  token in the same shell before starting the service.
- For full MVP verification details, use
  [`docs/mvp-manual-test.md`](./docs/mvp-manual-test.md).

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
