---
tracker:
  kind: linear
  project_slug: "symphony-2f9fcdc281e6"
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
  max_turns: 20
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
server:
  host: 127.0.0.1
  port: 8790
---
You are working on issue {{ issue.identifier }}.

Title: {{ issue.title }}

{% if issue.description %}
Description:
{{ issue.description }}
{% endif %}

{% if attempt %}
Continuation attempt {{ attempt }}.
{% endif %}

Work only inside the provided workspace.
