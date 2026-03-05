---
tracker:
  kind: memory
polling:
  interval_ms: 30000
workspace:
  root: /tmp/symphony-bun-workspaces
agent:
  max_concurrent_agents: 2
  max_turns: 20
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
server:
  host: 127.0.0.1
  port: 8789
---
You are working on issue {{ issue.identifier }}.

Title: {{ issue.title }}

{% if issue.description %}
Description:
{{ issue.description }}
{% endif %}

Work only inside the provided workspace.
