import type { RuntimeSnapshot } from "../types";

export const statePayload = (snapshot: RuntimeSnapshot): Record<string, unknown> => {
  return {
    generated_at: new Date().toISOString(),
    workflow: {
      id: snapshot.workflowId ?? null,
      path: snapshot.workflowPath ?? null,
    },
    counts: {
      running: snapshot.running.length,
      retrying: snapshot.retrying.length,
    },
    running: snapshot.running.map((entry) => ({
      workflow_id: snapshot.workflowId ?? null,
      issue_id: entry.issueId,
      issue_identifier: entry.identifier,
      issue_title: entry.issue.title,
      state: entry.state,
      session_id: entry.sessionId,
      turn_count: entry.turnCount,
      last_event: entry.lastCodexEvent,
      last_message: summarizeMessage(entry.lastCodexMessage),
      started_at: iso(entry.startedAt),
      last_event_at: iso(entry.lastCodexTimestamp),
      tokens: {
        input_tokens: entry.codexInputTokens,
        output_tokens: entry.codexOutputTokens,
        total_tokens: entry.codexTotalTokens,
      },
    })),
    retrying: snapshot.retrying.map((entry) => ({
      workflow_id: snapshot.workflowId ?? null,
      issue_id: entry.issueId,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: dueAtIso(entry.dueInMs),
      error: entry.error,
    })),
    polling: {
      checking: snapshot.polling.checking,
      next_poll_in_ms: snapshot.polling.nextPollInMs,
      poll_interval_ms: snapshot.polling.pollIntervalMs,
    },
    codex_totals: {
      input_tokens: snapshot.codexTotals.inputTokens,
      output_tokens: snapshot.codexTotals.outputTokens,
      total_tokens: snapshot.codexTotals.totalTokens,
      seconds_running: snapshot.codexTotals.secondsRunning,
    },
    rate_limits: snapshot.rateLimits,
  };
};

export const issuePayload = (
  issueIdentifier: string,
  snapshot: RuntimeSnapshot,
  workspaceRoot: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false } => {
  const running = snapshot.running.find((entry) => entry.identifier === issueIdentifier) ?? null;
  const retry = snapshot.retrying.find((entry) => entry.identifier === issueIdentifier) ?? null;

  if (!running && !retry) {
    return { ok: false };
  }

  const retryAttempt = retry?.attempt ?? 0;

  return {
    ok: true,
    payload: {
      workflow: {
        id: snapshot.workflowId ?? null,
        path: snapshot.workflowPath ?? null,
      },
      issue_identifier: issueIdentifier,
      issue_id: running?.issueId ?? retry?.issueId ?? null,
      status: running ? "running" : "retrying",
      workspace: {
        path: `${workspaceRoot.replace(/[\\/]$/, "")}/${issueIdentifier}`,
      },
      attempts: {
        restart_count: Math.max(retryAttempt - 1, 0),
        current_retry_attempt: retryAttempt,
      },
      running: running
        ? {
            session_id: running.sessionId,
            turn_count: running.turnCount,
            issue_title: running.issue.title,
            state: running.state,
            started_at: iso(running.startedAt),
            last_event: running.lastCodexEvent,
            last_message: summarizeMessage(running.lastCodexMessage),
            last_event_at: iso(running.lastCodexTimestamp),
            tokens: {
              input_tokens: running.codexInputTokens,
              output_tokens: running.codexOutputTokens,
              total_tokens: running.codexTotalTokens,
            },
          }
        : null,
      retry: retry
        ? {
            attempt: retry.attempt,
            due_at: dueAtIso(retry.dueInMs),
            error: retry.error,
          }
        : null,
      logs: {
        codex_session_logs: [],
      },
      recent_events:
        running && running.lastCodexTimestamp
          ? [
              {
                at: iso(running.lastCodexTimestamp),
                event: running.lastCodexEvent,
                message: summarizeMessage(running.lastCodexMessage),
              },
            ]
          : [],
      last_error: retry?.error ?? null,
      tracked: {},
    },
  };
};

export const refreshPayload = (
  queued: true,
  coalesced: boolean,
  requestedAt: Date,
  workflowId?: string | null,
  workflowPath?: string | null,
): Record<string, unknown> => {
  return {
    queued,
    coalesced,
    requested_at: requestedAt.toISOString(),
    operations: ["poll", "reconcile"],
    workflow: {
      id: workflowId ?? null,
      path: workflowPath ?? null,
    },
  };
};

const summarizeMessage = (message: unknown): string | null => {
  if (message === null || message === undefined) {
    return null;
  }

  if (typeof message === "string") {
    return message;
  }

  if (typeof message === "object") {
    const payload = message as Record<string, unknown>;

    if (typeof payload.message === "string") {
      return payload.message;
    }

    if (typeof payload.content === "string") {
      return payload.content;
    }
  }

  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
};

const iso = (date: Date | null): string | null => {
  if (!date) {
    return null;
  }

  return date.toISOString();
};

const dueAtIso = (dueInMs: number): string => {
  return new Date(Date.now() + dueInMs).toISOString();
};
