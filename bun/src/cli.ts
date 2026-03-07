#!/usr/bin/env bun

import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { SymphonyService } from "./service";
import { defaultWorkflowPath } from "./config/workflow";
import { logger } from "./utils/logger";

interface CliOptions {
  workflowPaths: string[];
  portOverride: number | null;
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
  }));

  const shutdown = async (signal: string) => {
    logger.info("Shutting down Symphony service", {
      signal,
      workflows: options.workflowPaths,
    });
    await Promise.all(serviceSpecs.map(({ service }) => service.stop()));
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  for (const { workflowPath, service, index } of serviceSpecs) {
    const { httpPort, workflowId, workflowPath } = await service.start();

    logger.info("Symphony Bun service started", {
      workflow_path: workflowPath,
      workflow_id: workflowId,
      http_port: httpPort,
      service_index: index,
      total_services: serviceSpecs.length,
    });
  }
};

export const parseArgs = (args: string[]): CliOptions => {
  const workflowPaths: string[] = [];
  let portOverride: number | null = null;

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

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    workflowPaths.push(resolve(arg));
  }

  const resolvedWorkflowPaths = workflowPaths.length > 0 ? workflowPaths : [defaultWorkflowPath()];

  if (portOverride !== null && resolvedWorkflowPaths.length > 1) {
    throw new Error("--port can only be used with a single workflow path");
  }

  return {
    workflowPaths: resolvedWorkflowPaths,
    portOverride,
  };
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
      "\nUsage: bun run src/cli.ts [--port <port>] [path-to-WORKFLOW.md ...]\n" +
        "Examples:\n" +
        "  bun run src/cli.ts ./workflows/WORKFLOW.linear.local.md\n" +
        "  bun run src/cli.ts ./workflows/WORKFLOW.linear.local.md ./workflows/WORKFLOW.linear.team-review.local.md\n",
    );
    process.exit(1);
  });
}
