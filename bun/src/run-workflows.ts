#!/usr/bin/env bun

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { main as runCli } from "./cli";
import { logger } from "./utils/logger";

const DEFAULT_WORKFLOW_DIR = "./workflows";

export const discoverWorkflowFiles = async (directory: string): Promise<string[]> => {
  const resolvedDirectory = resolve(directory);
  const entries = await readdir(resolvedDirectory);

  const candidatePaths = entries
    .filter((entry) => entry.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => join(resolvedDirectory, entry));

  const files: string[] = [];

  for (const candidatePath of candidatePaths) {
    const details = await stat(candidatePath);
    if (details.isFile()) {
      files.push(candidatePath);
    }
  }

  return files;
};

const main = async (): Promise<void> => {
  const workflowDirectory = Bun.argv[2] ? resolve(Bun.argv[2] as string) : resolve(DEFAULT_WORKFLOW_DIR);
  const workflowPaths = await discoverWorkflowFiles(workflowDirectory);

  if (workflowPaths.length === 0) {
    throw new Error(`No workflow .md files found in directory: ${workflowDirectory}`);
  }

  logger.info("Launching workflows from directory", {
    workflow_directory: workflowDirectory,
    workflow_count: workflowPaths.length,
    workflows: workflowPaths,
  });

  await runCli(workflowPaths);
};

if (import.meta.main) {
  main().catch((error) => {
    logger.error("Workflow directory startup failed", {
      reason: error instanceof Error ? error.message : String(error),
    });

    console.error(
      "\nUsage: bun run src/run-workflows.ts [path-to-workflows-directory]\n" +
        "Example:\n" +
        "  bun run src/run-workflows.ts ./workflows\n",
    );
    process.exit(1);
  });
}
