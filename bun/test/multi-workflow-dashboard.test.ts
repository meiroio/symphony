import { afterEach, describe, expect, test } from "bun:test";

import { MultiWorkflowDashboard } from "../src/http/multi-workflow-dashboard";
import type { RuntimeSnapshot } from "../src/types";

const activeDashboards: MultiWorkflowDashboard[] = [];
const activeWebhookServers: Array<Bun.Server<unknown>> = [];

afterEach(() => {
  for (const dashboard of activeDashboards.splice(0, activeDashboards.length)) {
    dashboard.stop();
  }

  for (const server of activeWebhookServers.splice(0, activeWebhookServers.length)) {
    server.stop(true);
  }
});

describe("multi workflow dashboard", () => {
  test("exposes workflow list, attention metadata, and studio shell", async () => {
    const firstSnapshot = snapshot({
      workflowId: "linear-team-review",
      workflowPath: "/tmp/workflows/review.md",
      running: [
        {
          issueId: "issue-stale",
          identifier: "PIP-36",
          issueTitle: "Export and import of complete instance configuration",
          state: "In Review",
          sessionId: "session-stale",
          codexAppServerPid: null,
          codexInputTokens: 5,
          codexOutputTokens: 8,
          codexTotalTokens: 13,
          turnCount: 4,
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          lastCodexTimestamp: new Date("2026-01-01T00:01:00.000Z"),
          lastCodexMessage: "waiting",
          lastCodexEvent: "notification",
          runtimeSeconds: 120,
        },
      ],
      retrying: [],
      polling: {
        checking: false,
        nextPollInMs: 5_000,
        pollIntervalMs: 30_000,
      },
    });

    const secondSnapshot = snapshot({
      workflowId: "linear-timetracking-factory",
      workflowPath: "/tmp/workflows/factory.md",
      running: [],
      retrying: [
        {
          issueId: "issue-retry",
          identifier: "TIM-7",
          attempt: 2,
          dueInMs: 2_000,
          error: "failed to clone",
        },
      ],
      polling: {
        checking: true,
        nextPollInMs: 1_000,
        pollIntervalMs: 15_000,
      },
    });

    const dashboard = new MultiWorkflowDashboard({
      entriesProvider: () => [
        {
          key: "review",
          workflowId: "linear-team-review",
          workflowPath: "/tmp/workflows/review.md",
          httpPort: 8791,
          webhookPath: "/api/v1/webhooks/linear",
          tracker: {
            kind: "linear",
            scopeType: "team",
            scopeLabel: "PIP",
          },
          snapshot: firstSnapshot,
        },
        {
          key: "factory",
          workflowId: "linear-timetracking-factory",
          workflowPath: "/tmp/workflows/factory.md",
          httpPort: 8792,
          webhookPath: "/api/v1/webhooks/linear",
          tracker: {
            kind: "linear",
            scopeType: "project",
            scopeLabel: "symphony-2f9fcdc281e6",
          },
          snapshot: secondSnapshot,
        },
      ],
      refreshByKey: () => ({
        key: "review",
        workflowId: "linear-team-review",
        workflowPath: "/tmp/workflows/review.md",
        coalesced: false,
        requestedAt: new Date("2026-03-07T18:00:00.000Z"),
      }),
      refreshAll: () => [
        {
          key: "review",
          workflowId: "linear-team-review",
          workflowPath: "/tmp/workflows/review.md",
          coalesced: false,
          requestedAt: new Date("2026-03-07T18:00:00.000Z"),
        },
      ],
    });

    const port = dashboard.start(0, "127.0.0.1");
    activeDashboards.push(dashboard);

    const baseUrl = `http://127.0.0.1:${port}`;

    const workflowsResponse = await fetch(`${baseUrl}/api/v1/workflows`);
    expect(workflowsResponse.status).toBe(200);
    const workflowsPayload = (await workflowsResponse.json()) as Record<string, unknown>;

    expect(workflowsPayload.counts).toEqual({
      workflows: 2,
      running: 1,
      retrying: 1,
    });

    const workflows = workflowsPayload.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(2);

    const review = workflows.find((entry) => entry.key === "review") as Record<string, unknown>;
    expect(review.workflow).toEqual({
      id: "linear-team-review",
      path: "/tmp/workflows/review.md",
    });
    expect(review.tracker).toEqual({
      kind: "linear",
      scope_type: "team",
      scope_label: "PIP",
    });
    expect(review.attention).toEqual({
      stale_agents: 1,
      total: 1,
    });

    const detailResponse = await fetch(`${baseUrl}/api/v1/workflows/review`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as Record<string, unknown>;
    expect(detailPayload.http_port).toBe(8791);
    expect(detailPayload.tracker).toEqual({
      kind: "linear",
      scope_type: "team",
      scope_label: "PIP",
    });
    expect(detailPayload.polling).toEqual({
      checking: false,
      next_poll_in_ms: 5_000,
      poll_interval_ms: 30_000,
    });

    const htmlResponse = await fetch(`${baseUrl}/`);
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain("Workflow Studio");
    expect(html).toContain("Operator board for autonomous Linear workflows");
    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('href="/apple-touch-icon.png"');
    expect(html).toContain('href="/site.webmanifest"');
    expect(html).toContain("Reading the board");
    expect(html).toContain("Running workflows");
    expect(html).toContain("Live updates: On");

    const faviconResponse = await fetch(`${baseUrl}/favicon.svg`);
    expect(faviconResponse.status).toBe(200);
    expect(faviconResponse.headers.get("content-type")).toContain("image/svg+xml");
    expect(await faviconResponse.text()).toContain("<svg");

    const iconResponse = await fetch(`${baseUrl}/icon-192.png`);
    expect(iconResponse.status).toBe(200);
    expect(iconResponse.headers.get("content-type")).toContain("image/png");

    const manifestResponse = await fetch(`${baseUrl}/site.webmanifest`);
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get("content-type")).toContain("application/manifest+json");
    const manifest = (await manifestResponse.json()) as Record<string, unknown>;
    expect(manifest.short_name).toBe("Symphony");
  });

  test("fans out legacy linear webhook path to all matching workflows", async () => {
    const reviewRequests: Array<Record<string, string | null>> = [];
    const factoryRequests: Array<Record<string, string | null>> = [];

    const reviewServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        reviewRequests.push({
          path: new URL(request.url).pathname,
          body: await request.text(),
          contentType: request.headers.get("content-type"),
          linearSignature: request.headers.get("linear-signature"),
          xLinearSignature: request.headers.get("x-linear-signature"),
          userAgent: request.headers.get("user-agent"),
        });

        return Response.json({ accepted: true, workflow: "review" }, { status: 202 });
      },
    });
    activeWebhookServers.push(reviewServer);

    const factoryServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        factoryRequests.push({
          path: new URL(request.url).pathname,
          body: await request.text(),
          contentType: request.headers.get("content-type"),
          linearSignature: request.headers.get("linear-signature"),
          xLinearSignature: request.headers.get("x-linear-signature"),
          userAgent: request.headers.get("user-agent"),
        });

        return Response.json({ accepted: true, workflow: "factory" }, { status: 202 });
      },
    });
    activeWebhookServers.push(factoryServer);

    const dashboard = new MultiWorkflowDashboard({
      entriesProvider: () => [
        {
          key: "review",
          workflowId: "linear-team-review",
          workflowPath: "/tmp/workflows/review.md",
          httpPort: reviewServer.port ?? null,
          webhookPath: "/api/v1/webhooks/linear",
          tracker: {
            kind: "linear",
            scopeType: "team",
            scopeLabel: "PIP",
          },
          snapshot: snapshot({ workflowId: "linear-team-review" }),
        },
        {
          key: "factory",
          workflowId: "linear-timetracking-factory",
          workflowPath: "/tmp/workflows/factory.md",
          httpPort: factoryServer.port ?? null,
          webhookPath: "/api/v1/webhooks/linear",
          tracker: {
            kind: "linear",
            scopeType: "project",
            scopeLabel: "symphony-2f9fcdc281e6",
          },
          snapshot: snapshot({ workflowId: "linear-timetracking-factory" }),
        },
      ],
      refreshByKey: () => null,
      refreshAll: () => [],
    });

    const port = dashboard.start(0, "127.0.0.1");
    activeDashboards.push(dashboard);

    const body = JSON.stringify({
      action: "update",
      type: "Issue",
      data: { id: "issue-1" },
    });

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": "signature-a",
        "x-linear-signature": "signature-b",
        "user-agent": "Linear-Test",
      },
      body,
    });

    expect(response.status).toBe(202);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      queued: true,
      workflows: [
        {
          workflow_id: "linear-team-review",
          status: 202,
        },
        {
          workflow_id: "linear-timetracking-factory",
          status: 202,
        },
      ],
    });

    expect(reviewRequests).toEqual([
      {
        path: "/api/v1/webhooks/linear",
        body,
        contentType: "application/json",
        linearSignature: "signature-a",
        xLinearSignature: "signature-b",
        userAgent: "Linear-Test",
      },
    ]);
    expect(factoryRequests).toEqual([
      {
        path: "/api/v1/webhooks/linear",
        body,
        contentType: "application/json",
        linearSignature: "signature-a",
        xLinearSignature: "signature-b",
        userAgent: "Linear-Test",
      },
    ]);
  });
});

const snapshot = (overrides: Partial<RuntimeSnapshot>): RuntimeSnapshot => {
  return {
    workflowId: overrides.workflowId ?? "workflow",
    workflowPath: overrides.workflowPath ?? "/tmp/workflow.md",
    running: overrides.running ?? [],
    retrying: overrides.retrying ?? [],
    codexTotals: overrides.codexTotals ?? {
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      secondsRunning: 42,
    },
    rateLimits: overrides.rateLimits ?? {
      primary: { remaining: 10 },
    },
    polling: overrides.polling ?? {
      checking: false,
      nextPollInMs: 1_000,
      pollIntervalMs: 30_000,
    },
  };
};
