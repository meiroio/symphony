import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

import { SymphonyError } from "../utils/errors";
import type { WorkflowDefinition } from "../types";

export const WORKFLOW_FILE_NAME = "WORKFLOW.md";

export const defaultWorkflowPath = (): string => join(process.cwd(), WORKFLOW_FILE_NAME);

export const loadWorkflow = async (path: string): Promise<WorkflowDefinition> => {
  let content: string;

  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    throw new SymphonyError("missing_workflow_file", `Workflow file not found: ${path}`, {
      path,
      cause: error,
    });
  }

  return parseWorkflow(content);
};

export const parseWorkflow = (content: string): WorkflowDefinition => {
  const { frontMatterLines, promptLines } = splitFrontMatter(content);

  let config: Record<string, unknown>;
  const frontMatterText = frontMatterLines.join("\n");

  if (frontMatterText.trim().length === 0) {
    config = {};
  } else {
    let decoded: unknown;

    try {
      decoded = yaml.load(frontMatterText);
    } catch (error) {
      throw new SymphonyError("workflow_parse_error", "Failed to parse workflow front matter", {
        cause: error,
      });
    }

    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new SymphonyError(
        "workflow_front_matter_not_a_map",
        "Workflow front matter must decode to an object map",
      );
    }

    config = decoded as Record<string, unknown>;
  }

  const prompt = promptLines.join("\n").trim();

  return {
    config,
    prompt,
    promptTemplate: prompt,
  };
};

const splitFrontMatter = (content: string): {
  frontMatterLines: string[];
  promptLines: string[];
} => {
  const lines = content.split(/\r?\n/);

  if (lines[0] !== "---") {
    return {
      frontMatterLines: [],
      promptLines: lines,
    };
  }

  const tail = lines.slice(1);
  const closingIndex = tail.indexOf("---");

  if (closingIndex === -1) {
    return {
      frontMatterLines: tail,
      promptLines: [],
    };
  }

  return {
    frontMatterLines: tail.slice(0, closingIndex),
    promptLines: tail.slice(closingIndex + 1),
  };
};
