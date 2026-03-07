import { describe, expect, test } from "bun:test";

import type { EffectiveConfig, Issue } from "../src/types";
import { orchestratorTestUtils } from "../src/orchestrator/orchestrator";

const baseConfig = (): EffectiveConfig => ({
  tracker: {
    kind: "memory",
    endpoint: "https://api.linear.app/graphql",
    apiKey: null,
    projectSlug: null,
    teamKey: null,
    teamId: null,
    assignee: null,
    requiredLabels: [],
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
  },
  polling: { intervalMs: 1000 },
  workspace: { root: "/tmp/symphony-workspaces" },
  hooks: {
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 60_000,
  },
  agent: {
    maxConcurrentAgents: 5,
    maxTurns: 20,
    maxRetryBackoffMs: 300_000,
    maxConcurrentAgentsByState: {},
    continuationStates: [],
  },
  codex: {
    command: "codex app-server",
    approvalPolicy: "never",
    threadSandbox: "workspace-write",
    turnSandboxPolicy: { type: "workspaceWrite" },
    turnTimeoutMs: 3_600_000,
    readTimeoutMs: 5_000,
    stallTimeoutMs: 300_000,
  },
  server: {
    port: null,
    host: "127.0.0.1",
  },
  promptTemplate: "Prompt",
});

const issue = (partial: Partial<Issue>): Issue => ({
  id: "issue-1",
  identifier: "MT-1",
  title: "Issue",
  description: null,
  priority: null,
  state: "Todo",
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
  assigneeId: null,
  assignedToWorker: true,
  ...partial,
});

describe("orchestrator conformance logic", () => {
  test("dispatch sort order: priority, then oldest creation time, then identifier", () => {
    const issues = [
      issue({ id: "3", identifier: "MT-3", priority: null, createdAt: new Date("2026-01-01T00:00:00Z") }),
      issue({ id: "2", identifier: "MT-2", priority: 2, createdAt: new Date("2026-01-03T00:00:00Z") }),
      issue({ id: "1", identifier: "MT-1", priority: 1, createdAt: new Date("2026-01-02T00:00:00Z") }),
      issue({ id: "4", identifier: "MT-0", priority: 1, createdAt: new Date("2026-01-02T00:00:00Z") }),
    ];

    const sorted = orchestratorTestUtils.sortIssuesForDispatch(issues);
    expect(sorted.map((entry) => entry.identifier)).toEqual(["MT-0", "MT-1", "MT-2", "MT-3"]);
  });

  test("todo issue with non-terminal blocker is not eligible", () => {
    const config = baseConfig();

    const blockedTodo = issue({
      state: "Todo",
      blockedBy: [{ id: "b1", identifier: "MT-B", state: "In Progress" }],
    });

    expect(orchestratorTestUtils.isCandidateIssue(blockedTodo, config)).toBeTrue();
    expect(orchestratorTestUtils.isTodoBlockedByNonTerminal(blockedTodo, config)).toBeTrue();
  });

  test("todo issue with terminal blockers is eligible", () => {
    const config = baseConfig();

    const blockedTodo = issue({
      state: "Todo",
      blockedBy: [{ id: "b1", identifier: "MT-B", state: "Done" }],
    });

    expect(orchestratorTestUtils.isCandidateIssue(blockedTodo, config)).toBeTrue();
    expect(orchestratorTestUtils.isTodoBlockedByNonTerminal(blockedTodo, config)).toBeFalse();
  });

  test("required labels gate candidate eligibility", () => {
    const config = baseConfig();
    config.tracker.requiredLabels = ["codex-review", "qa-ready"];

    const eligible = issue({
      labels: ["codex-review", "qa-ready", "backend"],
    });

    const ineligible = issue({
      labels: ["codex-review"],
    });

    expect(orchestratorTestUtils.isCandidateIssue(eligible, config)).toBeTrue();
    expect(orchestratorTestUtils.isCandidateIssue(ineligible, config)).toBeFalse();
  });

  test("wildcard active state accepts any non-terminal state", () => {
    const config = baseConfig();
    config.tracker.activeStates = ["*"];

    const inReview = issue({
      state: "In Review",
    });
    const done = issue({
      state: "Done",
    });

    expect(orchestratorTestUtils.isCandidateIssue(inReview, config)).toBeTrue();
    expect(orchestratorTestUtils.isCandidateIssue(done, config)).toBeFalse();
  });

  test("failure backoff grows exponentially and caps at configured max", () => {
    expect(orchestratorTestUtils.failureRetryDelay(1, 300_000)).toBe(10_000);
    expect(orchestratorTestUtils.failureRetryDelay(2, 300_000)).toBe(20_000);
    expect(orchestratorTestUtils.failureRetryDelay(3, 300_000)).toBe(40_000);
    expect(orchestratorTestUtils.failureRetryDelay(10, 300_000)).toBe(300_000);
    expect(orchestratorTestUtils.failureRetryDelay(20, 300_000)).toBe(300_000);
  });

  test("extracts absolute token usage from nested payload shapes", () => {
    const usage = orchestratorTestUtils.extractAbsoluteUsage({
      event: "notification",
      timestamp: new Date(),
      payload: {
        params: {
          msg: {
            payload: {
              info: {
                total_token_usage: {
                  input_tokens: 11,
                  output_tokens: 7,
                  total_tokens: 18,
                },
              },
            },
          },
        },
      },
    });

    expect(usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    });
  });

  test("runningSeconds never returns negative values", () => {
    const now = new Date("2026-03-05T12:00:00Z");
    const before = new Date("2026-03-05T11:59:50Z");
    const after = new Date("2026-03-05T12:00:10Z");

    expect(orchestratorTestUtils.runningSeconds(before, now)).toBe(10);
    expect(orchestratorTestUtils.runningSeconds(after, now)).toBe(0);
  });
});
