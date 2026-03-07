---
workflow:
  id: "linear-main"
tracker:
  kind: linear
  project_slug: "<your-linear-project-slug>"
  api_key: "$LINEAR_API_KEY"
  active_states:
    - Todo
    - In Progress
    - Rework
    - Merging
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
repositories:
  - id: app
    remote: "<your-repository-ssh-or-https-url>"
    checkout: main
    target: .
    primary: true
agent:
  max_concurrent_agents: 1
  max_turns: 20
codex:
  read_timeout_ms: 5000
  stall_timeout_ms: 600000
  turn_timeout_ms: 1800000
  command: codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=xhigh --model gpt-5.3-codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
server:
  host: 127.0.0.1
  port: 8790
---
You are working on Linear issue {{ issue.identifier }} (id: {{ issue.id }}).

Issue context:
- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- Current status: {{ issue.state }}
- Labels: {{ issue.labels }}
- URL: {{ issue.url }}

{% if issue.description %}
Description:
{{ issue.description }}
{% else %}
Description:
No description provided.
{% endif %}

{% if attempt %}
Continuation context:
- This is retry attempt #{{ attempt }}.
- Resume from current workspace state.
- Do not repeat completed investigation unless needed for new changes.
{% endif %}

Work only inside the provided workspace.

Execution contract:
1. This is an unattended run. Never ask a human to do follow-up actions.
2. Stop early only for true blockers (missing required auth/permissions/secrets/tooling).
3. End every run with exactly one outcome in `RUN_REPORT.md`: `DONE`, `DONE_LOCAL_ONLY`, or `BLOCKED`.
4. Never end silently.

State-routing behavior (copied from Elixir workflow, adapted to Bun):
1. Fetch fresh issue state at run start via `linear_graphql`.
2. Route by current state:
   - `Backlog`: do not modify state; post a short note and stop.
   - `Todo`: move to `In Progress`, then continue execution.
   - `In Progress` or `Rework`: continue execution.
   - `Human Review`: do not code; wait and stop.
   - `Merging`: perform merge-related checks/actions if possible; otherwise produce `BLOCKED` with exact reason.
   - terminal (`Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate`): stop.

Required execution loop:
1. Maintain one persistent Linear comment titled `## Codex Workpad`:
   - Reuse existing unresolved workpad comment if present.
   - Otherwise create it.
   - Keep plan, acceptance criteria, validation, and notes in that single comment.
2. At top of workpad, include environment stamp: `<hostname>:<abs-workdir>@<short-sha>`.
3. Reproduce first and capture evidence in workpad `Notes`.
4. Run early capability check (`git status`, `git remote -v`, `gh auth status` if available).
   - GitHub push/PR limitations are not blockers by default.
   - If code is fixed and validated locally but push/PR is unavailable, outcome is `DONE_LOCAL_ONLY`.
5. Implement smallest safe fix; keep scope narrow.
6. Validate with targeted tests/checks first; record commands and key outputs.
7. Keep workpad current after each meaningful milestone.
8. Keep investigation focused (`rg` + targeted snippets). Avoid dumping very large files.
9. Follow branch/PR git flow:
   - Never push directly to `main` or `master`.
   - Commit on an issue-scoped branch only.
   - Push branch to remote and open/update a PR targeting `main`.
   - Include PR URL in workpad and final report when available.

Finalization requirements:
1. Write `RUN_REPORT.md` in workspace root with:
   - Outcome: `DONE` / `DONE_LOCAL_ONLY` / `BLOCKED`
   - Summary of changes or blocker
   - Files changed
   - Commands run and key results
   - Risks and required human actions
2. Attempt to post final issue comment via `linear_graphql` using report content.
3. If comment posting fails, record exact failure in `RUN_REPORT.md` and still finish with one outcome.
4. For `DONE` or `BLOCKED`, attempt to update issue state via `linear_graphql`.
5. If PR creation/push failed due auth/permissions, keep outcome as `DONE_LOCAL_ONLY` and include exact failing command/error.

Linear GraphQL helper snippets:
- Find workflow state ids:
  - `query IssueTeam($id: String!) { issue(id: $id) { team { states { nodes { id name type } } } } }`
- Move issue to state id:
  - `mutation MoveIssue($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id identifier state { name } } } }`
- Upsert workpad/final comment:
  - `mutation CommentCreate($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }`

Outcome rules:
- `DONE`: fix implemented and required validation passed.
- `DONE_LOCAL_ONLY`: fix + validation complete, but push/PR unavailable.
- `BLOCKED`: missing mandatory dependency/permission/tooling prevented safe completion.

Do not end the turn without producing one of these outcomes and the required report.
