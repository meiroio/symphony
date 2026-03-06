import { afterEach, describe, expect, test } from "bun:test";

import type { EffectiveConfig, RuntimeSnapshot } from "../src/types";
import { HttpServer } from "../src/http/server";
import type { Orchestrator } from "../src/orchestrator/orchestrator";

interface FakeOrchestratorShape {
  snapshot: () => RuntimeSnapshot;
  requestRefresh: () => {
    queued: true;
    coalesced: boolean;
    requestedAt: Date;
    operations: ["poll", "reconcile"];
  };
}

const activeServers: HttpServer[] = [];

afterEach(() => {
  for (const server of activeServers.splice(0, activeServers.length)) {
    server.stop();
  }
});

describe("http server", () => {
  test("state endpoint preserves payload contract", async () => {
    const snapshot = staticSnapshot();
    const { baseUrl } = startServer(snapshot);

    const response = await fetch(`${baseUrl}/api/v1/state`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as Record<string, unknown>;

    expect(payload.generated_at).toBeString();
    expect(payload.counts).toEqual({ running: 1, retrying: 1 });

    const runningList = payload.running as Array<Record<string, unknown>>;
    expect(runningList.length).toBe(1);
    const running = runningList[0]!;
    expect(running.issue_id).toBe("issue-http");
    expect(running.issue_identifier).toBe("MT-HTTP");
    expect(running.state).toBe("In Progress");
    expect(running.session_id).toBe("thread-http");
    expect(running.turn_count).toBe(7);
    expect(running.last_event).toBe("notification");

    const retryingList = payload.retrying as Array<Record<string, unknown>>;
    expect(retryingList.length).toBe(1);
    const retrying = retryingList[0]!;
    expect(retrying.issue_id).toBe("issue-retry");
    expect(retrying.issue_identifier).toBe("MT-RETRY");
    expect(retrying.attempt).toBe(2);
    expect(retrying.error).toBe("boom");

    expect(payload.codex_totals).toEqual({
      input_tokens: 4,
      output_tokens: 8,
      total_tokens: 12,
      seconds_running: 42.5,
    });

    expect(payload.rate_limits).toEqual({
      primary: { remaining: 11 },
    });
  });

  test("issue endpoint preserves running and retrying contracts", async () => {
    const snapshot = staticSnapshot();
    const { baseUrl } = startServer(snapshot);

    const runningResponse = await fetch(`${baseUrl}/api/v1/MT-HTTP`);
    expect(runningResponse.status).toBe(200);
    const runningPayload = (await runningResponse.json()) as Record<string, unknown>;

    expect(runningPayload.issue_identifier).toBe("MT-HTTP");
    expect(runningPayload.issue_id).toBe("issue-http");
    expect(runningPayload.status).toBe("running");
    expect(runningPayload.workspace).toEqual({ path: "/tmp/symphony-http/MT-HTTP" });
    expect(runningPayload.attempts).toEqual({ restart_count: 0, current_retry_attempt: 0 });

    const running = runningPayload.running as Record<string, unknown>;
    expect(running.session_id).toBe("thread-http");
    expect(running.turn_count).toBe(7);
    expect(running.state).toBe("In Progress");

    expect(runningPayload.retry).toBeNull();
    expect(runningPayload.logs).toEqual({ codex_session_logs: [] });
    expect(runningPayload.last_error).toBeNull();

    const retryingResponse = await fetch(`${baseUrl}/api/v1/MT-RETRY`);
    expect(retryingResponse.status).toBe(200);
    const retryingPayload = (await retryingResponse.json()) as Record<string, unknown>;

    expect(retryingPayload.issue_identifier).toBe("MT-RETRY");
    expect(retryingPayload.status).toBe("retrying");

    const retry = retryingPayload.retry as Record<string, unknown>;
    expect(retry.attempt).toBe(2);
    expect(retry.error).toBe("boom");

    const missingResponse = await fetch(`${baseUrl}/api/v1/MT-MISSING`);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      error: {
        code: "issue_not_found",
        message: "Issue not found",
      },
    });
  });

  test("refresh and method/not-found responses preserve contracts", async () => {
    const { baseUrl } = startServer(staticSnapshot());

    const refreshResponse = await fetch(`${baseUrl}/api/v1/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(refreshResponse.status).toBe(202);
    const refreshPayload = (await refreshResponse.json()) as Record<string, unknown>;

    expect(refreshPayload.queued).toBeTrue();
    expect(refreshPayload.coalesced).toBeFalse();
    expect(refreshPayload.operations).toEqual(["poll", "reconcile"]);
    expect(typeof refreshPayload.requested_at).toBe("string");

    const methodCases: Array<{ method: string; path: string }> = [
      { method: "POST", path: "/api/v1/state" },
      { method: "GET", path: "/api/v1/refresh" },
      { method: "POST", path: "/" },
      { method: "POST", path: "/api/v1/MT-HTTP" },
    ];

    for (const testCase of methodCases) {
      const response = await fetch(`${baseUrl}${testCase.path}`, {
        method: testCase.method,
      });

      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({
        error: {
          code: "method_not_allowed",
          message: "Method not allowed",
        },
      });
    }

    const notFound = await fetch(`${baseUrl}/unknown`);
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  });

  test("root renders dashboard html", async () => {
    const { baseUrl } = startServer(staticSnapshot());

    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);

    const contentType = response.headers.get("content-type");
    expect(contentType).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("Symphony Operations Dashboard");
    expect(html).toContain("/api/v1/state");
    expect(html).toContain("/api/v1/refresh");
  });
});

const startServer = (snapshot: RuntimeSnapshot): { baseUrl: string } => {
  const fakeOrchestrator: FakeOrchestratorShape = {
    snapshot: () => snapshot,
    requestRefresh: () => ({
      queued: true,
      coalesced: false,
      requestedAt: new Date("2026-02-24T20:15:30.000Z"),
      operations: ["poll", "reconcile"],
    }),
  };

  const config: EffectiveConfig = {
    tracker: {
      kind: "memory",
      endpoint: "https://api.linear.app/graphql",
      apiKey: null,
      projectSlug: null,
      assignee: null,
      activeStates: ["Todo"],
      terminalStates: ["Done"],
    },
    polling: { intervalMs: 1000 },
    workspace: { root: "/tmp/symphony-http" },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 1000,
    },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 1,
      maxRetryBackoffMs: 1000,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 1000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 1000,
    },
    server: {
      port: null,
      host: "127.0.0.1",
    },
    promptTemplate: "Prompt",
  };

  const server = new HttpServer({
    orchestrator: fakeOrchestrator as unknown as Orchestrator,
    configProvider: () => config,
  });

  const port = server.start(0, "127.0.0.1");
  activeServers.push(server);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
  };
};

const staticSnapshot = (): RuntimeSnapshot => {
  return {
    running: [
      {
        issueId: "issue-http",
        identifier: "MT-HTTP",
        state: "In Progress",
        sessionId: "thread-http",
        codexAppServerPid: null,
        codexInputTokens: 4,
        codexOutputTokens: 8,
        codexTotalTokens: 12,
        turnCount: 7,
        startedAt: new Date("2026-02-24T20:10:12.000Z"),
        lastCodexTimestamp: null,
        lastCodexMessage: "rendered",
        lastCodexEvent: "notification",
        runtimeSeconds: 33,
      },
    ],
    retrying: [
      {
        issueId: "issue-retry",
        identifier: "MT-RETRY",
        attempt: 2,
        dueInMs: 2_000,
        error: "boom",
      },
    ],
    codexTotals: {
      inputTokens: 4,
      outputTokens: 8,
      totalTokens: 12,
      secondsRunning: 42.5,
    },
    rateLimits: {
      primary: { remaining: 11 },
    },
    polling: {
      checking: false,
      nextPollInMs: 1_000,
      pollIntervalMs: 1_000,
    },
  };
};
