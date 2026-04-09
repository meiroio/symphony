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
  - `POST <tracker.webhook_path>` for Linear webhooks (default `/api/v1/webhooks/linear`)

## Runtime

```bash
cd bun
bun install
bun run src/cli.ts /absolute/path/to/WORKFLOW.md --port 8787
```

If no workflow path is passed, the CLI uses `./WORKFLOW.md` from the current working directory.

## Binary Release

Build a portable release directory with:

- compiled `symphony` binary
- `.env` template
- editable `workflows/` copied from the current local workflow directory

Current-platform build:

```bash
cd bun
bun run build:release
```

Cross-compile for Hetzner x64:

```bash
cd bun
bun run build:release:linux-x64
```

Cross-compile for Hetzner ARM64:

```bash
cd bun
bun run build:release:linux-arm64
```

Artifact layout:

```text
dist/release/<target>/
  symphony
  .env
  workflows/
```

Run the compiled binary from inside the release directory:

```bash
cd dist/release/<target>
./symphony ./workflows
```

Notes:

- The build reads workflow files from `./workflows` by default and fails if the directory is missing or empty.
- Workflow files are not embedded into the binary; they stay as normal `.md` files and can be edited in place after deployment.
- The generated `.env` is copied from `.env.example`; fill in real secrets before deployment.
- Use `--target bun-linux-x64` or `--target bun-linux-arm64` through `scripts/build-release.ts` for explicit platform targets.

## Bare Metal (systemd)

For Linux hosts, the default deployment flow is:

```bash
cd bun
./scripts/deploy-bare-metal.sh --ssh-target deploy@example.com
```

That local wrapper:

- builds `dist/release/<target>/` locally when `--release-dir` is not provided
- uploads the release bundle to the server with `scp`
- uploads and runs the remote installer script over `ssh`

Remote install behavior:

- installs the bundle into a versioned release under `/opt/symphony/releases`
- creates `/opt/symphony/current` as the active symlink
- preserves mutable host state under `/opt/symphony/shared`
- installs `/etc/systemd/system/symphony.service`
- reuses the existing service user's login home when that user already exists, otherwise creates a service home under `/var/lib/symphony`
- creates a persistent workspace root under `/var/lib/symphony`

Default persistent paths:

```text
/opt/symphony/current
/opt/symphony/shared/.env
/opt/symphony/shared/workflows/
/var/lib/symphony/workspaces
```

Notes:

- `deploy-bare-metal.sh` is intended to be run locally.
- `install-bare-metal-service.sh` is intended to be run on the Linux server itself.
- If the `symphony` user already exists, the installer now reuses that account's home directory for `HOME`, Codex auth, GitHub auth, and SSH config.
- The generated `systemd` unit includes the service user's `~/.bun/bin` and `~/.local/bin` on `PATH`, so Bun-installed `codex` is available to workflow commands.
- On first install, it seeds `shared/workflows/` from the release bundle and rewrites the shipped sample `workspace.root` value from `/tmp/symphony-bun-workspaces` to `/var/lib/symphony/workspaces`.
- Existing `shared/.env` and `shared/workflows/` are preserved on later deploys by default.
- Use `--sync-workflows` when you want to replace the shared workflow files from a newer release bundle.
- Use `--workspace-root <path>` if you want a different persistent workspace location.

Manual server-side install example after copying files yourself:

```bash
sudo ./scripts/install-bare-metal-service.sh --release-dir /tmp/symphony-release
```

First-time auth for the service user:

```bash
SERVICE_HOME="$(getent passwd symphony | cut -d: -f6)"
sudo -u symphony env HOME="$SERVICE_HOME" XDG_CONFIG_HOME="$SERVICE_HOME/.config" codex login --device-auth
sudo -u symphony env HOME="$SERVICE_HOME" XDG_CONFIG_HOME="$SERVICE_HOME/.config" gh auth login
```

## Docker

Build image:

```bash
cd bun
docker build -t symphony-bun:latest .
```

Run via Docker Compose (prewired for the two production workflows):

```bash
cd bun
cp .env.example .env
# edit .env and set your secrets
docker compose up --build
```

Run hardened profile (read-only root filesystem + dropped capabilities):

```bash
cd bun
docker compose -f docker-compose.yml -f docker-compose.hardened.yml up --build
```

Auth and tooling in container:

- Image installs `codex`, `git`, `gh`, `jq`, `ripgrep`, `fd`, `curl`, `ssh`, `zip/unzip`, and core shell utilities.
- Codex auth uses account login (device flow).
- One-time setup after container starts:
  - `docker compose exec symphony codex login --device-auth`
  - `docker compose exec symphony codex login status`
- Codex credentials persist in Docker volume `symphony_codex_home` (`/home/bun/.codex`).
- GitHub auth uses host CLI session mounted into container (`~/.config/gh`).
- One-time setup on host:
  - `gh auth login`
  - `gh auth status`
  - `gh auth setup-git`
- Use `.env.example` as a template for required env vars.
- For Docker, set `SYMPHONY_DASHBOARD_HOST=0.0.0.0` (already in `.env.example`) so host port mapping can reach the dashboard.

Run (image-bundled workflows):

```bash
cd bun
docker run --rm \
  -p 8788:8788 \
  -e LINEAR_API_KEY="$LINEAR_API_KEY" \
  -e LINEAR_PIP_WEBHOOK_SECRET="$LINEAR_PIP_WEBHOOK_SECRET" \
  -e LINEAR_TIM_WEBHOOK_SECRET="$LINEAR_TIM_WEBHOOK_SECRET" \
  -v /tmp/symphony-bun-workspaces:/tmp/symphony-bun-workspaces \
  -v symphony_codex_home:/home/bun/.codex \
  -v symphony_gh_home:/home/bun/.config/gh \
  -v "${HOME}/.ssh:/home/bun/.ssh:ro" \
  -v "${HOME}/.gitconfig:/home/bun/.gitconfig:ro" \
  symphony-bun:latest
```

Notes:

- Container entrypoint runs `bun run src/run-workflows.ts ./workflows`.
- Image bakes `./workflows` at build time.
- Rebuild the image whenever packaged workflow files change.
- Publish `8788` for dashboard and Bun webhook ingress.
- For Git operations inside agents, mount SSH and git config (compose already does this).

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

## Linear Webhook Mode

To run push-driven orchestration (Linear -> Symphony) instead of periodic polling:

1. Set workflow tracker webhook config:

```yaml
tracker:
  kind: linear
  webhook_path: "/api/v1/webhooks/linear"
  webhook_secret: "$LINEAR_<WORKFLOW>_WEBHOOK_SECRET"
polling:
  interval_ms: 0
```

2. Expose the aggregate dashboard/ingress port publicly (HTTPS) and configure Linear webhook URLs by workflow id:

```text
https://<your-host>/api/v1/webhooks/linear-team-review
https://<your-host>/api/v1/webhooks/linear-timetracking-factory
```

3. Use a distinct signing secret per workflow and reference the matching env var in that workflow file.
   Example: `LINEAR_PIP_WEBHOOK_SECRET` for `linear-team-review`, `LINEAR_TIM_WEBHOOK_SECRET` for `linear-timetracking-factory`.

Notes:

- `polling.interval_ms: 0` disables periodic polling loops.
- Symphony still supports `POST /api/v1/refresh` for manual kicks.
- Keep `webhook_secret` set in production; unsigned payloads are rejected when secret is configured.
- In multi-workflow mode, Bun routes webhook ingress on `8788` to the matching workflow by `workflow.id`.

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
- For GitHub HTTPS auth via `gh`, set `repositories[].transport: gh` and use `https://github.com/<owner>/<repo>.git` or `<owner>/<repo>` as the remote.
- For team-wide review automation, start from `./WORKFLOW.linear.team-review.sample.md` and use `tracker.team_key` (for example `PIP`) instead of `project_slug`.
- For phased software-factory automation (Define -> In Progress -> Code Review -> Design Review -> Testing -> Done), start from `./WORKFLOW.linear.software-factory.sample.md`.
- For the TimeTracking factory specifically, start from `./WORKFLOW.linear.timetracking.factory.sample.md`.
- Label-based routing is supported via `tracker.required_labels`; combine it with `active_states: ["*"]` for label-first workflows.
- Current team-review local flow is bound to `In Review`, runs `review-swarm` plus `web-design-guidelines` in the same pass, applies label `crok` on approval, and leaves final routing to a human.

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
- `repositories[].transport` defaults to `git`; set it to `gh` to clone through authenticated GitHub CLI instead of raw `git clone`.
- If a repository checkout branch is omitted or env resolution is missing, Symphony falls back to `SYMPHONY_DEFAULT_BRANCH` (or `main` when unset).
- `prompt.variables` values are exposed to templates under `vars.*` (example: `{{ vars.testing_command }}`).
- `agent.continuation_states` controls which states auto-retry immediately after a successful run.
- For full MVP verification details, use
  [`docs/mvp-manual-test.md`](./docs/mvp-manual-test.md).
- `repositories` entries are cloned on workspace creation, so the agent works in a deterministic repo layout.
- When `repositories[].transport` is `gh`, Symphony clones with `gh repo clone` and then keeps `origin` aligned with the configured HTTPS remote for later `fetch`/`pull` runs.
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
