import type { Issue, TrackerAdapter, WorkerRunOptions } from "../types";
import { buildPrompt } from "../prompt/prompt-builder";
import { WorkspaceManager } from "../workspace/workspace-manager";
import { AppServerClient } from "../codex/app-server";
import { normalizeIssueState } from "../utils/normalize";

export class AgentRunner {
  private readonly workspaceManager: WorkspaceManager;
  private readonly appServerClient: AppServerClient;
  private readonly configProvider: () => import("../types").EffectiveConfig;

  constructor(
    configProvider: () => import("../types").EffectiveConfig,
    workspaceManager: WorkspaceManager,
    appServerClient: AppServerClient,
  ) {
    this.configProvider = configProvider;
    this.workspaceManager = workspaceManager;
    this.appServerClient = appServerClient;
  }

  async run(issue: Issue, tracker: TrackerAdapter, options: WorkerRunOptions): Promise<void> {
    this.throwIfAborted(options.signal);

    const workspace = await this.workspaceManager.createForIssue(issue);
    await this.workspaceManager.runBeforeRunHook(workspace, issue);

    const session = await this.appServerClient.startSession(workspace);

    try {
      const maxTurns = this.configProvider().agent.maxTurns;
      let turnNumber = 1;
      let currentIssue = issue;

      while (turnNumber <= maxTurns) {
        this.throwIfAborted(options.signal);

        const prompt =
          turnNumber === 1
            ? await buildPrompt(this.configProvider().promptTemplate, currentIssue, options.attempt)
            : continuationPrompt(turnNumber, maxTurns);

        const runTurnOptions =
          options.onMessage
            ? {
                onMessage: options.onMessage,
              }
            : {};

        await this.appServerClient.runTurn(session, prompt, currentIssue, runTurnOptions);

        const issueId = currentIssue.id;
        if (!issueId) {
          break;
        }

        const refreshed = await tracker.fetchIssueStatesByIds([issueId]);
        currentIssue = refreshed[0] ?? currentIssue;

        if (!this.isActiveState(currentIssue.state)) {
          break;
        }

        if (turnNumber >= maxTurns) {
          break;
        }

        turnNumber += 1;
      }
    } finally {
      this.appServerClient.stopSession(session);
      await this.workspaceManager.runAfterRunHook(workspace, issue);
    }
  }

  private isActiveState(stateName: string | null): boolean {
    if (!stateName) {
      return false;
    }

    const normalizedState = normalizeIssueState(stateName);
    const activeStates = this.configProvider().tracker.activeStates.map((state) =>
      normalizeIssueState(state),
    );

    return activeStates.includes(normalizedState);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error("run_aborted");
    }
  }
}

const continuationPrompt = (turnNumber: number, maxTurns: number): string => {
  return `Continuation guidance:

- The previous Codex turn completed normally, but the issue is still in an active state.
- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.
- Resume from the current workspace state instead of restarting from scratch.
- The original task instructions are already in thread history, so do not restate them.
- Focus on remaining issue work and do not end early unless you are truly blocked.`;
};
