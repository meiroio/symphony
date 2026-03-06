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
