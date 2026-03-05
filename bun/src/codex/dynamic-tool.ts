import type { EffectiveConfig } from "../types";

const LINEAR_GRAPHQL_TOOL = "linear_graphql";

export const dynamicToolSpecs = (): Array<Record<string, unknown>> => {
  return [
    {
      name: LINEAR_GRAPHQL_TOOL,
      description:
        "Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "GraphQL query or mutation document to execute against Linear.",
          },
          variables: {
            type: ["object", "null"],
            description: "Optional GraphQL variables object.",
            additionalProperties: true,
          },
        },
      },
    },
  ];
};

export const executeDynamicTool = async (
  toolName: string | null,
  argumentsPayload: unknown,
  config: EffectiveConfig,
): Promise<Record<string, unknown>> => {
  if (toolName !== LINEAR_GRAPHQL_TOOL) {
    return failureResponse({
      error: {
        message: `Unsupported dynamic tool: ${String(toolName)}`,
        supportedTools: [LINEAR_GRAPHQL_TOOL],
      },
    });
  }

  if (config.tracker.kind !== "linear") {
    return failureResponse({
      error: {
        message: "linear_graphql is only available when tracker.kind=linear",
      },
    });
  }

  if (!config.tracker.apiKey) {
    return failureResponse({
      error: {
        message: "Missing Linear API token for linear_graphql",
      },
    });
  }

  const normalized = normalizeArguments(argumentsPayload);
  if (!normalized.ok) {
    return failureResponse({
      error: {
        message: normalized.message,
      },
    });
  }

  if (!hasSingleOperation(normalized.query)) {
    return failureResponse({
      error: {
        message: "linear_graphql expects exactly one GraphQL operation",
      },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(config.tracker.endpoint, {
      method: "POST",
      headers: {
        Authorization: config.tracker.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: normalized.query,
        variables: normalized.variables,
      }),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => ({
      error: {
        message: "Unable to parse Linear GraphQL JSON response",
      },
    }))) as Record<string, unknown>;

    if (!response.ok) {
      return failureResponse({
        error: {
          message: `Linear GraphQL request failed with HTTP ${response.status}`,
          status: response.status,
          body,
        },
      });
    }

    const hasErrors = Array.isArray((body as { errors?: unknown }).errors) &&
      ((body as { errors?: unknown[] }).errors?.length ?? 0) > 0;

    return {
      success: !hasErrors,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(body, null, 2),
        },
      ],
    };
  } catch (error) {
    return failureResponse({
      error: {
        message: "Linear GraphQL request failed before receiving a response",
        reason: String(error),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
};

const normalizeArguments = (
  argumentsPayload: unknown,
):
  | { ok: true; query: string; variables: Record<string, unknown> }
  | { ok: false; message: string } => {
  if (typeof argumentsPayload === "string") {
    const query = argumentsPayload.trim();
    if (!query) {
      return { ok: false, message: "linear_graphql requires a non-empty query" };
    }

    return { ok: true, query, variables: {} };
  }

  if (argumentsPayload && typeof argumentsPayload === "object" && !Array.isArray(argumentsPayload)) {
    const payload = argumentsPayload as Record<string, unknown>;
    const query = typeof payload.query === "string" ? payload.query.trim() : "";

    if (!query) {
      return { ok: false, message: "linear_graphql requires a non-empty query" };
    }

    const variables = payload.variables;
    if (variables === undefined || variables === null) {
      return { ok: true, query, variables: {} };
    }

    if (typeof variables === "object" && !Array.isArray(variables)) {
      return {
        ok: true,
        query,
        variables: variables as Record<string, unknown>,
      };
    }

    return {
      ok: false,
      message: "linear_graphql.variables must be an object when provided",
    };
  }

  return {
    ok: false,
    message:
      "linear_graphql expects either a raw GraphQL query string or an object with query and optional variables",
  };
};

const hasSingleOperation = (query: string): boolean => {
  const operationMatches = query.match(/\b(query|mutation|subscription)\b/g);

  if (!operationMatches || operationMatches.length <= 1) {
    return true;
  }

  return false;
};

const failureResponse = (payload: Record<string, unknown>): Record<string, unknown> => {
  return {
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
};
