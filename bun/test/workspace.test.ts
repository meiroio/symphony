import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { WorkspaceManager } from "../src/workspace/workspace-manager";
import type { EffectiveConfig } from "../src/types";

const buildConfig = (workspaceRoot: string, hooks: Partial<EffectiveConfig["hooks"]> = {}): EffectiveConfig => ({
  tracker: {
    kind: "memory",
    endpoint: "https://api.linear.app/graphql",
    apiKey: null,
    projectSlug: null,
    teamKey: null,
    teamId: null,
    assignee: null,
    requiredLabels: [],
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
    continuationStates: [],
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

const runCommand = (args: string[], cwd: string): string => {
  const result = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${args.join(" ")}): ${stderr || stdout}`);
  }

  return stdout.trim();
};

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

  test("bootstraps repositories declared in workflow config", async () => {
    const root = join(tmpdir(), `symphony-workspace-repo-${Date.now()}-${Math.random()}`);
    const fixture = join(tmpdir(), `symphony-workspace-fixture-${Date.now()}-${Math.random()}`);
    const sourceRepo = join(fixture, "source-repo");
    const remoteRepo = join(fixture, "remote.git");
    const issueIdentifier = "MT-Repo";

    await rm(root, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });

    try {
      await mkdir(sourceRepo, { recursive: true });

      runCommand(["git", "init"], sourceRepo);
      runCommand(["git", "config", "user.email", "bot@example.com"], sourceRepo);
      runCommand(["git", "config", "user.name", "Symphony Bot"], sourceRepo);
      runCommand(["git", "checkout", "-b", "main"], sourceRepo);
      await writeFile(join(sourceRepo, "README.md"), "fixture\n", "utf8");
      runCommand(["git", "add", "README.md"], sourceRepo);
      runCommand(["git", "commit", "-m", "init"], sourceRepo);
      runCommand(["git", "clone", "--bare", sourceRepo, remoteRepo], fixture);

      const config: EffectiveConfig = {
        ...buildConfig(root),
        repositories: [
          {
            id: "app",
            remote: remoteRepo,
            checkout: "main",
            target: ".",
            primary: true,
          },
        ],
      };

      const manager = new WorkspaceManager(() => config);
      const workspace = await manager.createForIssue(issueIdentifier);

      await access(join(workspace, ".git"));
      const readme = await readFile(join(workspace, "README.md"), "utf8");
      expect(readme.trim()).toBe("fixture");

      const branch = runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], workspace);
      expect(branch).toBe("main");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("syncs existing clean repository via git pull on repeated workspace start", async () => {
    const root = join(tmpdir(), `symphony-workspace-sync-${Date.now()}-${Math.random()}`);
    const fixture = join(tmpdir(), `symphony-workspace-sync-fixture-${Date.now()}-${Math.random()}`);
    const sourceRepo = join(fixture, "source-repo");
    const remoteRepo = join(fixture, "remote.git");
    const issueIdentifier = "MT-Sync";

    await rm(root, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });

    try {
      await mkdir(sourceRepo, { recursive: true });

      runCommand(["git", "init"], sourceRepo);
      runCommand(["git", "config", "user.email", "bot@example.com"], sourceRepo);
      runCommand(["git", "config", "user.name", "Symphony Bot"], sourceRepo);
      runCommand(["git", "checkout", "-b", "main"], sourceRepo);

      await writeFile(join(sourceRepo, "README.md"), "v1\n", "utf8");
      runCommand(["git", "add", "README.md"], sourceRepo);
      runCommand(["git", "commit", "-m", "init"], sourceRepo);
      runCommand(["git", "clone", "--bare", sourceRepo, remoteRepo], fixture);

      const config: EffectiveConfig = {
        ...buildConfig(root),
        repositories: [
          {
            id: "app",
            remote: remoteRepo,
            checkout: "main",
            target: ".",
            primary: true,
          },
        ],
      };

      const manager = new WorkspaceManager(() => config);
      const workspace = await manager.createForIssue(issueIdentifier);
      expect((await readFile(join(workspace, "README.md"), "utf8")).trim()).toBe("v1");

      await writeFile(join(sourceRepo, "README.md"), "v2\n", "utf8");
      runCommand(["git", "add", "README.md"], sourceRepo);
      runCommand(["git", "commit", "-m", "update"], sourceRepo);
      runCommand(["git", "push", remoteRepo, "main"], sourceRepo);

      await manager.createForIssue(issueIdentifier);

      expect((await readFile(join(workspace, "README.md"), "utf8")).trim()).toBe("v2");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
