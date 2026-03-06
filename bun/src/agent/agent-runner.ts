import type { Issue, TrackerAdapter, WorkerRunOptions } from "../types";
import { buildPrompt } from "../prompt/prompt-builder";
import { WorkspaceManager } from "../workspace/workspace-manager";
import { AppServerClient } from "../codex/app-server";
import { logger } from "../utils/logger";
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

    logger.info("Agent runner started", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt: options.attempt,
    });

    const workspace = await this.workspaceManager.createForIssue(issue);
    logger.info("Workspace prepared for issue", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      workspace,
    });

    await this.workspaceManager.runBeforeRunHook(workspace, issue);
    logger.info("before_run hook completed", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      workspace,
    });

    const session = await this.appServerClient.startSession(workspace);
    logger.info("Codex app-server session started", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      workspace,
      thread_id: session.threadId,
      codex_app_server_pid: session.codexAppServerPid,
    });

    try {
      const maxTurns = this.configProvider().agent.maxTurns;
      let turnNumber = 1;
      let currentIssue = issue;

      while (turnNumber <= maxTurns) {
        this.throwIfAborted(options.signal);
        logger.info("Starting codex turn", {
          issue_id: currentIssue.id,
          issue_identifier: currentIssue.identifier,
          turn_number: turnNumber,
          max_turns: maxTurns,
          thread_id: session.threadId,
        });

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

        const turnResult = await this.appServerClient.runTurn(session, prompt, currentIssue, runTurnOptions);
        logger.info("Codex turn finished", {
          issue_id: currentIssue.id,
          issue_identifier: currentIssue.identifier,
          turn_number: turnNumber,
          session_id: turnResult.sessionId,
          thread_id: turnResult.threadId,
          turn_id: turnResult.turnId,
        });

        const issueId = currentIssue.id;
        if (!issueId) {
          logger.warn("Stopping run because issue id is missing after turn", {
            issue_identifier: currentIssue.identifier,
            turn_number: turnNumber,
          });
          break;
        }

        const refreshed = await tracker.fetchIssueStatesByIds([issueId]);
        currentIssue = refreshed[0] ?? currentIssue;

        if (!this.isActiveState(currentIssue.state)) {
          logger.info("Stopping run because issue is no longer active", {
            issue_id: currentIssue.id,
            issue_identifier: currentIssue.identifier,
            state: currentIssue.state,
            turn_number: turnNumber,
          });
          break;
        }

        if (turnNumber >= maxTurns) {
          logger.info("Stopping run because max turns reached", {
            issue_id: currentIssue.id,
            issue_identifier: currentIssue.identifier,
            max_turns: maxTurns,
          });
          break;
        }

        turnNumber += 1;
      }
    } finally {
      logger.info("Stopping codex app-server session", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        thread_id: session.threadId,
      });
      this.appServerClient.stopSession(session);
      await this.workspaceManager.runAfterRunHook(workspace, issue);
      logger.info("after_run hook completed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        workspace,
      });
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
