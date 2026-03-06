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
      },
      {
        id: "repo_2",
        remote: "git@work:acme/docs.git",
        checkout: "main",
        target: "deps/docs",
        primary: true,
      },
    ]);
  });
});
