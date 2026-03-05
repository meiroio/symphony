import { Liquid } from "liquidjs";

import type { Issue } from "../types";
import { SymphonyError } from "../utils/errors";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export const buildPrompt = async (
  templateSource: string,
  issue: Issue,
  attempt: number | null,
): Promise<string> => {
  let template;

  try {
    template = engine.parse(templateSource);
  } catch (error) {
    throw new SymphonyError("template_parse_error", "Failed to parse workflow prompt template", {
      cause: error,
    });
  }

  try {
    const rendered = await engine.render(template, {
      issue: toTemplateValue(issue),
      attempt,
    });

    return rendered;
  } catch (error) {
    throw new SymphonyError(
      "template_render_error",
      "Failed to render workflow prompt template in strict mode",
      {
        cause: error,
      },
    );
  }
};

const toTemplateValue = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toTemplateValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        String(key),
        toTemplateValue(entry),
      ]),
    );
  }

  return value;
};
