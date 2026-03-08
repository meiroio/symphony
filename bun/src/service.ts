import type { EffectiveConfig, Issue } from "./types";
import { WorkflowStore } from "./config/workflow-store";
import { resolveConfig, validateDispatchConfig } from "./config/config";
import { Orchestrator } from "./orchestrator/orchestrator";
import { HttpServer } from "./http/server";
import { logger } from "./utils/logger";

export interface SymphonyServiceOptions {
  workflowPath?: string;
  serverPortOverride?: number | null;
  trackerMemoryIssues?: Issue[];
}

export class SymphonyService {
  private readonly workflowStore: WorkflowStore;
  private readonly serverPortOverride: number | null;
  private readonly orchestrator: Orchestrator;
  private readonly httpServer: HttpServer;
  private readonly trackerMemoryIssues: Issue[];
  private started = false;

  constructor(options: SymphonyServiceOptions = {}) {
    this.workflowStore = new WorkflowStore(options.workflowPath);
    this.serverPortOverride = options.serverPortOverride ?? null;
    this.trackerMemoryIssues = options.trackerMemoryIssues ?? [];

    this.orchestrator = new Orchestrator({
      workflowStore: this.workflowStore,
      serverPortOverride: this.serverPortOverride,
      trackerOptions: {
        memoryIssues: this.trackerMemoryIssues,
      },
    });

    this.httpServer = new HttpServer({
      orchestrator: this.orchestrator,
      configProvider: () => this.currentConfig(),
    });
  }

  async start(): Promise<{ httpPort: number | null; workflowId: string; workflowPath: string }> {
    if (this.started) {
      return {
        httpPort: this.boundHttpPort(),
        workflowId: this.currentConfig().workflowId ?? "workflow",
        workflowPath: this.workflowStore.getWorkflowPath(),
      };
    }

    await this.workflowStore.start();

    const validation = validateDispatchConfig(this.currentConfig());
    if (!validation.ok) {
      throw new Error(validation.message ?? validation.errorCode ?? "dispatch_validation_failed");
    }

    await this.orchestrator.start();

    const config = this.currentConfig();
    const port = this.serverPortOverride ?? config.server.port;

    let httpPort: number | null = null;

    if (typeof port === "number" && port >= 0) {
      const host = config.server.host;
      httpPort = this.httpServer.start(port, host);

      logger.info("HTTP observability server started", {
        host,
        port: httpPort,
        workflow_id: config.workflowId ?? "workflow",
        workflow_path: config.workflowPath ?? this.workflowStore.getWorkflowPath(),
      });
    }

    this.started = true;

    return {
      httpPort,
      workflowId: config.workflowId ?? "workflow",
      workflowPath: config.workflowPath ?? this.workflowStore.getWorkflowPath(),
    };
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.httpServer.stop();
    this.orchestrator.stop();
    this.workflowStore.stop();
    this.started = false;
  }

  getOrchestrator(): Orchestrator {
    return this.orchestrator;
  }

  getConfig(): EffectiveConfig {
    return this.currentConfig();
  }

  private currentConfig() {
    const workflow = this.workflowStore.current();
    return resolveConfig(workflow, Bun.env, this.serverPortOverride, this.workflowStore.getWorkflowPath());
  }

  private boundHttpPort(): number | null {
    const config = this.currentConfig();
    return this.serverPortOverride ?? config.server.port;
  }
}
