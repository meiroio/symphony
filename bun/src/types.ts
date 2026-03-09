export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string | null;
  identifier: string | null;
  title: string | null;
  description: string | null;
  priority: number | null;
  state: string | null;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: Date | null;
  updatedAt: Date | null;
  assigneeId: string | null;
  assignedToWorker: boolean;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt: string;
  promptTemplate: string;
}

export interface RepositoryConfig {
  id: string;
  remote: string;
  checkout: string;
  target: string;
  primary: boolean;
}

export interface HookConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface TrackerConfig {
  kind: string | null;
  endpoint: string;
  apiKey: string | null;
  projectSlug: string | null;
  teamKey: string | null;
  teamId: string | null;
  assignee: string | null;
  webhookPath: string | null;
  webhookSecret: string | null;
  requiredLabels: string[];
  activeStates: string[];
  terminalStates: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
  continuationStates: string[];
}

export interface CodexConfig {
  command: string;
  approvalPolicy: string | Record<string, unknown>;
  threadSandbox: string;
  turnSandboxPolicy: Record<string, unknown>;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface ServerConfig {
  port: number | null;
  host: string;
}

export interface WorkflowVisualizationStage {
  id: string;
  label: string;
  state: string | null;
  description: string | null;
}

export interface WorkflowVisualizationTransition {
  from: string;
  to: string;
  label: string | null;
  tone: "default" | "alert";
}

export interface WorkflowVisualizationConfig {
  stages: WorkflowVisualizationStage[];
  transitions: WorkflowVisualizationTransition[];
}

export interface EffectiveConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  repositories?: RepositoryConfig[];
  promptVariables?: Record<string, unknown>;
  workflowId?: string;
  workflowPath?: string | null;
  workflowVisualization?: WorkflowVisualizationConfig | null;
  hooks: HookConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  server: ServerConfig;
  promptTemplate: string;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  error: string | null;
}

export interface RunningEntry {
  issue: Issue;
  issueId: string;
  identifier: string;
  abortController: AbortController;
  retryAttempt: number;
  startedAt: Date;
  sessionId: string | null;
  codexAppServerPid: string | null;
  lastCodexEvent: string | null;
  lastCodexTimestamp: Date | null;
  lastCodexMessage: unknown;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
}

export interface CodexTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export interface RuntimeSnapshot {
  workflowId?: string;
  workflowPath?: string | null;
  running: Array<{
    issueId: string;
    identifier: string;
    state: string | null;
    sessionId: string | null;
    codexAppServerPid: string | null;
    codexInputTokens: number;
    codexOutputTokens: number;
    codexTotalTokens: number;
    turnCount: number;
    startedAt: Date;
    lastCodexTimestamp: Date | null;
    lastCodexMessage: unknown;
    lastCodexEvent: string | null;
    runtimeSeconds: number;
  }>;
  retrying: Array<{
    issueId: string;
    identifier: string;
    attempt: number;
    dueInMs: number;
    error: string | null;
  }>;
  codexTotals: CodexTotals;
  rateLimits: Record<string, unknown> | null;
  polling: {
    checking: boolean;
    nextPollInMs: number | null;
    pollIntervalMs: number;
  };
}

export interface TrackerAdapter {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}

export interface WorkerRunOptions {
  attempt: number | null;
  signal: AbortSignal;
  onMessage?: (event: CodexEvent) => void;
}

export interface CodexEvent {
  event: string;
  timestamp: Date;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  turnId?: string | undefined;
  codexAppServerPid?: string | undefined;
  usage?: Record<string, unknown>;
  rateLimits?: Record<string, unknown>;
  payload?: unknown;
  raw?: unknown;
  [key: string]: unknown;
}

export interface AppServerSession {
  process: Bun.Subprocess;
  approvalPolicy: string | Record<string, unknown>;
  autoApproveRequests: boolean;
  threadSandbox: string;
  turnSandboxPolicy: Record<string, unknown>;
  threadId: string;
  workspace: string;
  codexAppServerPid: string | null;
  messageBus: unknown;
}
