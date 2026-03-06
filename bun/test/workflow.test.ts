import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

import { defaultWorkflowPath, loadWorkflow, parseWorkflow } from "../src/config/workflow";
import { SymphonyError } from "../src/utils/errors";

describe("workflow parser", () => {
  test("supports prompt-only files", () => {
    const parsed = parseWorkflow("Prompt only\n");

    expect(parsed.config).toEqual({});
    expect(parsed.prompt).toBe("Prompt only");
    expect(parsed.promptTemplate).toBe("Prompt only");
  });

  test("supports yaml front matter and prompt body", () => {
    const parsed = parseWorkflow(`---
tracker:
  kind: linear
---
Hello {{ issue.identifier }}
`);

    expect(parsed.config).toEqual({
      tracker: {
        kind: "linear",
      },
    });
    expect(parsed.prompt).toBe("Hello {{ issue.identifier }}");
  });

  test("supports unterminated front matter with empty prompt", () => {
    const parsed = parseWorkflow(`---
tracker:
  kind: linear
`);

    expect(parsed.config).toEqual({
      tracker: {
        kind: "linear",
      },
    });
    expect(parsed.prompt).toBe("");
  });

  test("rejects non-map front matter", () => {
    expect(() =>
      parseWorkflow(`---
- not-a-map
---
Prompt
`),
    ).toThrow(SymphonyError);

    try {
      parseWorkflow(`---
- not-a-map
---
Prompt
`);
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyError);
      expect((error as SymphonyError).code).toBe("workflow_front_matter_not_a_map");
    }
  });

  test("rejects invalid yaml front matter with typed error", () => {
    expect(() =>
      parseWorkflow(`---
tracker:
  kind: [linear
---
Prompt
`),
    ).toThrow(SymphonyError);

    try {
      parseWorkflow(`---
tracker:
  kind: [linear
---
Prompt
`);
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyError);
      expect((error as SymphonyError).code).toBe("workflow_parse_error");
    }
  });

  test("missing workflow file returns typed error", async () => {
    const path = join(tmpdir(), `missing-workflow-${Date.now()}-${Math.random()}.md`);

    try {
      await loadWorkflow(path);
      throw new Error("expected loadWorkflow to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyError);
      expect((error as SymphonyError).code).toBe("missing_workflow_file");
    } finally {
      await rm(path, { force: true });
    }
  });

  test("default workflow path resolves to cwd WORKFLOW.md", () => {
    expect(defaultWorkflowPath()).toBe(join(process.cwd(), "WORKFLOW.md"));
  });
});
