import type {
  CodexEvent,
  CodexTotals,
  EffectiveConfig,
  Issue,
  RetryEntry,
  RunningEntry,
  RuntimeSnapshot,
} from "../types";
import { resolveConfig, validateDispatchConfig } from "../config/config";
import type { WorkflowStore } from "../config/workflow-store";
import { createTracker, type TrackerFactoryOptions } from "../tracker/tracker";
import { LinearClient } from "../tracker/linear-client";
import { WorkspaceManager } from "../workspace/workspace-manager";
import { AppServerClient } from "../codex/app-server";
import { AgentRunner } from "../agent/agent-runner";
import { logger } from "../utils/logger";
import { normalizeIssueState } from "../utils/normalize";

const CONTINUATION_RETRY_DELAY_MS = 1_000;
const FAILURE_RETRY_BASE_MS = 10_000;

interface OrchestratorOptions {
  workflowStore: WorkflowStore;
  serverPortOverride?: number | null;
  trackerOptions?: TrackerFactoryOptions;
}

interface RetryMetadata {
  identifier?: string;
  error?: string;
  delayType?: "continuation";
}

const EMPTY_TOTALS: CodexTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  secondsRunning: 0,
};

export class Orchestrator {
  private readonly workflowStore: WorkflowStore;
  private readonly trackerOptions: TrackerFactoryOptions;
  private readonly serverPortOverride: number | null;
  private readonly workspaceManager: WorkspaceManager;
  private readonly appServerClient: AppServerClient;
  private readonly agentRunner: AgentRunner;

  private currentConfig: EffectiveConfig | null = null;

  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retryAttempts = new Map<string, RetryEntry>();
  private readonly completed = new Set<string>();
  private codexTotals: CodexTotals = { ...EMPTY_TOTALS };
  private codexRateLimits: Record<string, unknown> | null = null;

  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private nextPollDueAtMs: number | null = null;
  private pollCheckInProgress = false;
  private started = false;
  private readonly listeners = new Set<() => void>();

  constructor(options: OrchestratorOptions) {
    this.workflowStore = options.workflowStore;
    this.trackerOptions = options.trackerOptions ?? {};
    this.serverPortOverride = options.serverPortOverride ?? null;

    const configProvider = () => {
      if (!this.currentConfig) {
        throw new Error("orchestrator_not_started");
      }

      return this.currentConfig;
    };

    this.workspaceManager = new WorkspaceManager(configProvider);
    this.appServerClient = new AppServerClient(configProvider);
    this.agentRunner = new AgentRunner(configProvider, this.workspaceManager, this.appServerClient);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.currentConfig = this.resolveCurrentConfig();

    const validation = validateDispatchConfig(this.currentConfig);
    if (!validation.ok) {
      throw new Error(validation.message ?? validation.errorCode ?? "invalid_config");
    }

    await this.logTrackerConnectionStatus();
    await this.runStartupTerminalCleanup();

    this.started = true;
    this.scheduleTick(0);
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
      this.nextPollDueAtMs = null;
    }

    for (const retryEntry of this.retryAttempts.values()) {
      clearTimeout(retryEntry.timer);
    }

    this.retryAttempts.clear();

    for (const issueId of [...this.running.keys()]) {
      this.terminateRunningIssue(issueId, false);
    }

    this.notifyUpdate();
  }

  requestRefresh(): {
    queued: true;
    coalesced: boolean;
    requestedAt: Date;
    operations: ["poll", "reconcile"];
  } {
    const now = Date.now();
    const alreadyDue = this.nextPollDueAtMs !== null && this.nextPollDueAtMs <= now;
    const coalesced = this.pollCheckInProgress || alreadyDue;

    if (!coalesced) {
      this.scheduleTick(0);
    }

    return {
      queued: true,
      coalesced,
      requestedAt: new Date(),
      operations: ["poll", "reconcile"],
    };
  }

  snapshot(): RuntimeSnapshot {
    if (!this.currentConfig) {
      throw new Error("orchestrator_not_started");
    }

    const now = new Date();
    const nowMs = Date.now();

    const running = [...this.running.entries()].map(([issueId, entry]) => ({
      issueId,
      identifier: entry.identifier,
      state: entry.issue.state,
      sessionId: entry.sessionId,
      codexAppServerPid: entry.codexAppServerPid,
      codexInputTokens: entry.codexInputTokens,
      codexOutputTokens: entry.codexOutputTokens,
      codexTotalTokens: entry.codexTotalTokens,
      turnCount: entry.turnCount,
      startedAt: entry.startedAt,
      lastCodexTimestamp: entry.lastCodexTimestamp,
      lastCodexMessage: entry.lastCodexMessage,
      lastCodexEvent: entry.lastCodexEvent,
      runtimeSeconds: runningSeconds(entry.startedAt, now),
    }));

    const retrying = [...this.retryAttempts.entries()].map(([issueId, retry]) => ({
      issueId,
      identifier: retry.identifier,
      attempt: retry.attempt,
      dueInMs: Math.max(0, retry.dueAtMs - nowMs),
      error: retry.error,
    }));

    return {
      workflowId: this.currentConfig.workflowId ?? this.inferWorkflowId(),
      workflowPath: this.currentConfig.workflowPath ?? this.workflowStore.getWorkflowPath(),
      running,
      retrying,
      codexTotals: {
        ...this.codexTotals,
        secondsRunning:
          this.codexTotals.secondsRunning +
          running.reduce((sum, entry) => sum + entry.runtimeSeconds, 0),
      },
      rateLimits: this.codexRateLimits,
      polling: {
        checking: this.pollCheckInProgress,
        nextPollInMs:
          this.nextPollDueAtMs !== null ? Math.max(0, this.nextPollDueAtMs - nowMs) : null,
        pollIntervalMs: this.currentConfig.polling.intervalMs,
      },
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyUpdate(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.logWarn("Observer callback failed", { error: String(error) });
      }
    }
  }

  private scheduleTick(delayMs: number): void {
    if (!this.started && delayMs !== 0) {
      return;
    }

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    this.nextPollDueAtMs = Date.now() + delayMs;
    this.tickTimer = setTimeout(() => {
      void this.runPollCycle();
    }, delayMs);
  }

  private async runPollCycle(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.pollCheckInProgress = true;
    this.nextPollDueAtMs = null;
    this.notifyUpdate();

    try {
      this.refreshRuntimeConfig();
      await this.reconcileRunningIssues();

      const config = this.requireConfig();
      const validation = validateDispatchConfig(config);

      if (!validation.ok) {
        this.logError("Dispatch validation failed", {
          code: validation.errorCode,
          reason: validation.message,
        });
        return;
      }

      const tracker = this.createTracker();

      const issues = await tracker.fetchCandidateIssues();
      const sorted = sortIssuesForDispatch(issues);

      for (const issue of sorted) {
        if (this.availableSlots() <= 0) {
          break;
        }

        if (this.shouldDispatchIssue(issue)) {
          await this.dispatchIssue(issue, null);
        }
      }
    } catch (error) {
      this.logError("Poll cycle failed", { reason: String(error) });
    } finally {
      const intervalMs = this.requireConfig().polling.intervalMs;
      this.pollCheckInProgress = false;
      this.scheduleTick(intervalMs);
      this.notifyUpdate();
    }
  }

  private async reconcileRunningIssues(): Promise<void> {
    await this.reconcileStalledRunningIssues();

    if (this.running.size === 0) {
      return;
    }

    const issueIds = [...this.running.keys()];
    const tracker = this.createTracker();

    let refreshed: Issue[];

    try {
      refreshed = await tracker.fetchIssueStatesByIds(issueIds);
    } catch (error) {
      this.logWarn("Running issue state refresh failed; keeping workers running", {
        reason: String(error),
      });
      return;
    }

    for (const issue of refreshed) {
      const issueId = issue.id;
      if (!issueId) {
        continue;
      }

      if (this.isTerminalState(issue.state)) {
        this.logInfo("Issue moved to terminal state; stopping run", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          state: issue.state,
        });
        this.terminateRunningIssue(issueId, true);
        continue;
      }

      if (!issue.assignedToWorker) {
        this.logInfo("Issue reassigned away; stopping run", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
        });
        this.terminateRunningIssue(issueId, false);
        continue;
      }

      if (!this.isActiveState(issue.state)) {
        this.logInfo("Issue moved to non-active state; stopping run", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          state: issue.state,
        });
        this.terminateRunningIssue(issueId, false);
        continue;
      }

      const runningEntry = this.running.get(issueId);
      if (runningEntry) {
        runningEntry.issue = issue;
      }
    }
  }

  private async reconcileStalledRunningIssues(): Promise<void> {
    const config = this.requireConfig();

    if (config.codex.stallTimeoutMs <= 0 || this.running.size === 0) {
      return;
    }

    const now = new Date();

    for (const [issueId, runningEntry] of this.running.entries()) {
      const activityAt = runningEntry.lastCodexTimestamp ?? runningEntry.startedAt;
      const elapsedMs = now.getTime() - activityAt.getTime();

      if (elapsedMs > config.codex.stallTimeoutMs) {
        this.logWarn("Issue stalled; restarting with backoff", {
          issue_id: issueId,
          issue_identifier: runningEntry.identifier,
          session_id: runningEntry.sessionId,
          elapsed_ms: elapsedMs,
        });

        const nextAttempt = runningEntry.retryAttempt > 0 ? runningEntry.retryAttempt + 1 : 1;

        this.terminateRunningIssue(issueId, false);
        this.scheduleIssueRetry(issueId, nextAttempt, {
          identifier: runningEntry.identifier,
          error: `stalled for ${elapsedMs}ms without codex activity`,
        });
      }
    }
  }

  private shouldDispatchIssue(issue: Issue): boolean {
    const issueId = issue.id;

    if (!issueId) {
      return false;
    }

    if (!isCandidateIssue(issue, this.requireConfig())) {
      return false;
    }

    if (isTodoBlockedByNonTerminal(issue, this.requireConfig())) {
      return false;
    }

    if (this.claimed.has(issueId) || this.running.has(issueId)) {
      return false;
    }

    if (this.availableSlots() <= 0) {
      return false;
    }

    if (!this.stateSlotsAvailable(issue.state)) {
      return false;
    }

    return true;
  }

  private stateSlotsAvailable(stateName: string | null): boolean {
    const normalized = normalizeIssueState(stateName ?? "");
    const limit =
      this.requireConfig().agent.maxConcurrentAgentsByState[normalized] ??
      this.requireConfig().agent.maxConcurrentAgents;

    let used = 0;
    for (const runningEntry of this.running.values()) {
      if (normalizeIssueState(runningEntry.issue.state ?? "") === normalized) {
        used += 1;
      }
    }

    return used < limit;
  }

  private availableSlots(): number {
    const maxConcurrent = this.requireConfig().agent.maxConcurrentAgents;
    return Math.max(maxConcurrent - this.running.size, 0);
  }

  private async dispatchIssue(issue: Issue, attempt: number | null): Promise<void> {
    const issueId = issue.id;
    if (!issueId) {
      return;
    }

    const tracker = this.createTracker();

    const refreshed = await tracker.fetchIssueStatesByIds([issueId]);
    const currentIssue = refreshed[0] ?? null;

    if (!currentIssue) {
      this.logInfo("Skipping dispatch; issue is no longer visible", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });
      return;
    }

    if (!isCandidateIssue(currentIssue, this.requireConfig())) {
      this.logInfo("Skipping dispatch; issue is no longer active", {
        issue_id: currentIssue.id,
        issue_identifier: currentIssue.identifier,
        state: currentIssue.state,
      });
      return;
    }

    if (isTodoBlockedByNonTerminal(currentIssue, this.requireConfig())) {
      this.logInfo("Skipping dispatch; todo issue has non-terminal blockers", {
        issue_id: currentIssue.id,
        issue_identifier: currentIssue.identifier,
      });
      return;
    }

    const abortController = new AbortController();

    const runningEntry: RunningEntry = {
      issue: currentIssue,
      issueId,
      identifier: currentIssue.identifier ?? issueId,
      abortController,
      retryAttempt: attempt ?? 0,
      startedAt: new Date(),
      sessionId: null,
      codexAppServerPid: null,
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      turnCount: 0,
    };

    this.running.set(issueId, runningEntry);
    this.claimed.add(issueId);

    const retry = this.retryAttempts.get(issueId);
    if (retry) {
      clearTimeout(retry.timer);
      this.retryAttempts.delete(issueId);
    }

    this.logInfo("Dispatching issue to agent", {
      issue_id: currentIssue.id,
      issue_identifier: currentIssue.identifier,
      attempt,
    });

    this.notifyUpdate();

    void this.runWorker(issueId, currentIssue, tracker, attempt, abortController.signal);
  }

  private async runWorker(
    issueId: string,
    issue: Issue,
    tracker: ReturnType<typeof createTracker>,
    attempt: number | null,
    signal: AbortSignal,
  ): Promise<void> {
    this.logInfo("Agent task started", {
      issue_id: issueId,
      issue_identifier: issue.identifier,
      attempt,
    });

    try {
      await this.agentRunner.run(issue, tracker, {
        attempt,
        signal,
        onMessage: (event) => this.handleCodexUpdate(issueId, event),
      });

      this.onWorkerExit(issueId, "normal");
    } catch (error) {
      if (signal.aborted) {
        this.onWorkerExit(issueId, "cancelled");
        return;
      }

      this.onWorkerExit(issueId, `error:${String(error)}`);
    }
  }

  private onWorkerExit(issueId: string, reason: "normal" | "cancelled" | string): void {
    const runningEntry = this.running.get(issueId);
    if (!runningEntry) {
      return;
    }

    this.running.delete(issueId);
    this.recordSessionCompletionTotals(runningEntry);

    if (reason === "normal") {
      this.completed.add(issueId);

      this.scheduleIssueRetry(issueId, 1, {
        identifier: runningEntry.identifier,
        delayType: "continuation",
      });

      this.logInfo("Agent task completed; scheduling continuation retry", {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.sessionId,
      });

      this.notifyUpdate();
      return;
    }

    if (reason === "cancelled") {
      this.logInfo("Agent task cancelled", {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
      });
      this.notifyUpdate();
      return;
    }

    const nextAttempt = runningEntry.retryAttempt > 0 ? runningEntry.retryAttempt + 1 : 1;

    this.scheduleIssueRetry(issueId, nextAttempt, {
      identifier: runningEntry.identifier,
      error: `agent exited: ${reason}`,
    });

    this.logWarn("Agent task exited with error; scheduling retry", {
      issue_id: issueId,
      issue_identifier: runningEntry.identifier,
      reason,
    });

    this.notifyUpdate();
  }

  private handleCodexUpdate(issueId: string, update: CodexEvent): void {
    const runningEntry = this.running.get(issueId);
    if (!runningEntry) {
      return;
    }

    runningEntry.lastCodexTimestamp = update.timestamp;
    runningEntry.lastCodexMessage = update.payload ?? update.raw ?? null;
    runningEntry.lastCodexEvent = update.event;

    if (typeof update.sessionId === "string" && update.sessionId.length > 0) {
      if (runningEntry.sessionId !== update.sessionId) {
        runningEntry.turnCount += 1;
      }

      runningEntry.sessionId = update.sessionId;
    }

    if (typeof update.codexAppServerPid === "string") {
      runningEntry.codexAppServerPid = update.codexAppServerPid;
    }

    const usage = extractAbsoluteUsage(update);
    if (usage) {
      const inputDelta = Math.max(0, usage.inputTokens - runningEntry.lastReportedInputTokens);
      const outputDelta = Math.max(0, usage.outputTokens - runningEntry.lastReportedOutputTokens);
      const totalDelta = Math.max(0, usage.totalTokens - runningEntry.lastReportedTotalTokens);

      runningEntry.codexInputTokens += inputDelta;
      runningEntry.codexOutputTokens += outputDelta;
      runningEntry.codexTotalTokens += totalDelta;

      runningEntry.lastReportedInputTokens = Math.max(
        runningEntry.lastReportedInputTokens,
        usage.inputTokens,
      );
      runningEntry.lastReportedOutputTokens = Math.max(
        runningEntry.lastReportedOutputTokens,
        usage.outputTokens,
      );
      runningEntry.lastReportedTotalTokens = Math.max(
        runningEntry.lastReportedTotalTokens,
        usage.totalTokens,
      );

      this.codexTotals.inputTokens += inputDelta;
      this.codexTotals.outputTokens += outputDelta;
      this.codexTotals.totalTokens += totalDelta;
    }

    if (update.rateLimits && typeof update.rateLimits === "object") {
      this.codexRateLimits = update.rateLimits;
    }

    if (update.event !== "notification") {
      this.logInfo("Codex event received", {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
        event: update.event,
        session_id: update.sessionId ?? runningEntry.sessionId,
        thread_id: update.threadId,
        turn_id: update.turnId,
      });
    }

    this.notifyUpdate();
  }

  private terminateRunningIssue(issueId: string, cleanupWorkspace: boolean): void {
    const runningEntry = this.running.get(issueId);

    if (!runningEntry) {
      this.claimed.delete(issueId);
      return;
    }

    this.recordSessionCompletionTotals(runningEntry);

    runningEntry.abortController.abort();
    this.running.delete(issueId);
    this.claimed.delete(issueId);

    const retry = this.retryAttempts.get(issueId);
    if (retry) {
      clearTimeout(retry.timer);
      this.retryAttempts.delete(issueId);
    }

    if (cleanupWorkspace) {
      void this.workspaceManager.removeIssueWorkspace(runningEntry.identifier);
    }
  }

  private scheduleIssueRetry(issueId: string, attempt: number, metadata: RetryMetadata): void {
    const previous = this.retryAttempts.get(issueId);
    if (previous) {
      clearTimeout(previous.timer);
    }

    const delay =
      metadata.delayType === "continuation" && attempt === 1
        ? CONTINUATION_RETRY_DELAY_MS
        : failureRetryDelay(attempt, this.requireConfig().agent.maxRetryBackoffMs);

    const dueAtMs = Date.now() + delay;

    const timer = setTimeout(() => {
      void this.handleRetryIssue(issueId);
    }, delay);

    this.retryAttempts.set(issueId, {
      issueId,
      identifier: metadata.identifier ?? previous?.identifier ?? issueId,
      attempt,
      dueAtMs,
      timer,
      error: metadata.error ?? previous?.error ?? null,
    });

    this.notifyUpdate();
  }

  private async handleRetryIssue(issueId: string): Promise<void> {
    const retry = this.retryAttempts.get(issueId);
    if (!retry) {
      return;
    }

    this.retryAttempts.delete(issueId);

    const tracker = this.createTracker();
    let candidates: Issue[];

    try {
      candidates = await tracker.fetchCandidateIssues();
    } catch (error) {
      this.scheduleIssueRetry(issueId, retry.attempt + 1, {
        identifier: retry.identifier,
        error: `retry poll failed: ${String(error)}`,
      });
      return;
    }

    const issue = candidates.find((candidate) => candidate.id === issueId) ?? null;

    if (!issue) {
      this.claimed.delete(issueId);
      this.notifyUpdate();
      return;
    }

    if (this.isTerminalState(issue.state)) {
      await this.workspaceManager.removeIssueWorkspace(issue.identifier);
      this.claimed.delete(issueId);
      this.notifyUpdate();
      return;
    }

    if (!isCandidateIssue(issue, this.requireConfig()) || isTodoBlockedByNonTerminal(issue, this.requireConfig())) {
      this.claimed.delete(issueId);
      this.notifyUpdate();
      return;
    }

    if (this.availableSlots() <= 0 || !this.stateSlotsAvailable(issue.state)) {
      this.scheduleIssueRetry(issueId, retry.attempt + 1, {
        identifier: issue.identifier ?? retry.identifier,
        error: "no available orchestrator slots",
      });
      return;
    }

    await this.dispatchIssue(issue, retry.attempt);
  }

  private async runStartupTerminalCleanup(): Promise<void> {
    const tracker = this.createTracker();

    try {
      const terminalIssues = await tracker.fetchIssuesByStates(this.requireConfig().tracker.terminalStates);

      await Promise.all(
        terminalIssues.map((issue) => this.workspaceManager.removeIssueWorkspace(issue.identifier)),
      );
    } catch (error) {
      this.logWarn("Startup terminal workspace cleanup failed", {
        reason: String(error),
      });
    }
  }

  private async logTrackerConnectionStatus(): Promise<void> {
    const config = this.requireConfig();

    if (config.tracker.kind !== "linear") {
      this.logInfo("Tracker connection check skipped", {
        tracker_kind: config.tracker.kind,
      });
      return;
    }

    const client = new LinearClient({
      endpoint: config.tracker.endpoint,
      apiKey: config.tracker.apiKey,
      projectSlug: config.tracker.projectSlug,
      teamKey: config.tracker.teamKey,
      teamId: config.tracker.teamId,
      assignee: config.tracker.assignee,
    });

    try {
      const payload = await client.graphql(
        `
query SymphonyLinearConnectionStatus {
  viewer { id }
}
`,
        {},
      );

      const viewerId = maybeString(asRecord(asRecord(payload.data).viewer).id);

      this.logInfo("Linear connection check succeeded", {
        tracker_kind: "linear",
        endpoint: config.tracker.endpoint,
        project_slug: config.tracker.projectSlug,
        team_key: config.tracker.teamKey,
        team_id: config.tracker.teamId,
        assignee: config.tracker.assignee,
        viewer_id: viewerId,
      });
    } catch (error) {
      this.logWarn("Linear connection check failed", {
        tracker_kind: "linear",
        endpoint: config.tracker.endpoint,
        project_slug: config.tracker.projectSlug,
        team_key: config.tracker.teamKey,
        team_id: config.tracker.teamId,
        assignee: config.tracker.assignee,
        has_api_key: Boolean(config.tracker.apiKey),
        reason: String(error),
      });
    }
  }

  private createTracker() {
    return createTracker(this.requireConfig(), this.trackerOptions);
  }

  private refreshRuntimeConfig(): void {
    this.currentConfig = this.resolveCurrentConfig();
  }

  private resolveCurrentConfig(): EffectiveConfig {
    const workflow = this.workflowStore.current();
    return resolveConfig(
      workflow,
      Bun.env,
      this.serverPortOverride,
      this.workflowStore.getWorkflowPath(),
    );
  }

  private requireConfig(): EffectiveConfig {
    if (!this.currentConfig) {
      throw new Error("orchestrator_not_started");
    }

    return this.currentConfig;
  }

  private isTerminalState(stateName: string | null): boolean {
    const normalized = normalizeIssueState(stateName ?? "");
    return this.requireConfig().tracker.terminalStates
      .map((state) => normalizeIssueState(state))
      .includes(normalized);
  }

  private isActiveState(stateName: string | null): boolean {
    const normalized = normalizeIssueState(stateName ?? "");
    return this.requireConfig().tracker.activeStates
      .map((state) => normalizeIssueState(state))
      .includes(normalized);
  }

  private recordSessionCompletionTotals(runningEntry: RunningEntry): void {
    this.codexTotals.secondsRunning += runningSeconds(runningEntry.startedAt, new Date());
  }

  private workflowLogContext(context: Record<string, unknown> = {}): Record<string, unknown> {
    const config = this.currentConfig;
    return {
      workflow_id: config?.workflowId ?? this.inferWorkflowId(),
      workflow_path: config?.workflowPath ?? this.workflowStore.getWorkflowPath(),
      ...context,
    };
  }

  private inferWorkflowId(): string {
    const path = this.workflowStore.getWorkflowPath();
    const fileName = path.split(/[\\/]/).pop() ?? "workflow";
    const withoutExt = fileName.replace(/\.[^.]+$/, "").trim();
    return withoutExt.length > 0 ? withoutExt : "workflow";
  }

  private logInfo(message: string, context: Record<string, unknown> = {}): void {
    logger.info(message, this.workflowLogContext(context));
  }

  private logWarn(message: string, context: Record<string, unknown> = {}): void {
    logger.warn(message, this.workflowLogContext(context));
  }

  private logError(message: string, context: Record<string, unknown> = {}): void {
    logger.error(message, this.workflowLogContext(context));
  }

  private logDebug(message: string, context: Record<string, unknown> = {}): void {
    logger.debug(message, this.workflowLogContext(context));
  }
}

const runningSeconds = (startedAt: Date, now: Date): number => {
  const diff = (now.getTime() - startedAt.getTime()) / 1_000;
  return diff > 0 ? diff : 0;
};

const failureRetryDelay = (attempt: number, maxRetryBackoffMs: number): number => {
  const power = Math.min(Math.max(attempt - 1, 0), 10);
  return Math.min(FAILURE_RETRY_BASE_MS * 2 ** power, maxRetryBackoffMs);
};

const isCandidateIssue = (issue: Issue, config: EffectiveConfig): boolean => {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return false;
  }

  if (!issue.assignedToWorker) {
    return false;
  }

  const normalizedState = normalizeIssueState(issue.state);
  const activeStates = new Set(config.tracker.activeStates.map((state) => normalizeIssueState(state)));
  const terminalStates = new Set(
    config.tracker.terminalStates.map((state) => normalizeIssueState(state)),
  );

  return activeStates.has(normalizedState) && !terminalStates.has(normalizedState);
};

const isTodoBlockedByNonTerminal = (issue: Issue, config: EffectiveConfig): boolean => {
  if (normalizeIssueState(issue.state ?? "") !== "todo") {
    return false;
  }

  const terminalStates = new Set(
    config.tracker.terminalStates.map((state) => normalizeIssueState(state)),
  );

  return issue.blockedBy.some((blocker) => {
    if (!blocker.state) {
      return true;
    }

    return !terminalStates.has(normalizeIssueState(blocker.state));
  });
};

const sortIssuesForDispatch = (issues: Issue[]): Issue[] => {
  return [...issues].sort((a, b) => {
    const priorityA = isPriority(a.priority) ? a.priority : 5;
    const priorityB = isPriority(b.priority) ? b.priority : 5;

    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    const createdA = a.createdAt ? a.createdAt.getTime() : Number.MAX_SAFE_INTEGER;
    const createdB = b.createdAt ? b.createdAt.getTime() : Number.MAX_SAFE_INTEGER;

    if (createdA !== createdB) {
      return createdA - createdB;
    }

    const idA = a.identifier ?? a.id ?? "";
    const idB = b.identifier ?? b.id ?? "";

    return idA.localeCompare(idB);
  });
};

const isPriority = (priority: number | null): priority is number => {
  return typeof priority === "number" && Number.isInteger(priority) && priority >= 1 && priority <= 4;
};

const extractAbsoluteUsage = (
  update: CodexEvent,
): { inputTokens: number; outputTokens: number; totalTokens: number } | null => {
  const usagePayload =
    findUsageMap(update.usage) ??
    findUsageMap(update.payload) ??
    findUsageMap(update.raw) ??
    null;

  if (!usagePayload) {
    return null;
  }

  const inputTokens =
    getInteger(usagePayload, ["input_tokens", "prompt_tokens", "inputTokens", "promptTokens"]) ?? 0;
  const outputTokens =
    getInteger(usagePayload, [
      "output_tokens",
      "completion_tokens",
      "outputTokens",
      "completionTokens",
    ]) ?? 0;
  const totalTokens = getInteger(usagePayload, ["total_tokens", "total", "totalTokens"]);

  const derivedTotal = totalTokens ?? inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens: derivedTotal,
  };
};

const findUsageMap = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Record<string, unknown>;

  const direct = asRecord(payload.total_token_usage) || asRecord(payload.usage);
  if (Object.keys(direct).length > 0) {
    return direct;
  }

  const candidatePaths = [
    ["params", "msg", "payload", "info", "total_token_usage"],
    ["params", "msg", "info", "total_token_usage"],
    ["params", "tokenUsage", "total"],
    ["tokenUsage", "total"],
  ];

  for (const path of candidatePaths) {
    const resolved = mapAtPath(payload, path);
    if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
      return resolved as Record<string, unknown>;
    }
  }

  return null;
};

const mapAtPath = (value: Record<string, unknown>, path: string[]): unknown => {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
};

const getInteger = (payload: Record<string, unknown>, keys: string[]): number | null => {
  for (const key of keys) {
    const value = payload[key];
    const parsed = integerLike(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
};

const integerLike = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
};

const maybeString = (value: unknown): string | null => {
  return typeof value === "string" && value.length > 0 ? value : null;
};

export const orchestratorTestUtils = {
  runningSeconds,
  failureRetryDelay,
  isCandidateIssue,
  isTodoBlockedByNonTerminal,
  sortIssuesForDispatch,
  extractAbsoluteUsage,
};
