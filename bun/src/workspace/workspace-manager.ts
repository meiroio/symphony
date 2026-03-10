import { join, resolve, relative } from "node:path";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  stat,
} from "node:fs/promises";

import type { EffectiveConfig, Issue } from "../types";
import { logger } from "../utils/logger";
import { asErrorMessage, SymphonyError } from "../utils/errors";
import { sanitizeWorkspaceKey } from "../utils/normalize";

const EXCLUDED_ENTRIES = new Set(["tmp", ".elixir_ls"]);
const HOOK_LOG_TRUNCATE_BYTES = 2_048;
const GIT_CLONE_TIMEOUT_MS = 300_000;
const GIT_SYNC_TIMEOUT_MS = 120_000;

interface IssueContext {
  issueId: string | null;
  issueIdentifier: string;
}

export class WorkspaceManager {
  private readonly configProvider: () => EffectiveConfig;

  constructor(configProvider: () => EffectiveConfig) {
    this.configProvider = configProvider;
  }

  async createForIssue(issueOrIdentifier: Issue | string | null | undefined): Promise<string> {
    const issue = this.issueContext(issueOrIdentifier);
    const workspaceKey = sanitizeWorkspaceKey(issue.issueIdentifier);
    const workspace = join(this.configProvider().workspace.root, workspaceKey);

    await this.validateWorkspacePath(workspace);

    const createdNow = await this.ensureWorkspace(workspace);
    await this.bootstrapRepositories(workspace, issue);
    if (createdNow) {
      const script = this.configProvider().hooks.afterCreate;
      if (script) {
        await this.runHook(script, workspace, issue, "after_create", true);
      }
    }

    return workspace;
  }

  private async bootstrapRepositories(workspace: string, issue: IssueContext): Promise<void> {
    const repositories = this.configProvider().repositories ?? [];
    if (repositories.length === 0) {
      return;
    }

    for (const repository of repositories) {
      const targetPath = this.resolveRepositoryTargetPath(workspace, repository.target);
      await mkdir(targetPath, { recursive: true });

      const alreadyGitRepo = await this.pathExists(join(targetPath, ".git"));
      if (alreadyGitRepo) {
        await this.syncRepository(targetPath, repository, issue);
        continue;
      }

      const args = this.cloneRepositoryCommand(repository, targetPath);
      const result = await this.runCommand(args, workspace, GIT_CLONE_TIMEOUT_MS);

      if (result.exitCode !== 0) {
        throw new SymphonyError("workspace_repository_clone_failed", "Failed to clone repository", {
          issue_id: issue.issueId,
          issue_identifier: issue.issueIdentifier,
          repository_id: repository.id,
          transport: repository.transport,
          remote: repository.remote,
          target: repository.target,
          output: truncate(`${result.stdout}\n${result.stderr}`.trim()),
        });
      }

      this.logInfo("Repository cloned for workspace", {
        issue_id: issue.issueId,
        issue_identifier: issue.issueIdentifier,
        repository_id: repository.id,
        transport: repository.transport,
        remote: repository.remote,
        checkout: repository.checkout,
        target: repository.target,
        path: targetPath,
      });
    }
  }

  private async syncRepository(
    targetPath: string,
    repository: NonNullable<EffectiveConfig["repositories"]>[number],
    issue: IssueContext,
  ): Promise<void> {
    const desiredOrigin = this.repositoryOriginUrl(repository);
    if (desiredOrigin) {
      await this.ensureRepositoryOrigin(targetPath, repository, issue, desiredOrigin);
    }

    const statusResult = await this.runCommand(["git", "status", "--porcelain"], targetPath, GIT_SYNC_TIMEOUT_MS);
    if (statusResult.exitCode !== 0) {
      this.logWarn("Repository sync skipped; unable to read git status", {
        issue_id: issue.issueId,
        issue_identifier: issue.issueIdentifier,
        repository_id: repository.id,
        target: repository.target,
        path: targetPath,
        output: truncate(`${statusResult.stdout}\n${statusResult.stderr}`.trim()),
      });
      return;
    }

    if (statusResult.stdout.trim().length > 0) {
      this.logInfo("Repository has local changes; skipping git pull", {
        issue_id: issue.issueId,
        issue_identifier: issue.issueIdentifier,
        repository_id: repository.id,
        target: repository.target,
        path: targetPath,
      });
      return;
    }

    const fetchResult = await this.runCommand(
      ["git", "fetch", "--prune", "origin"],
      targetPath,
      GIT_SYNC_TIMEOUT_MS,
    );
    if (fetchResult.exitCode !== 0) {
      this.logWarn("Repository sync failed during fetch", {
        issue_id: issue.issueId,
        issue_identifier: issue.issueIdentifier,
        repository_id: repository.id,
        target: repository.target,
        path: targetPath,
        output: truncate(`${fetchResult.stdout}\n${fetchResult.stderr}`.trim()),
      });
      return;
    }

    const branchResult = await this.runCommand(
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      targetPath,
      GIT_SYNC_TIMEOUT_MS,
    );
    if (branchResult.exitCode !== 0) {
      this.logWarn("Repository sync failed; unable to determine current branch", {
        issue_id: issue.issueId,
        issue_identifier: issue.issueIdentifier,
        repository_id: repository.id,
        target: repository.target,
        path: targetPath,
        output: truncate(`${branchResult.stdout}\n${branchResult.stderr}`.trim()),
      });
      return;
    }

    const branchFromHead = branchResult.stdout.trim();
    const pullBranch = branchFromHead === "HEAD" || branchFromHead.length === 0
      ? repository.checkout
      : branchFromHead;

    if (branchFromHead === "HEAD") {
      const checkoutResult = await this.runCommand(
        ["git", "checkout", pullBranch],
        targetPath,
        GIT_SYNC_TIMEOUT_MS,
      );
      if (checkoutResult.exitCode !== 0) {
        this.logWarn("Repository sync failed during detached HEAD checkout", {
          issue_id: issue.issueId,
          issue_identifier: issue.issueIdentifier,
          repository_id: repository.id,
          target: repository.target,
          path: targetPath,
          branch: pullBranch,
          output: truncate(`${checkoutResult.stdout}\n${checkoutResult.stderr}`.trim()),
        });
        return;
      }
    }

    const pullResult = await this.runCommand(
      ["git", "pull", "--ff-only", "origin", pullBranch],
      targetPath,
      GIT_SYNC_TIMEOUT_MS,
    );
    if (pullResult.exitCode !== 0) {
      this.logWarn("Repository sync failed during pull", {
        issue_id: issue.issueId,
        issue_identifier: issue.issueIdentifier,
        repository_id: repository.id,
        target: repository.target,
        path: targetPath,
        branch: pullBranch,
        output: truncate(`${pullResult.stdout}\n${pullResult.stderr}`.trim()),
      });
      return;
    }

    this.logInfo("Repository synced with remote via git pull", {
      issue_id: issue.issueId,
      issue_identifier: issue.issueIdentifier,
      repository_id: repository.id,
      transport: repository.transport,
      target: repository.target,
      path: targetPath,
      branch: pullBranch,
    });
  }

  private cloneRepositoryCommand(
    repository: NonNullable<EffectiveConfig["repositories"]>[number],
    targetPath: string,
  ): string[] {
    if (repository.transport === "gh") {
      return [
        "gh",
        "repo",
        "clone",
        repository.remote,
        targetPath,
        "--",
        "--branch",
        repository.checkout,
      ];
    }

    return ["git", "clone", "--branch", repository.checkout, repository.remote, targetPath];
  }

  private repositoryOriginUrl(
    repository: NonNullable<EffectiveConfig["repositories"]>[number],
  ): string | null {
    if (repository.transport !== "gh") {
      return repository.remote;
    }

    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(repository.remote) || repository.remote.startsWith("git@")) {
      return repository.remote;
    }

    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.remote)) {
      return `https://github.com/${repository.remote}.git`;
    }

    return repository.remote;
  }

  private async ensureRepositoryOrigin(
    targetPath: string,
    repository: NonNullable<EffectiveConfig["repositories"]>[number],
    issue: IssueContext,
    desiredOrigin: string,
  ): Promise<void> {
    const currentOriginResult = await this.runCommand(
      ["git", "remote", "get-url", "origin"],
      targetPath,
      GIT_SYNC_TIMEOUT_MS,
    );
    if (currentOriginResult.exitCode !== 0) {
      this.logWarn("Repository sync skipped; unable to read origin remote", {
        issue_id: issue.issueId,
        issue_identifier: issue.issueIdentifier,
        repository_id: repository.id,
        transport: repository.transport,
        target: repository.target,
        path: targetPath,
        output: truncate(`${currentOriginResult.stdout}\n${currentOriginResult.stderr}`.trim()),
      });
      return;
    }

    const currentOrigin = currentOriginResult.stdout.trim();
    if (currentOrigin === desiredOrigin) {
      return;
    }

    const setOriginResult = await this.runCommand(
      ["git", "remote", "set-url", "origin", desiredOrigin],
      targetPath,
      GIT_SYNC_TIMEOUT_MS,
    );
    if (setOriginResult.exitCode !== 0) {
      this.logWarn("Repository sync failed while updating origin remote", {
        issue_id: issue.issueId,
        issue_identifier: issue.issueIdentifier,
        repository_id: repository.id,
        transport: repository.transport,
        target: repository.target,
        path: targetPath,
        desired_origin: desiredOrigin,
        output: truncate(`${setOriginResult.stdout}\n${setOriginResult.stderr}`.trim()),
      });
      return;
    }

    this.logInfo("Repository origin updated from workflow configuration", {
      issue_id: issue.issueId,
      issue_identifier: issue.issueIdentifier,
      repository_id: repository.id,
      transport: repository.transport,
      target: repository.target,
      path: targetPath,
      desired_origin: desiredOrigin,
    });
  }

  async remove(workspace: string): Promise<void> {
    const exists = await this.pathExists(workspace);

    if (!exists) {
      await rm(workspace, { recursive: true, force: true });
      return;
    }

    await this.validateWorkspacePath(workspace);

    const script = this.configProvider().hooks.beforeRemove;
    if (script) {
      await this.runHook(
        script,
        workspace,
        {
          issueId: null,
          issueIdentifier: workspace.split(/[\\/]/).pop() ?? "issue",
        },
        "before_remove",
        false,
      );
    }

    await rm(workspace, { recursive: true, force: true });
  }

  async removeIssueWorkspace(identifier: string | null | undefined): Promise<void> {
    if (typeof identifier !== "string") {
      return;
    }

    const workspace = join(this.configProvider().workspace.root, sanitizeWorkspaceKey(identifier));

    try {
      await this.remove(workspace);
    } catch (error) {
      this.logWarn("Workspace cleanup failed", {
        issue_identifier: identifier,
        error: asErrorMessage(error),
      });
    }
  }

  async runBeforeRunHook(workspace: string, issueOrIdentifier: Issue | string): Promise<void> {
    const script = this.configProvider().hooks.beforeRun;
    if (!script) {
      return;
    }

    await this.runHook(script, workspace, this.issueContext(issueOrIdentifier), "before_run", true);
  }

  async runAfterRunHook(workspace: string, issueOrIdentifier: Issue | string): Promise<void> {
    const script = this.configProvider().hooks.afterRun;
    if (!script) {
      return;
    }

    try {
      await this.runHook(script, workspace, this.issueContext(issueOrIdentifier), "after_run", false);
    } catch (error) {
      this.logWarn("after_run hook failed and was ignored", {
        issue_identifier: this.issueContext(issueOrIdentifier).issueIdentifier,
        error: asErrorMessage(error),
      });
    }
  }

  async validateWorkspacePath(workspace: string): Promise<void> {
    const root = resolve(this.configProvider().workspace.root);
    const expandedWorkspace = resolve(workspace);

    if (expandedWorkspace === root) {
      throw new SymphonyError(
        "workspace_equals_root",
        `Workspace path cannot equal workspace root: ${expandedWorkspace}`,
      );
    }

    const rel = relative(root, expandedWorkspace);
    if (rel.startsWith("..") || rel === "") {
      throw new SymphonyError("workspace_outside_root", "Workspace path escaped configured root", {
        workspace: expandedWorkspace,
        root,
      });
    }

    const segments = rel.split(/[\\/]/).filter((segment) => segment.length > 0);
    let current = root;

    for (const segment of segments) {
      current = join(current, segment);
      const exists = await this.pathExists(current);
      if (!exists) {
        break;
      }

      const details = await lstat(current);
      if (details.isSymbolicLink()) {
        const target = await readlink(current).catch(() => "<unknown>");
        throw new SymphonyError("workspace_symlink_escape", "Workspace path includes a symlink", {
          path: current,
          target,
          root,
        });
      }
    }
  }

  private async ensureWorkspace(workspace: string): Promise<boolean> {
    const exists = await this.pathExists(workspace);

    if (exists) {
      const details = await stat(workspace);

      if (details.isDirectory()) {
        await this.cleanTmpArtifacts(workspace);
        return false;
      }

      await rm(workspace, { recursive: true, force: true });
    }

    await mkdir(workspace, { recursive: true });
    return true;
  }

  private async cleanTmpArtifacts(workspace: string): Promise<void> {
    let entries: string[];

    try {
      entries = await readdir(workspace);
    } catch {
      return;
    }

    await Promise.all(
      entries
        .filter((entry) => EXCLUDED_ENTRIES.has(entry))
        .map((entry) => rm(join(workspace, entry), { recursive: true, force: true })),
    );
  }

  private async runHook(
    script: string,
    workspace: string,
    issue: IssueContext,
    hookName: string,
    failOnError: boolean,
  ): Promise<void> {
    const timeoutMs = this.configProvider().hooks.timeoutMs;

    this.logInfo("Running workspace hook", {
      hook: hookName,
      issue_id: issue.issueId,
      issue_identifier: issue.issueIdentifier,
      workspace,
      timeout_ms: timeoutMs,
    });

    const startedAt = Date.now();

    const env = { ...process.env };
    const proc = Bun.spawn(["sh", "-lc", script], {
      cwd: workspace,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const [exitCode, stdoutText, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);

    clearTimeout(timeout);

    if (timedOut) {
      throw new SymphonyError("workspace_hook_timeout", `Workspace hook timed out: ${hookName}`, {
        hook: hookName,
        timeoutMs,
      });
    }

    if (exitCode !== 0) {
      const output = truncate(`${stdoutText}\n${stderrText}`.trim());

      if (failOnError) {
        throw new SymphonyError("workspace_hook_failed", `Workspace hook failed: ${hookName}`, {
          hook: hookName,
          status: exitCode,
          output,
        });
      }

      this.logWarn("Workspace hook failed and was ignored", {
        hook: hookName,
        issue_id: issue.issueId,
        issue_identifier: issue.issueIdentifier,
        workspace,
        status: exitCode,
        output,
      });
    }

    this.logInfo("Workspace hook finished", {
      hook: hookName,
      issue_id: issue.issueId,
      issue_identifier: issue.issueIdentifier,
      workspace,
      duration_ms: Date.now() - startedAt,
    });
  }

  private issueContext(issueOrIdentifier: Issue | string | null | undefined): IssueContext {
    if (typeof issueOrIdentifier === "string") {
      return {
        issueId: null,
        issueIdentifier: issueOrIdentifier,
      };
    }

    if (issueOrIdentifier && typeof issueOrIdentifier === "object") {
      return {
        issueId: issueOrIdentifier.id,
        issueIdentifier: issueOrIdentifier.identifier ?? "issue",
      };
    }

    return {
      issueId: null,
      issueIdentifier: "issue",
    };
  }

  private resolveRepositoryTargetPath(workspace: string, target: string): string {
    if (!target || target.trim().length === 0 || target === ".") {
      return workspace;
    }

    const absolute = resolve(workspace, target);
    if (absolute === workspace) {
      return workspace;
    }

    const rel = relative(workspace, absolute);

    if (rel.startsWith("..") || rel === "") {
      throw new SymphonyError("workspace_repository_target_escape", "Repository target escaped workspace", {
        workspace,
        target,
        resolved: absolute,
      });
    }

    return absolute;
  }

  private async runCommand(
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const env = { ...process.env };
    const proc = Bun.spawn(args, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);

    clearTimeout(timer);

    if (timedOut) {
      throw new SymphonyError("workspace_command_timeout", "Workspace command timed out", {
        command: args.join(" "),
        cwd,
        timeoutMs,
      });
    }

    return {
      exitCode,
      stdout,
      stderr,
    };
  }

  private workflowLogContext(context: Record<string, unknown> = {}): Record<string, unknown> {
    const config = this.configProvider();
    return {
      workflow_id: config.workflowId ?? "workflow",
      workflow_path: config.workflowPath ?? null,
      ...context,
    };
  }

  private logInfo(message: string, context: Record<string, unknown> = {}): void {
    logger.info(message, this.workflowLogContext(context));
  }

  private logWarn(message: string, context: Record<string, unknown> = {}): void {
    logger.warn(message, this.workflowLogContext(context));
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}

const truncate = (value: string): string => {
  if (value.length <= HOOK_LOG_TRUNCATE_BYTES) {
    return value;
  }

  return `${value.slice(0, HOOK_LOG_TRUNCATE_BYTES)}... (truncated)`;
};
