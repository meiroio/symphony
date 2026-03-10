import { describe, expect, test } from "bun:test";

import { resolveConfig, validateDispatchConfig } from "../src/config/config";
import type { WorkflowDefinition } from "../src/types";

const workflow = (config: Record<string, unknown>, promptTemplate = ""): WorkflowDefinition => ({
  config,
  prompt: promptTemplate,
  promptTemplate,
});

describe("config", () => {
  test("applies defaults", () => {
    const config = resolveConfig(workflow({}), {});

    expect(config.polling.intervalMs).toBe(30_000);
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect(config.agent.maxTurns).toBe(20);
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(config.tracker.terminalStates).toEqual([
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]);
  });

  test("resolves env-backed tracker token", () => {
    const config = resolveConfig(
      workflow({
        tracker: {
          kind: "linear",
          project_slug: "proj",
          api_key: "$LINEAR_API_KEY",
        },
      }),
      {
        LINEAR_API_KEY: "token-from-env",
      },
    );

    expect(config.tracker.apiKey).toBe("token-from-env");
  });

  test("normalizes csv state values and by-state limits", () => {
    const config = resolveConfig(
      workflow({
        tracker: {
          active_states: "Todo, In Progress, Review",
        },
        agent: {
          max_concurrent_agents_by_state: {
            " In Progress ": "3",
            Done: "invalid",
          },
        },
      }),
      {},
    );

    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress", "Review"]);
    expect(config.agent.maxConcurrentAgentsByState).toEqual({
      "in progress": 3,
    });
  });

  test("parses continuation states for state-aware auto-retry", () => {
    const config = resolveConfig(
      workflow({
        agent: {
          continuation_states: ["In Progress", "Code Review"],
        },
      }),
      {},
    );

    expect(config.agent.continuationStates).toEqual(["In Progress", "Code Review"]);
  });

  test("dispatch validation checks required fields", () => {
    const invalid = resolveConfig(
      workflow({
        tracker: {
          kind: "linear",
        },
      }),
      {},
    );

    const result = validateDispatchConfig(invalid);
    expect(result.ok).toBeFalse();
    expect(result.errorCode).toBe("missing_linear_api_token");

    const valid = resolveConfig(
      workflow({
        tracker: {
          kind: "memory",
        },
      }),
      {},
    );

    expect(validateDispatchConfig(valid)).toEqual({ ok: true });
  });

  test("dispatch validation accepts team scope and rejects missing linear scope", () => {
    const missingScope = resolveConfig(
      workflow({
        tracker: {
          kind: "linear",
          api_key: "token",
        },
      }),
      {},
    );

    const missingScopeResult = validateDispatchConfig(missingScope);
    expect(missingScopeResult.ok).toBeFalse();
    expect(missingScopeResult.errorCode).toBe("missing_linear_scope");

    const teamScoped = resolveConfig(
      workflow({
        tracker: {
          kind: "linear",
          api_key: "token",
          team_key: "PIP",
        },
      }),
      {},
    );

    expect(validateDispatchConfig(teamScoped)).toEqual({ ok: true });
  });

  test("normalizes repositories and selects a single primary repository", () => {
    const config = resolveConfig(
      workflow({
        repositories: [
          {
            id: "api",
            remote: "git@work:acme/api.git",
            checkout: "develop",
            target: ".",
          },
          {
            remote: "$DOCS_REMOTE",
            checkout: "main",
            target: "deps/docs",
            primary: true,
          },
          {
            id: "ignored",
            checkout: "main",
            target: "missing-remote",
          },
        ],
      }),
      {
        DOCS_REMOTE: "git@work:acme/docs.git",
      },
    );

    expect(config.repositories).toEqual([
      {
        id: "api",
        remote: "git@work:acme/api.git",
        checkout: "develop",
        target: ".",
        primary: false,
        transport: "git",
      },
      {
        id: "repo_2",
        remote: "git@work:acme/docs.git",
        checkout: "main",
        target: "deps/docs",
        primary: true,
        transport: "git",
      },
    ]);
  });

  test("resolves env-backed repository checkout with workflow and global branch fallbacks", () => {
    const config = resolveConfig(
      workflow({
        repositories: [
          {
            id: "api",
            remote: "git@work:acme/api.git",
            checkout: "$API_DEFAULT_BRANCH",
            target: ".",
          },
          {
            id: "docs",
            remote: "git@work:acme/docs.git",
            checkout: "$MISSING_BRANCH_ENV",
            target: "deps/docs",
          },
          {
            id: "ops",
            remote: "git@work:acme/ops.git",
            target: "deps/ops",
          },
        ],
      }),
      {
        API_DEFAULT_BRANCH: "release",
        SYMPHONY_DEFAULT_BRANCH: "dev",
      },
    );

    expect(config.repositories).toEqual([
      {
        id: "api",
        remote: "git@work:acme/api.git",
        checkout: "release",
        target: ".",
        primary: true,
        transport: "git",
      },
      {
        id: "docs",
        remote: "git@work:acme/docs.git",
        checkout: "dev",
        target: "deps/docs",
        primary: false,
        transport: "git",
      },
      {
        id: "ops",
        remote: "git@work:acme/ops.git",
        checkout: "dev",
        target: "deps/ops",
        primary: false,
        transport: "git",
      },
    ]);
  });

  test("normalizes repository transport and supports gh/github aliases", () => {
    const config = resolveConfig(
      workflow({
        repositories: [
          {
            id: "https-repo",
            remote: "https://github.com/acme/app.git",
            transport: "gh",
          },
          {
            id: "slug-repo",
            remote: "acme/docs",
            transport: "github",
          },
          {
            id: "ssh-repo",
            remote: "git@work:acme/ops.git",
          },
        ],
      }),
      {},
    );

    expect(config.repositories).toEqual([
      {
        id: "https-repo",
        remote: "https://github.com/acme/app.git",
        checkout: "main",
        target: ".",
        primary: true,
        transport: "gh",
      },
      {
        id: "slug-repo",
        remote: "acme/docs",
        checkout: "main",
        target: ".",
        primary: false,
        transport: "gh",
      },
      {
        id: "ssh-repo",
        remote: "git@work:acme/ops.git",
        checkout: "main",
        target: ".",
        primary: false,
        transport: "git",
      },
    ]);
  });

  test("normalizes required labels to lowercase", () => {
    const config = resolveConfig(
      workflow({
        tracker: {
          kind: "memory",
          required_labels: [" Code-Review ", "QA_READY"],
        },
      }),
      {},
    );

    expect(config.tracker.requiredLabels).toEqual(["code-review", "qa_ready"]);
  });

  test("passes prompt variables through workflow config", () => {
    const config = resolveConfig(
      workflow({
        prompt: {
          variables: {
            testing_command: "bun run test:e2e",
            review_mode: "strict",
          },
        },
        tracker: {
          kind: "memory",
        },
      }),
      {},
    );

    expect(config.promptVariables).toEqual({
      testing_command: "bun run test:e2e",
      review_mode: "strict",
    });
  });

  test("derives workflow identity from workflow path and allows explicit workflow.id override", () => {
    const inferred = resolveConfig(
      workflow({
        tracker: {
          kind: "memory",
        },
      }),
      {},
      null,
      "/tmp/workflows/WORKFLOW.linear.team-review.local.md",
    );

    expect(inferred.workflowId).toBe("WORKFLOW.linear.team-review.local");
    expect(inferred.workflowPath).toBe("/tmp/workflows/WORKFLOW.linear.team-review.local.md");

    const explicit = resolveConfig(
      workflow({
        workflow: {
          id: "pipes-review",
        },
        tracker: {
          kind: "memory",
        },
      }),
      {},
      null,
      "/tmp/workflows/WORKFLOW.linear.team-review.local.md",
    );

    expect(explicit.workflowId).toBe("pipes-review");
  });
});
