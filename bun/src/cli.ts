#!/usr/bin/env bun

import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { SymphonyService } from "./service";
import { defaultWorkflowPath } from "./config/workflow";
import { MultiWorkflowDashboard } from "./http/multi-workflow-dashboard";
import type { EffectiveConfig } from "./types";
import { logger } from "./utils/logger";

interface CliOptions {
  workflowPaths: string[];
  portOverride: number | null;
  dashboardPort: number | null;
}

export const main = async (rawArgs: string[] = Bun.argv.slice(2)): Promise<void> => {
  const options = parseArgs(rawArgs);
  await Promise.all(options.workflowPaths.map((workflowPath) => assertWorkflowExists(workflowPath)));

  const serviceSpecs = options.workflowPaths.map((workflowPath, index) => ({
    workflowPath,
    service: new SymphonyService({
      workflowPath,
      serverPortOverride: options.workflowPaths.length === 1 ? options.portOverride : null,
    }),
    index,
    started: null as { httpPort: number | null; workflowId: string; workflowPath: string } | null,
  }));

  const dashboardHost = "127.0.0.1";
  const defaultDashboardPort = parseEnvPort(Bun.env.SYMPHONY_DASHBOARD_PORT) ?? 8788;
  const dashboardPort = options.dashboardPort ?? defaultDashboardPort;
  const dashboard =
    options.workflowPaths.length > 1
      ? new MultiWorkflowDashboard({
          entriesProvider: () =>
            serviceSpecs.map((spec, index) => {
              const snapshot = spec.service.getOrchestrator().snapshot();
              const started = spec.started;
              const config = spec.service.getConfig();
              const key = `${snapshot.workflowId ?? `workflow-${index}`}:${index}`;

              return {
                key,
                workflowId: snapshot.workflowId ?? started?.workflowId ?? null,
                workflowPath: snapshot.workflowPath ?? started?.workflowPath ?? spec.workflowPath,
                httpPort: started?.httpPort ?? null,
                tracker: trackerSummaryFromConfig(config),
                visualization: config.workflowVisualization ?? null,
                snapshot,
              };
            }),
          refreshAll: () =>
            serviceSpecs.map((spec, index) => {
              const refresh = spec.service.getOrchestrator().requestRefresh();
              const snapshot = spec.service.getOrchestrator().snapshot();
              const key = `${snapshot.workflowId ?? `workflow-${index}`}:${index}`;

              return {
                key,
                workflowId: snapshot.workflowId ?? null,
                workflowPath: snapshot.workflowPath ?? spec.workflowPath,
                coalesced: refresh.coalesced,
                requestedAt: refresh.requestedAt,
              };
            }),
        })
      : null;

  const shutdown = async (signal: string) => {
    logger.info("Shutting down Symphony service", {
      signal,
      workflows: options.workflowPaths,
    });
    dashboard?.stop();
    await Promise.all(serviceSpecs.map(({ service }) => service.stop()));
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  for (const { workflowPath: configuredWorkflowPath, service, index } of serviceSpecs) {
    const {
      httpPort,
      workflowId,
      workflowPath: startedWorkflowPath,
    } = await service.start();
    const spec = serviceSpecs[index];
    if (spec) {
      spec.started = { httpPort, workflowId, workflowPath: startedWorkflowPath };
    }

    logger.info("Symphony Bun service started", {
      workflow_path: startedWorkflowPath ?? configuredWorkflowPath,
      workflow_id: workflowId,
      http_port: httpPort,
      service_index: index,
      total_services: serviceSpecs.length,
    });
  }

  if (dashboard) {
    const actualPort = dashboard.start(dashboardPort, dashboardHost);
    logger.info("Symphony multi-workflow dashboard started", {
      host: dashboardHost,
      port: actualPort,
      workflows: options.workflowPaths,
    });
  }
};

const trackerSummaryFromConfig = (config: EffectiveConfig) => {
  if (config.tracker.projectSlug) {
    return {
      kind: config.tracker.kind,
      scopeType: "project",
      scopeLabel: config.tracker.projectSlug,
    };
  }

  if (config.tracker.teamKey) {
    return {
      kind: config.tracker.kind,
      scopeType: "team",
      scopeLabel: config.tracker.teamKey,
    };
  }

  if (config.tracker.teamId) {
    return {
      kind: config.tracker.kind,
      scopeType: "team",
      scopeLabel: config.tracker.teamId,
    };
  }

  return {
    kind: config.tracker.kind,
    scopeType: "workspace",
    scopeLabel: null,
  };
};

export const parseArgs = (args: string[]): CliOptions => {
  const workflowPaths: string[] = [];
  let portOverride: number | null = null;
  let dashboardPort: number | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === "--port") {
      const rawPort = args[index + 1];
      if (!rawPort) {
        throw new Error("--port requires an integer value");
      }

      const port = Number.parseInt(rawPort, 10);
      if (!Number.isInteger(port) || port < 0) {
        throw new Error("--port requires a non-negative integer value");
      }

      portOverride = port;
      index += 1;
      continue;
    }

    if (arg === "--dashboard-port") {
      const rawPort = args[index + 1];
      if (!rawPort) {
        throw new Error("--dashboard-port requires an integer value");
      }

      const port = Number.parseInt(rawPort, 10);
      if (!Number.isInteger(port) || port < 0) {
        throw new Error("--dashboard-port requires a non-negative integer value");
      }

      dashboardPort = port;
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    workflowPaths.push(resolve(arg));
  }

  const resolvedWorkflowPaths = workflowPaths.length > 0 ? workflowPaths : [defaultWorkflowPath()];

  if (portOverride !== null && resolvedWorkflowPaths.length > 1) {
    throw new Error("--port can only be used with a single workflow path");
  }

  if (dashboardPort !== null && resolvedWorkflowPaths.length < 2) {
    throw new Error("--dashboard-port requires at least two workflow paths");
  }

  return {
    workflowPaths: resolvedWorkflowPaths,
    portOverride,
    dashboardPort,
  };
};

const parseEnvPort = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }

  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0) {
    return null;
  }

  return port;
};

const assertWorkflowExists = async (workflowPath: string): Promise<void> => {
  try {
    await access(workflowPath);
  } catch {
    throw new Error(`Workflow file not found: ${workflowPath}`);
  }
};

if (import.meta.main) {
  main().catch((error) => {
    logger.error("Symphony Bun startup failed", {
      reason: error instanceof Error ? error.message : String(error),
    });

    console.error(
      "\nUsage: bun run src/cli.ts [--port <port>] [--dashboard-port <port>] [path-to-WORKFLOW.md ...]\n" +
        "Examples:\n" +
        "  bun run src/cli.ts ./workflows/WORKFLOW.linear.local.md\n" +
        "  bun run src/cli.ts ./workflows/WORKFLOW.linear.local.md ./workflows/WORKFLOW.linear.team-review.local.md\n" +
        "  bun run src/cli.ts --dashboard-port 8788 ./workflows/WORKFLOW.linear.local.md ./workflows/WORKFLOW.linear.team-review.local.md\n",
    );
    process.exit(1);
  });
}
