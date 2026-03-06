import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import type { EffectiveConfig, RepositoryConfig, WorkflowDefinition } from "../types";
import {
  normalizeIssueState,
  parseCsvStringOrArray,
  parseInteger,
  parseNonNegativeInteger,
  parsePositiveInteger,
} from "../utils/normalize";

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_PROMPT_TEMPLATE = `You are working on a Linear issue.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

Body:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}`;

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_WORKSPACE_ROOT = join(tmpdir(), "symphony_workspaces");
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
const DEFAULT_CODEX_COMMAND = "codex app-server";
const DEFAULT_CODEX_TURN_TIMEOUT_MS = 3_600_000;
const DEFAULT_CODEX_READ_TIMEOUT_MS = 5_000;
const DEFAULT_CODEX_STALL_TIMEOUT_MS = 300_000;
const DEFAULT_CODEX_APPROVAL_POLICY: Record<string, unknown> = {
  reject: {
    sandbox_approval: true,
    rules: true,
    mcp_elicitations: true,
  },
};
const DEFAULT_CODEX_THREAD_SANDBOX = "workspace-write";
const DEFAULT_SERVER_HOST = "127.0.0.1";

export interface DispatchValidationResult {
  ok: boolean;
  errorCode?: string;
  message?: string;
}

export const resolveConfig = (
  workflow: WorkflowDefinition,
  env: NodeJS.ProcessEnv = Bun.env,
  serverPortOverride: number | null = null,
): EffectiveConfig => {
  const config = asRecord(workflow.config);

  const tracker = asRecord(config.tracker);
  const polling = asRecord(config.polling);
  const workspace = asRecord(config.workspace);
  const hooks = asRecord(config.hooks);
  const agent = asRecord(config.agent);
  const codex = asRecord(config.codex);
  const server = asRecord(config.server);
  const repositories = normalizeRepositories(config.repositories, env);

  const activeStates = parseCsvStringOrArray(tracker.active_states) ?? DEFAULT_ACTIVE_STATES;
  const terminalStates = parseCsvStringOrArray(tracker.terminal_states) ?? DEFAULT_TERMINAL_STATES;

  const maxConcurrentByState: Record<string, number> = {};
  const rawByState = asRecord(agent.max_concurrent_agents_by_state);
  for (const [stateName, rawLimit] of Object.entries(rawByState)) {
    const parsed = parsePositiveInteger(rawLimit);
    if (parsed !== null) {
      maxConcurrentByState[normalizeIssueState(stateName)] = parsed;
    }
  }

  const resolvedWorkspaceRoot =
    resolvePathValue(
      workspace.root,
      DEFAULT_WORKSPACE_ROOT,
      env,
      // Workspace paths can be relative by design.
      true,
    ) ?? DEFAULT_WORKSPACE_ROOT;

  const codexApprovalPolicy = resolveCodexApprovalPolicy(codex.approval_policy);
  const codexThreadSandbox = resolveCodexThreadSandbox(codex.thread_sandbox);
  const codexTurnSandboxPolicy =
    resolveCodexTurnSandboxPolicy(codex.turn_sandbox_policy, resolvedWorkspaceRoot);

  const promptTemplate =
    typeof workflow.promptTemplate === "string" && workflow.promptTemplate.trim().length > 0
      ? workflow.promptTemplate
      : DEFAULT_PROMPT_TEMPLATE;

  const fallbackApiKey = normalizeSecret(env.LINEAR_API_KEY ?? null);

  return {
    tracker: {
      kind: normalizeTrackerKind(tracker.kind),
      endpoint:
        normalizeNonEmptyString(tracker.endpoint) ??
        (normalizeTrackerKind(tracker.kind) === "linear" ? DEFAULT_LINEAR_ENDPOINT : DEFAULT_LINEAR_ENDPOINT),
      apiKey: normalizeSecret(resolveEnvBackedSecret(tracker.api_key, env, fallbackApiKey)),
      projectSlug: normalizeSecret(normalizeValueToString(tracker.project_slug)),
      assignee: normalizeSecret(resolveEnvBackedSecret(tracker.assignee, env, env.LINEAR_ASSIGNEE ?? null)),
      activeStates,
      terminalStates,
    },
    polling: {
      intervalMs: parsePositiveInteger(polling.interval_ms) ?? DEFAULT_POLL_INTERVAL_MS,
    },
    workspace: {
      root: resolvedWorkspaceRoot,
    },
    repositories,
    hooks: {
      afterCreate: normalizeHookScript(hooks.after_create),
      beforeRun: normalizeHookScript(hooks.before_run),
      afterRun: normalizeHookScript(hooks.after_run),
      beforeRemove: normalizeHookScript(hooks.before_remove),
      timeoutMs: parsePositiveInteger(hooks.timeout_ms) ?? DEFAULT_HOOK_TIMEOUT_MS,
    },
    agent: {
      maxConcurrentAgents:
        parsePositiveInteger(agent.max_concurrent_agents) ?? DEFAULT_MAX_CONCURRENT_AGENTS,
      maxTurns: parsePositiveInteger(agent.max_turns) ?? DEFAULT_MAX_TURNS,
      maxRetryBackoffMs:
        parsePositiveInteger(agent.max_retry_backoff_ms) ?? DEFAULT_MAX_RETRY_BACKOFF_MS,
      maxConcurrentAgentsByState: maxConcurrentByState,
    },
    codex: {
      command: normalizeNonEmptyString(codex.command) ?? DEFAULT_CODEX_COMMAND,
      approvalPolicy: codexApprovalPolicy,
      threadSandbox: codexThreadSandbox,
      turnSandboxPolicy: codexTurnSandboxPolicy,
      turnTimeoutMs: parsePositiveInteger(codex.turn_timeout_ms) ?? DEFAULT_CODEX_TURN_TIMEOUT_MS,
      readTimeoutMs: parsePositiveInteger(codex.read_timeout_ms) ?? DEFAULT_CODEX_READ_TIMEOUT_MS,
      stallTimeoutMs: Math.max(parseInteger(codex.stall_timeout_ms) ?? DEFAULT_CODEX_STALL_TIMEOUT_MS, 0),
    },
    server: {
      port:
        serverPortOverride !== null
          ? serverPortOverride
          : parseNonNegativeInteger(server.port),
      host: normalizeNonEmptyString(server.host) ?? DEFAULT_SERVER_HOST,
    },
    promptTemplate,
  };
};

export const validateDispatchConfig = (config: EffectiveConfig): DispatchValidationResult => {
  if (!config.tracker.kind) {
    return {
      ok: false,
      errorCode: "missing_tracker_kind",
      message: "tracker.kind is required",
    };
  }

  if (config.tracker.kind !== "linear" && config.tracker.kind !== "memory") {
    return {
      ok: false,
      errorCode: "unsupported_tracker_kind",
      message: `Unsupported tracker kind: ${config.tracker.kind}`,
    };
  }

  if (config.tracker.kind === "linear") {
    if (!config.tracker.apiKey) {
      return {
        ok: false,
        errorCode: "missing_linear_api_token",
        message: "Linear API token is missing",
      };
    }

    if (!config.tracker.projectSlug) {
      return {
        ok: false,
        errorCode: "missing_linear_project_slug",
        message: "Linear project slug is missing",
      };
    }
  }

  if (!config.codex.command || config.codex.command.trim().length === 0) {
    return {
      ok: false,
      errorCode: "missing_codex_command",
      message: "codex.command is required",
    };
  }

  return { ok: true };
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
};

const normalizeValueToString = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  return null;
};

const normalizeNonEmptyString = (value: unknown): string | null => {
  const asString = normalizeValueToString(value);
  if (asString === null) {
    return null;
  }

  const trimmed = asString.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeSecret = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeTrackerKind = (value: unknown): string | null => {
  const kind = normalizeNonEmptyString(value);
  if (!kind) {
    return null;
  }

  return kind.toLowerCase();
};

const normalizeHookScript = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return value.trimEnd();
};

const resolveCodexApprovalPolicy = (value: unknown): string | Record<string, unknown> => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_CODEX_APPROVAL_POLICY;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return DEFAULT_CODEX_APPROVAL_POLICY;
};

const resolveCodexThreadSandbox = (value: unknown): string => {
  const normalized = normalizeNonEmptyString(value);
  return normalized ?? DEFAULT_CODEX_THREAD_SANDBOX;
};

const resolveCodexTurnSandboxPolicy = (
  value: unknown,
  workspaceRoot: string,
): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {
    type: "workspaceWrite",
    writableRoots: [resolve(workspaceRoot)],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
};

const resolveEnvBackedSecret = (
  rawValue: unknown,
  env: NodeJS.ProcessEnv,
  fallback: string | null,
): string | null => {
  const normalized = normalizeValueToString(rawValue);
  if (normalized === null) {
    return fallback;
  }

  const trimmed = normalized.trim();

  const envName = envReferenceName(trimmed);
  if (!envName) {
    return trimmed.length > 0 ? trimmed : fallback;
  }

  const resolved = env[envName];
  if (resolved === undefined) {
    return fallback;
  }

  if (resolved.trim().length === 0) {
    return null;
  }

  return resolved;
};

const resolvePathValue = (
  rawValue: unknown,
  fallback: string,
  env: NodeJS.ProcessEnv,
  allowRelativePreservation: boolean,
): string | null => {
  const normalized = normalizeValueToString(rawValue);
  if (normalized === null) {
    return fallback;
  }

  const trimmed = normalized.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  const envName = envReferenceName(trimmed);
  const envResolved = envName ? env[envName] ?? "" : trimmed;
  const value = envResolved.trim();

  if (value.length === 0) {
    return fallback;
  }

  if (value.startsWith("~")) {
    const home = env.HOME ?? Bun.env.HOME;
    if (home) {
      const suffix = value === "~" ? "" : value.slice(2);
      return resolve(home, suffix);
    }
  }

  if (isUri(value)) {
    return value;
  }

  if (value.includes(sep) || value.includes("/") || value.includes("\\")) {
    return resolve(value);
  }

  if (allowRelativePreservation) {
    return value;
  }

  return resolve(value);
};

const isUri = (value: string): boolean => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);

const envReferenceName = (value: string): string | null => {
  if (!value.startsWith("$")) {
    return null;
  }

  const envName = value.slice(1);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    return envName;
  }

  return null;
};

const normalizeRepositories = (
  value: unknown,
  env: NodeJS.ProcessEnv,
): RepositoryConfig[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed: RepositoryConfig[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const raw = asRecord(value[index]);
    const remote = resolveEnvBackedSecret(raw.remote, env, null);

    if (!remote) {
      continue;
    }

    const rawId = normalizeNonEmptyString(raw.id);
    const id = rawId ?? `repo_${index + 1}`;
    const checkout = normalizeNonEmptyString(raw.checkout) ?? "main";
    const target = normalizeRepositoryTarget(resolveEnvBackedSecret(raw.target, env, ".") ?? ".");
    const primary = raw.primary === true;

    parsed.push({
      id,
      remote,
      checkout,
      target,
      primary,
    });
  }

  if (parsed.length === 0) {
    return [];
  }

  const firstPrimaryIndex = parsed.findIndex((repository) => repository.primary);
  const normalizedPrimaryIndex = firstPrimaryIndex >= 0 ? firstPrimaryIndex : 0;

  return parsed.map((repository, index) => ({
    ...repository,
    primary: index === normalizedPrimaryIndex,
  }));
};

const normalizeRepositoryTarget = (value: unknown): string => {
  const asString = normalizeValueToString(value);
  if (asString === null) {
    return ".";
  }

  const trimmed = asString.trim();
  if (trimmed.length === 0) {
    return ".";
  }

  return trimmed;
};
