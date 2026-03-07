import { describe, expect, test } from "bun:test";

import { buildPrompt } from "../src/prompt/prompt-builder";
import type { Issue } from "../src/types";

const ISSUE: Issue = {
  id: "issue-1",
  identifier: "TIM-1",
  title: "Sample issue",
  description: "Sample description",
  priority: 2,
  state: "Testing",
  branchName: "tim-1-sample-issue",
  url: "https://linear.app/example/TIM-1",
  labels: ["feature"],
  blockedBy: [],
  createdAt: new Date("2026-03-07T00:00:00.000Z"),
  updatedAt: new Date("2026-03-07T00:10:00.000Z"),
  assigneeId: "user-1",
  assignedToWorker: true,
};

describe("prompt builder", () => {
  test("renders prompt variables as vars.*", async () => {
    const rendered = await buildPrompt(
      "State: {{ issue.state }}\nTest command: {{ vars.testing_command }}",
      ISSUE,
      null,
      {
        variables: {
          testing_command: "bun run test:e2e",
        },
      },
    );

    expect(rendered).toContain("State: Testing");
    expect(rendered).toContain("Test command: bun run test:e2e");
  });
});
