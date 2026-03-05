import { stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import type { WorkflowDefinition } from "../types";
import { logger } from "../utils/logger";
import { loadWorkflow, defaultWorkflowPath } from "./workflow";

const WORKFLOW_POLL_INTERVAL_MS = 1_000;

interface WorkflowStamp {
  mtimeMs: number;
  size: number;
  hash: string;
}

export class WorkflowStore {
  private workflowPath: string;
  private loadedPath: string | null = null;
  private workflow: WorkflowDefinition | null = null;
  private stamp: WorkflowStamp | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: unknown = null;

  constructor(workflowPath?: string) {
    this.workflowPath = workflowPath ?? defaultWorkflowPath();
  }

  async start(): Promise<void> {
    const loaded = await this.loadState(this.workflowPath);
    this.workflow = loaded.workflow;
    this.stamp = loaded.stamp;
    this.loadedPath = this.workflowPath;

    this.timer = setInterval(() => {
      void this.reload().catch((error) => {
        this.lastError = error;
      });
    }, WORKFLOW_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async forceReload(): Promise<void> {
    await this.reload(true);
  }

  setWorkflowPath(path: string): void {
    this.workflowPath = path;
  }

  getWorkflowPath(): string {
    return this.workflowPath;
  }

  current(): WorkflowDefinition {
    if (!this.workflow) {
      throw new Error("Workflow store is not initialized");
    }

    return this.workflow;
  }

  getLastError(): unknown {
    return this.lastError;
  }

  private async reload(force = false): Promise<void> {
    const pathChanged = this.loadedPath !== this.workflowPath;

    if (force || pathChanged || !this.stamp) {
      await this.reloadFromPath(this.workflowPath);
      return;
    }

    const currentStamp = await this.currentStamp(this.workflowPath);

    if (!currentStamp) {
      return;
    }

    if (
      !this.stamp ||
      currentStamp.mtimeMs !== this.stamp.mtimeMs ||
      currentStamp.size !== this.stamp.size ||
      currentStamp.hash !== this.stamp.hash
    ) {
      await this.reloadFromPath(this.workflowPath);
    }
  }

  private async reloadFromPath(path: string): Promise<void> {
    try {
      const loaded = await this.loadState(path);
      this.workflow = loaded.workflow;
      this.stamp = loaded.stamp;
      this.loadedPath = path;
      this.lastError = null;
    } catch (error) {
      this.lastError = error;
      logger.error("Failed to reload workflow, keeping last known good", {
        path,
        reason: error,
      });

      if (!this.workflow) {
        throw error;
      }
    }
  }

  private async loadState(path: string): Promise<{ workflow: WorkflowDefinition; stamp: WorkflowStamp }> {
    const workflow = await loadWorkflow(path);
    const stamp = await this.currentStamp(path);

    if (!stamp) {
      throw new Error(`Unable to read workflow metadata path=${path}`);
    }

    return { workflow, stamp };
  }

  private async currentStamp(path: string): Promise<WorkflowStamp | null> {
    const [fileStat, content] = await Promise.all([stat(path), readFile(path)]);
    const hash = createHash("sha1").update(content).digest("hex");

    return {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      hash,
    };
  }
}
