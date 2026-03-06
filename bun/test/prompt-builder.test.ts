import { describe, expect, test } from "bun:test";

import { buildPrompt } from "../src/prompt/prompt-builder";
import type { Issue } from "../src/types";
import { SymphonyError } from "../src/utils/errors";

const issue: Issue = {
  id: "issue-1",
  identifier: "MT-1",
  title: "Prompt test",
  description: "Body",
  priority: 2,
  state: "In Progress",
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: new Date("2026-03-05T12:00:00.000Z"),
  updatedAt: new Date("2026-03-05T12:00:10.000Z"),
  assigneeId: null,
  assignedToWorker: true,
};

describe("prompt builder", () => {
  test("renders issue and attempt variables", async () => {
    const rendered = await buildPrompt(
      "Issue {{ issue.identifier }} title {{ issue.title }} attempt {{ attempt }}",
      issue,
      3,
    );

    expect(rendered).toContain("MT-1");
    expect(rendered).toContain("Prompt test");
    expect(rendered).toContain("3");
  });

  test("fails with typed render error on unknown variables", async () => {
    try {
      await buildPrompt("{{ issue.unknown_field }}", issue, null);
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyError);
      expect((error as SymphonyError).code).toBe("template_render_error");
    }
  });
});
