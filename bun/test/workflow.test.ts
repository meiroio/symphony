import { describe, expect, test } from "bun:test";

import { parseWorkflow } from "../src/config/workflow";
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
});
