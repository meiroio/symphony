import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import type { EffectiveConfig, Issue } from "../src/types";
import { AppServerClient } from "../src/codex/app-server";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-codex-app-server.ts", import.meta.url));

const baseIssue: Issue = {
  id: "issue-1",
  identifier: "MT-1",
  title: "Protocol test",
  description: null,
  priority: 2,
  state: "In Progress",
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
  assigneeId: null,
  assignedToWorker: true,
};

describe("codex app-server protocol", () => {
  test("startup handshake order + successful turn completion", async () => {
    const env = await createTestEnvironment("success");

    try {
      const config = buildConfig(env.workspaceRoot, env.logPath, "success");
      const client = new AppServerClient(() => config);
      const events: string[] = [];

      const session = await client.startSession(env.workspacePath);
      const result = await client.runTurn(session, "Hello", baseIssue, {
        onMessage: (event) => {
          events.push(event.event);
        },
      });
      client.stopSession(session);

      expect(result.threadId).toBe("thread-1");
      expect(result.turnId).toBe("turn-1");
      expect(result.sessionId).toBe("thread-1-turn-1");
      expect(events).toContain("session_started");
      expect(events).toContain("turn_completed");

      const methods = await loggedMethods(env.logPath);
      expect(methods).toEqual([
        "initialize",
        "initialized",
        "thread/start",
        "turn/start",
      ]);
    } finally {
      await env.cleanup();
    }
  });

  test("auto-approves command execution requests when approvalPolicy=never", async () => {
    const env = await createTestEnvironment("approval");

    try {
      const config = buildConfig(env.workspaceRoot, env.logPath, "approval");
      const client = new AppServerClient(() => config);
      const events: string[] = [];

      const session = await client.startSession(env.workspacePath);
      await client.runTurn(session, "Hello", baseIssue, {
        onMessage: (event) => {
          events.push(event.event);
        },
      });
      client.stopSession(session);

      expect(events).toContain("approval_auto_approved");
      expect(events).toContain("turn_completed");

      const responses = await loggedResponses(env.logPath);
      expect(responses).toContain("approval-1:acceptForSession");
    } finally {
      await env.cleanup();
    }
  });

  test("handles unsupported tool calls without stalling", async () => {
    const env = await createTestEnvironment("tool");

    try {
      const config = buildConfig(env.workspaceRoot, env.logPath, "tool");
      const client = new AppServerClient(() => config);
      const events: string[] = [];

      const session = await client.startSession(env.workspacePath);
      await client.runTurn(session, "Hello", baseIssue, {
        onMessage: (event) => {
          events.push(event.event);
        },
      });
      client.stopSession(session);

      expect(events).toContain("tool_call_failed");
      expect(events).toContain("turn_completed");

      const responses = await loggedResponses(env.logPath);
      expect(responses).toContain("tool-call-1:false");
    } finally {
      await env.cleanup();
    }
  });

  test("fails turn on input-required events", async () => {
    const env = await createTestEnvironment("input_required");

    try {
      const config = buildConfig(env.workspaceRoot, env.logPath, "input_required");
      const client = new AppServerClient(() => config);

      const session = await client.startSession(env.workspacePath);
      await expect(
        client.runTurn(session, "Hello", baseIssue, {
          onMessage: () => {
            // no-op
          },
        }),
      ).rejects.toThrow("turn_input_required");

      client.stopSession(session);
    } finally {
      await env.cleanup();
    }
  });
});

const createTestEnvironment = async (mode: string) => {
  const root = await mkdtemp(join(tmpdir(), "symphony-appserver-"));
  const workspaceRoot = join(root, "workspaces");
  const workspacePath = join(workspaceRoot, "MT-1");
  const logPath = join(root, "protocol.log");

  await mkdir(workspacePath, { recursive: true });

  return {
    root,
    workspaceRoot,
    workspacePath,
    logPath,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
    mode,
  };
};

const buildConfig = (workspaceRoot: string, logPath: string, mode: string): EffectiveConfig => {
  const command = `FAKE_CODEX_MODE=${shellQuote(mode)} FAKE_CODEX_LOG=${shellQuote(logPath)} bun ${shellQuote(fixturePath)}`;

  return {
    tracker: {
      kind: "memory",
      endpoint: "https://api.linear.app/graphql",
      apiKey: null,
      projectSlug: null,
      assignee: null,
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Closed"],
    },
    polling: {
      intervalMs: 1000,
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 1000,
    },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 1,
      maxRetryBackoffMs: 300000,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 10000,
      readTimeoutMs: 3000,
      stallTimeoutMs: 300000,
    },
    server: {
      port: null,
      host: "127.0.0.1",
    },
    promptTemplate: "Prompt",
  };
};

const loggedMethods = async (logPath: string): Promise<string[]> => {
  const lines = await readLogLines(logPath);
  return lines
    .filter((line) => line.startsWith("method:"))
    .map((line) => line.slice("method:".length));
};

const loggedResponses = async (logPath: string): Promise<string[]> => {
  const lines = await readLogLines(logPath);
  return lines
    .filter((line) => line.startsWith("response:"))
    .map((line) => line.slice("response:".length));
};

const readLogLines = async (logPath: string): Promise<string[]> => {
  const contents = await readFile(logPath, "utf8");
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

const shellQuote = (value: string): string => {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};
