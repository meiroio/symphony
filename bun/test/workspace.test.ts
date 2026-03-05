import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { access, readFile, rm, writeFile } from "node:fs/promises";

import { WorkspaceManager } from "../src/workspace/workspace-manager";
import type { EffectiveConfig } from "../src/types";

const buildConfig = (workspaceRoot: string, hooks: Partial<EffectiveConfig["hooks"]> = {}): EffectiveConfig => ({
  tracker: {
    kind: "memory",
    endpoint: "https://api.linear.app/graphql",
    apiKey: null,
    projectSlug: null,
    assignee: null,
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  },
  polling: { intervalMs: 1000 },
  workspace: { root: workspaceRoot },
  hooks: {
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 5_000,
    ...hooks,
  },
  agent: {
    maxConcurrentAgents: 1,
    maxTurns: 1,
    maxRetryBackoffMs: 30_000,
    maxConcurrentAgentsByState: {},
  },
  codex: {
    command: "codex app-server",
    approvalPolicy: "never",
    threadSandbox: "workspace-write",
    turnSandboxPolicy: { type: "workspaceWrite" },
    turnTimeoutMs: 10_000,
    readTimeoutMs: 5_000,
    stallTimeoutMs: 300_000,
  },
  server: {
    port: null,
    host: "127.0.0.1",
  },
  promptTemplate: "Prompt",
});

describe("workspace manager", () => {
  test("creates deterministic sanitized workspace path", async () => {
    const root = join(tmpdir(), `symphony-workspace-${Date.now()}-${Math.random()}`);
    const config = buildConfig(root);
    const manager = new WorkspaceManager(() => config);

    try {
      const workspaceA = await manager.createForIssue("MT/Det");
      const workspaceB = await manager.createForIssue("MT/Det");

      expect(workspaceA).toBe(workspaceB);
      expect(workspaceA.endsWith("MT_Det")).toBeTrue();

      await access(workspaceA);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs after_create hook only when workspace is created", async () => {
    const root = join(tmpdir(), `symphony-workspace-hook-${Date.now()}-${Math.random()}`);
    const marker = "created-once";
    const config = buildConfig(root, {
      afterCreate: `echo ${marker} > marker.txt`,
    });
    const manager = new WorkspaceManager(() => config);

    try {
      const workspace = await manager.createForIssue("MT-1");
      const markerPath = join(workspace, "marker.txt");
      const first = (await readFile(markerPath, "utf8")).trim();
      expect(first).toBe(marker);

      await writeFile(markerPath, "changed", "utf8");
      await manager.createForIssue("MT-1");

      const second = (await readFile(markerPath, "utf8")).trim();
      expect(second).toBe("changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
