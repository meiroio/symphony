import { afterEach, describe, expect, test } from "bun:test";

import type { EffectiveConfig, Issue, RunningEntry } from "../src/types";
import { Orchestrator } from "../src/orchestrator/orchestrator";

const baseConfig = (): EffectiveConfig => ({
  tracker: {
    kind: "memory",
    endpoint: "https://api.linear.app/graphql",
    apiKey: null,
    projectSlug: null,
    teamKey: null,
    teamId: null,
    assignee: null,
    webhookPath: null,
    webhookSecret: null,
    requiredLabels: [],
    activeStates: ["*"],
    terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
  },
  polling: { intervalMs: 0 },
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
  workflowId: "workflow-runtime",
  workflowPath: "/tmp/workflows/workflow-runtime.md",
});

const issue = (partial: Partial<Issue>): Issue => ({
  id: "issue-1",
  identifier: "MT-1",
  title: "Issue",
  description: null,
  priority: null,
  state: "In Progress",
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: null,
  updatedAt: new Date("2026-03-11T10:00:00Z"),
  assigneeId: null,
  assignedToWorker: true,
  ...partial,
});

const activeOrchestrators: Orchestrator[] = [];

afterEach(() => {
  for (const orchestrator of activeOrchestrators.splice(0, activeOrchestrators.length)) {
    orchestrator.stop();
  }
});

describe("orchestrator runtime reconcile loop", () => {
  test("background running issue reconcile refreshes active issue state in webhook mode", async () => {
    const trackerIssues = [issue({ state: "In Progress" })];
    const config = baseConfig();
    const now = new Date();
    const orchestrator = new Orchestrator({
      workflowStore: {
        current: () => {
          throw new Error("workflow resolution is stubbed in this test");
        },
        getWorkflowPath: () => config.workflowPath ?? "/tmp/workflows/workflow-runtime.md",
      } as never,
      trackerOptions: {
        memoryIssues: trackerIssues,
      },
    });

    activeOrchestrators.push(orchestrator);

    const runtime = orchestrator as any;
    runtime.currentConfig = config;
    runtime.started = true;
    runtime.refreshRuntimeConfig = () => {
      runtime.currentConfig = config;
    };

    const runningEntry: RunningEntry = {
      issue: { ...trackerIssues[0]! },
      issueId: "issue-1",
      identifier: "MT-1",
      abortController: new AbortController(),
      retryAttempt: 0,
      startedAt: now,
      sessionId: "session-1",
      codexAppServerPid: null,
      lastCodexEvent: "notification",
      lastCodexTimestamp: now,
      lastCodexMessage: null,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      turnCount: 1,
    };

    runtime.running.set("issue-1", runningEntry);

    trackerIssues[0] = issue({
      state: "Code Review",
      updatedAt: new Date("2026-03-11T10:01:00Z"),
    });

    runtime.scheduleRunningIssueReconcile(0);
    await Bun.sleep(25);

    const snapshot = orchestrator.snapshot();
    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]?.state).toBe("Code Review");
  });
});
