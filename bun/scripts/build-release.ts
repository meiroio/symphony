#!/usr/bin/env bun

import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

interface BuildOptions {
  workflowDir: string;
  target: string | null;
  outDir: string | null;
}

const ROOT_DIR = resolve(import.meta.dir, "..");
const DEFAULT_WORKFLOW_DIR = resolve(ROOT_DIR, "workflows");
const ENTRYPOINT = resolve(ROOT_DIR, "src", "run-workflows.ts");

const parseArgs = (args: string[]): BuildOptions => {
  let workflowDir = DEFAULT_WORKFLOW_DIR;
  let target = Bun.env.SYMPHONY_BUILD_TARGET?.trim() || null;
  let outDir: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === "--target") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--target requires a Bun compile target value");
      }
      target = value;
      index += 1;
      continue;
    }

    if (arg === "--outdir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--outdir requires a path");
      }
      outDir = resolve(ROOT_DIR, value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    workflowDir = resolve(ROOT_DIR, arg);
  }

  return { workflowDir, target, outDir };
};

const releaseLabel = (target: string | null): string => {
  if (target && target.length > 0) {
    return target;
  }

  return `${process.platform}-${process.arch}`;
};

const discoverWorkflowFiles = async (workflowDir: string): Promise<string[]> => {
  const details = await stat(workflowDir).catch(() => null);
  if (!details || !details.isDirectory()) {
    throw new Error(`Workflow directory not found: ${workflowDir}`);
  }

  const entries = await readdir(workflowDir);
  const files = entries
    .filter((entry) => entry.toLowerCase().endsWith(".md"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => join(workflowDir, entry));

  if (files.length === 0) {
    throw new Error(`No workflow .md files found in directory: ${workflowDir}`);
  }

  return files;
};

const compileBinary = (outfile: string, target: string | null): void => {
  const args = [
    process.execPath,
    "build",
    ENTRYPOINT,
    "--compile",
    "--outfile",
    outfile,
  ];

  if (target) {
    args.push("--target", target);
  }

  const result = Bun.spawnSync(args, {
    cwd: ROOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();
    throw new Error(`Bun compile failed\n${stderr || stdout}`);
  }
};

const copyWorkflows = async (workflowFiles: string[], destinationDir: string): Promise<void> => {
  await mkdir(destinationDir, { recursive: true });

  for (const workflowFile of workflowFiles) {
    await copyFile(workflowFile, join(destinationDir, basename(workflowFile)));
  }
};

const writeReleaseEnv = async (destinationFile: string): Promise<void> => {
  const envExamplePath = resolve(ROOT_DIR, ".env.example");
  const content = await readFile(envExamplePath, "utf8").catch(() => "");
  await writeFile(destinationFile, content, "utf8");
};

const main = async (): Promise<void> => {
  const options = parseArgs(Bun.argv.slice(2));
  const workflows = await discoverWorkflowFiles(options.workflowDir);
  const label = releaseLabel(options.target);
  const outputDir = options.outDir ?? resolve(ROOT_DIR, "dist", "release", label);
  const binaryName = process.platform === "win32" ? "symphony.exe" : "symphony";
  const binaryPath = join(outputDir, binaryName);

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  compileBinary(binaryPath, options.target);
  await copyWorkflows(workflows, join(outputDir, "workflows"));
  await writeReleaseEnv(join(outputDir, ".env"));

  console.log(`Release bundle created at ${outputDir}`);
  console.log(`Binary: ${binaryPath}`);
  console.log(`Env: ${join(outputDir, ".env")}`);
  console.log(`Workflows: ${join(outputDir, "workflows")}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    "\nUsage: bun run scripts/build-release.ts [workflow-dir] [--target <bun-target>] [--outdir <path>]\n" +
      "Examples:\n" +
      "  bun run scripts/build-release.ts\n" +
      "  bun run scripts/build-release.ts ./workflows --target bun-linux-x64\n",
  );
  process.exit(1);
});
