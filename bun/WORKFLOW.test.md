---
tracker:
  kind: linear
  project_slug: "smoke-test-project"
  api_key: "smoke-test-token"
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
  interval_ms: 3000
workspace:
  root: /tmp/symphony-bun-workspaces
hooks:
  after_create: |
    printf "workspace created at %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .symphony-bootstrap.txt
  before_run: |
    printf "before_run at %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .symphony-run.log
  after_run: |
    printf "after_run at %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .symphony-run.log
agent:
  max_concurrent_agents: 2
  max_turns: 2
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
server:
  port: 8789
---
You are working on issue {{ issue.identifier }}.

Title: {{ issue.title }}
State: {{ issue.state }}

{% if attempt %}
Continuation attempt {{ attempt }}.
{% endif %}

Work inside the provided workspace only.
