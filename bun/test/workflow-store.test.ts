import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowStore } from "../src/config/workflow-store";
import { SymphonyError } from "../src/utils/errors";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0, roots.length).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workflow store", () => {
  test("reloads workflow when file contents change", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-workflow-store-"));
    roots.push(root);
    const workflowPath = join(root, "WORKFLOW.md");

    await writeFile(workflowPath, workflowDocument("Prompt A"), "utf8");

    const store = new WorkflowStore(workflowPath);
    await store.start();

    try {
      expect(store.current().prompt).toBe("Prompt A");

      await writeFile(workflowPath, workflowDocument("Prompt B"), "utf8");
      await store.forceReload();

      expect(store.current().prompt).toBe("Prompt B");
    } finally {
      store.stop();
    }
  });

  test("invalid reload keeps last known good workflow and records error", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-workflow-store-"));
    roots.push(root);
    const workflowPath = join(root, "WORKFLOW.md");

    await writeFile(workflowPath, workflowDocument("Prompt A"), "utf8");

    const store = new WorkflowStore(workflowPath);
    await store.start();

    try {
      expect(store.current().prompt).toBe("Prompt A");

      await writeFile(
        workflowPath,
        `---
tracker:
  kind: linear
  project_slug: [broken
---
Prompt B
`,
        "utf8",
      );
      await store.forceReload();

      expect(store.current().prompt).toBe("Prompt A");
      expect(store.getLastError()).toBeInstanceOf(SymphonyError);
      expect((store.getLastError() as SymphonyError).code).toBe("workflow_parse_error");
    } finally {
      store.stop();
    }
  });

  test("changing workflow path reloads from new location", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-workflow-store-"));
    roots.push(root);
    const pathA = join(root, "WORKFLOW-A.md");
    const pathB = join(root, "WORKFLOW-B.md");

    await writeFile(pathA, workflowDocument("Prompt A"), "utf8");
    await writeFile(pathB, workflowDocument("Prompt B"), "utf8");

    const store = new WorkflowStore(pathA);
    await store.start();

    try {
      expect(store.current().prompt).toBe("Prompt A");

      store.setWorkflowPath(pathB);
      await store.forceReload();

      expect(store.current().prompt).toBe("Prompt B");
    } finally {
      store.stop();
    }
  });
});

const workflowDocument = (prompt: string): string => {
  return `---
tracker:
  kind: linear
  project_slug: proj
  api_key: token
---
${prompt}
`;
};
