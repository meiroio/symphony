#!/usr/bin/env bun

import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { SymphonyService } from "./service";
import { defaultWorkflowPath } from "./config/workflow";
import { logger } from "./utils/logger";

interface CliOptions {
  workflowPath: string;
  portOverride: number | null;
}

const main = async (): Promise<void> => {
  const options = parseArgs(Bun.argv.slice(2));
  await assertWorkflowExists(options.workflowPath);

  const service = new SymphonyService({
    workflowPath: options.workflowPath,
    serverPortOverride: options.portOverride,
  });

  const shutdown = async (signal: string) => {
    logger.info("Shutting down Symphony service", { signal });
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  const { httpPort } = await service.start();

  logger.info("Symphony Bun service started", {
    workflow_path: options.workflowPath,
    http_port: httpPort,
  });
};

const parseArgs = (args: string[]): CliOptions => {
  let workflowPath: string | null = null;
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

    if (workflowPath) {
      throw new Error("Only one workflow path may be provided");
    }

    workflowPath = resolve(arg);
  }

  return {
    workflowPath: workflowPath ?? defaultWorkflowPath(),
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

main().catch((error) => {
  logger.error("Symphony Bun startup failed", {
    reason: error instanceof Error ? error.message : String(error),
  });

  console.error(`\nUsage: bun run src/cli.ts [--port <port>] [path-to-WORKFLOW.md]\n`);
  process.exit(1);
});
