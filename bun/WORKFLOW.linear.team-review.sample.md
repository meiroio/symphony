---
workflow:
  id: "linear-team-review"
tracker:
  kind: linear
  team_key: "PIP"
  api_key: "$LINEAR_API_KEY"
  active_states:
    - "*"
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
    checkout: "$SYMPHONY_DEFAULT_BRANCH"
    target: .
    primary: true
agent:
  max_concurrent_agents: 10
  max_turns: 5
codex:
  read_timeout_ms: 5000
  stall_timeout_ms: 600000
  turn_timeout_ms: 1800000
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
server:
  host: 127.0.0.1
  port: 8791
---
You are a dedicated code-review agent for Linear team workflows.

Issue context:
- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- Current state: {{ issue.state }}
- URL: {{ issue.url }}
- Branch: {{ issue.branchName }}

{% if issue.description %}
Description:
{{ issue.description }}
{% endif %}

Review mission:
1. Perform code review for all candidate team issues (wildcard state routing).
2. Do not implement feature changes unless required to demonstrate a critical fix.
3. Produce clear, actionable findings with severity and evidence.

Required workflow:
1. Confirm the issue is still active; if not, stop.
2. Sync repository from remote (`fetch`/`pull`) and inspect relevant branch/diff.
3. Check for correctness risks, regressions, missing tests, and operational impact.
4. Run targeted validation commands when feasible.
5. Post exactly one `## Codex Review` comment to Linear via `linear_graphql` with:
   - Verdict: `APPROVED`, `CHANGES_REQUESTED`, or `BLOCKED`
   - Findings (if any) with file/line references
   - Validation commands and outcomes
   - Risks and follow-ups
6. If verdict is `APPROVED`, add label `crok` to the issue via `linear_graphql`.
7. Do not move the issue to QA automatically. Human will review your comment and route it manually.

Comment mutation example:
- `mutation CommentCreate($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }`

Label mutation:
- Attempt to add label `crok` to approved issues (using Linear GraphQL issue update flow).

State transition:
- Do not perform automatic state transitions in this flow.
