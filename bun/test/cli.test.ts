import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { parseArgs } from "../src/cli";
import { defaultWorkflowPath } from "../src/config/workflow";

describe("cli argument parsing", () => {
  test("defaults to current directory WORKFLOW.md when no path is provided", () => {
    const parsed = parseArgs([]);
    expect(parsed.workflowPaths).toEqual([defaultWorkflowPath()]);
    expect(parsed.portOverride).toBeNull();
  });

  test("accepts multiple workflow paths", () => {
    const parsed = parseArgs(["./WORKFLOW.a.md", "./WORKFLOW.b.md"]);
    expect(parsed.workflowPaths).toEqual([
      resolve("./WORKFLOW.a.md"),
      resolve("./WORKFLOW.b.md"),
    ]);
  });

  test("accepts port override for single workflow", () => {
    const parsed = parseArgs(["--port", "8790", "./WORKFLOW.a.md"]);
    expect(parsed.portOverride).toBe(8790);
    expect(parsed.workflowPaths).toEqual([resolve("./WORKFLOW.a.md")]);
  });

  test("rejects port override when multiple workflows are provided", () => {
    expect(() =>
      parseArgs(["--port", "8790", "./WORKFLOW.a.md", "./WORKFLOW.b.md"]),
    ).toThrow("--port can only be used with a single workflow path");
  });
});
