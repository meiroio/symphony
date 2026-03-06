import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { access, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { WorkspaceManager } from "../src/workspace/workspace-manager";
import type { EffectiveConfig } from "../src/types";
import { SymphonyError } from "../src/utils/errors";

const buildConfig = (workspaceRoot: string, hooks: Partial<EffectiveConfig["hooks"]> = {}): EffectiveConfig => ({
  tracker: {
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    projectSlug: "proj",
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

  test("before_remove timeout is ignored and workspace cleanup still proceeds", async () => {
    const root = join(tmpdir(), `symphony-workspace-remove-${Date.now()}-${Math.random()}`);
    const config = buildConfig(root, {
      beforeRemove: "sleep 1",
      timeoutMs: 25,
    });
    const manager = new WorkspaceManager(() => config);

    try {
      const workspace = await manager.createForIssue("MT-1");
      await manager.removeIssueWorkspace("MT-1");

      await expect(access(workspace)).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces existing non-directory workspace path with a directory", async () => {
    const root = join(tmpdir(), `symphony-workspace-file-${Date.now()}-${Math.random()}`);
    const config = buildConfig(root);
    const manager = new WorkspaceManager(() => config);

    try {
      const expectedPath = join(root, "MT-1");
      await mkdir(root, { recursive: true });
      await writeFile(expectedPath, "stale-file", "utf8");

      const workspace = await manager.createForIssue("MT-1");

      expect(workspace).toBe(expectedPath);
      const stats = await lstat(workspace);
      expect(stats.isDirectory()).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes tmp artifacts when reusing an existing workspace", async () => {
    const root = join(tmpdir(), `symphony-workspace-tmp-${Date.now()}-${Math.random()}`);
    const config = buildConfig(root);
    const manager = new WorkspaceManager(() => config);

    try {
      const workspace = await manager.createForIssue("MT-1");
      await mkdir(join(workspace, "tmp"), { recursive: true });
      await mkdir(join(workspace, ".elixir_ls"), { recursive: true });
      await writeFile(join(workspace, "keep.txt"), "keep", "utf8");

      await manager.createForIssue("MT-1");

      await expect(access(join(workspace, "tmp"))).rejects.toBeDefined();
      await expect(access(join(workspace, ".elixir_ls"))).rejects.toBeDefined();
      await expect(access(join(workspace, "keep.txt"))).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("before_run hook failures abort the attempt", async () => {
    const root = join(tmpdir(), `symphony-workspace-before-run-${Date.now()}-${Math.random()}`);
    const config = buildConfig(root, {
      beforeRun: "exit 7",
    });
    const manager = new WorkspaceManager(() => config);

    try {
      const workspace = await manager.createForIssue("MT-1");

      await expect(manager.runBeforeRunHook(workspace, "MT-1")).rejects.toBeInstanceOf(SymphonyError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("after_run hook failures are ignored", async () => {
    const root = join(tmpdir(), `symphony-workspace-after-run-${Date.now()}-${Math.random()}`);
    const config = buildConfig(root, {
      afterRun: "exit 9",
    });
    const manager = new WorkspaceManager(() => config);

    try {
      const workspace = await manager.createForIssue("MT-1");
      await expect(manager.runAfterRunHook(workspace, "MT-1")).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
