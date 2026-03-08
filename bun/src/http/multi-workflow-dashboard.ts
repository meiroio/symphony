import { Elysia } from "elysia";

import type { RuntimeSnapshot, WorkflowVisualizationConfig } from "../types";
import { isBrandAssetPath, registerBrandRoutes, renderBrandHead, renderBrandMark } from "./favicon";
import { statePayload } from "./presenter";

export interface MultiWorkflowEntry {
  key: string;
  workflowId: string | null;
  workflowPath: string | null;
  httpPort: number | null;
  tracker?: {
    kind: string | null;
    scopeType: string;
    scopeLabel: string | null;
  };
  visualization?: WorkflowVisualizationConfig | null;
  snapshot: RuntimeSnapshot;
}

const RUNNING_STALE_EVENT_MS = 5 * 60 * 1000;
const RUNNING_SILENT_SESSION_MS = 8 * 60 * 1000;

interface MultiWorkflowDashboardOptions {
  entriesProvider: () => MultiWorkflowEntry[];
  refreshAll: () => Array<{
    key: string;
    workflowId: string | null;
    workflowPath: string | null;
    coalesced: boolean;
    requestedAt: Date;
  }>;
}

export class MultiWorkflowDashboard {
  private readonly entriesProvider: () => MultiWorkflowEntry[];
  private readonly refreshAll: MultiWorkflowDashboardOptions["refreshAll"];
  private server: Bun.Server<unknown> | null = null;

  constructor(options: MultiWorkflowDashboardOptions) {
    this.entriesProvider = options.entriesProvider;
    this.refreshAll = options.refreshAll;
  }

  start(port: number, host: string): number {
    const app = buildApp(this.entriesProvider, this.refreshAll);

    const startedApp = app.listen({
      port,
      hostname: host,
    });

    this.server = startedApp.server ?? null;

    return this.server?.port ?? port;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }
}

const buildApp = (
  entriesProvider: () => MultiWorkflowEntry[],
  refreshAll: MultiWorkflowDashboardOptions["refreshAll"],
): Elysia => {
  const app = new Elysia();

  registerBrandRoutes(app);

  app.onRequest(({ request, set }) => {
    const path = new URL(request.url).pathname;
    const method = request.method.toUpperCase();

    if (isMethodNotAllowed(path, method)) {
      set.status = 405;
      return errorEnvelope("method_not_allowed", "Method not allowed");
    }

    return;
  });

  app.get("/", () => {
    return new Response(renderDashboardHtml(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  });

  app.get("/api/v1/workflows", () => {
    return workflowsPayload(entriesProvider());
  });

  app.get("/api/v1/workflows/:key", ({ params, set }) => {
    const key = params.key;
    const entry = entriesProvider().find((candidate) => candidate.key === key) ?? null;

    if (!entry) {
      set.status = 404;
      return errorEnvelope("workflow_not_found", "Workflow not found");
    }

    return workflowDetailPayload(entry);
  });

  app.post("/api/v1/refresh", ({ set }) => {
    set.status = 202;
    return {
      generated_at: new Date().toISOString(),
      workflows: refreshAll().map((entry) => ({
        key: entry.key,
        workflow: {
          id: entry.workflowId,
          path: entry.workflowPath,
        },
        queued: true,
        coalesced: entry.coalesced,
        requested_at: entry.requestedAt.toISOString(),
      })),
    };
  });

  app.all("*", ({ set }) => {
    set.status = 404;
    return errorEnvelope("not_found", "Route not found");
  });

  return app;
};

const workflowsPayload = (entries: MultiWorkflowEntry[]): Record<string, unknown> => {
  return {
    generated_at: new Date().toISOString(),
    counts: {
      workflows: entries.length,
      running: entries.reduce((sum, entry) => sum + entry.snapshot.running.length, 0),
      retrying: entries.reduce((sum, entry) => sum + entry.snapshot.retrying.length, 0),
    },
    workflows: entries.map((entry) => {
      const staleAgents = countStaleAgents(entry.snapshot);

      return {
        key: entry.key,
        workflow: {
          id: entry.workflowId,
          path: entry.workflowPath,
        },
        tracker: {
          kind: entry.tracker?.kind ?? null,
          scope_type: entry.tracker?.scopeType ?? "workspace",
          scope_label: entry.tracker?.scopeLabel ?? null,
        },
        http_port: entry.httpPort,
        counts: {
          running: entry.snapshot.running.length,
          retrying: entry.snapshot.retrying.length,
        },
        polling: {
          checking: entry.snapshot.polling.checking,
          next_poll_in_ms: entry.snapshot.polling.nextPollInMs,
          poll_interval_ms: entry.snapshot.polling.pollIntervalMs,
        },
        attention: {
          stale_agents: staleAgents,
          total: staleAgents + entry.snapshot.retrying.length,
        },
      };
    }),
  };
};

const workflowDetailPayload = (entry: MultiWorkflowEntry): Record<string, unknown> => {
  return {
    key: entry.key,
    http_port: entry.httpPort,
    tracker: {
      kind: entry.tracker?.kind ?? null,
      scope_type: entry.tracker?.scopeType ?? "workspace",
      scope_label: entry.tracker?.scopeLabel ?? null,
    },
    visualization: entry.visualization ?? null,
    ...statePayload(entry.snapshot),
  };
};

const errorEnvelope = (code: string, message: string) => ({
  error: {
    code,
    message,
  },
});

const isMethodNotAllowed = (path: string, method: string): boolean => {
  if (path === "/") {
    return method !== "GET";
  }

  if (isBrandAssetPath(path)) {
    return method !== "GET";
  }

  if (path === "/api/v1/workflows") {
    return method !== "GET";
  }

  if (path === "/api/v1/refresh") {
    return method !== "POST";
  }

  if (/^\/api\/v1\/workflows\/[^/]+$/.test(path)) {
    return method !== "GET";
  }

  return false;
};

const countStaleAgents = (snapshot: RuntimeSnapshot): number => {
  const now = Date.now();

  return snapshot.running.filter((entry) => {
    if (entry.lastCodexTimestamp) {
      return now - entry.lastCodexTimestamp.getTime() >= RUNNING_STALE_EVENT_MS;
    }

    return now - entry.startedAt.getTime() >= RUNNING_SILENT_SESSION_MS;
  }).length;
};

const renderDashboardHtml = (): string => {
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
${renderBrandHead("Symphony Workboard")}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
      <link
        href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />
      <style>
        :root {
          --bg: #0a1018;
          --bg-2: #111a24;
          --panel: rgba(18, 26, 37, 0.92);
          --panel-strong: rgba(24, 35, 49, 0.98);
          --panel-soft: rgba(27, 38, 53, 0.86);
          --text: #eef4fb;
          --muted: #95a5ba;
          --border: #2a394b;
          --accent: #58d6b4;
          --accent-soft: rgba(28, 85, 73, 0.42);
          --accent-strong: #7ce7c7;
          --link: #89b8ff;
          --warning: #d9a44a;
          --warning-soft: rgba(74, 58, 23, 0.72);
          --danger: #ff8b7f;
          --danger-soft: rgba(78, 32, 35, 0.8);
          --ok: #55d0a9;
          --shadow: 0 22px 60px rgba(0, 0, 0, 0.34);
          --shadow-soft: 0 10px 24px rgba(0, 0, 0, 0.22);
        }
        * {
          box-sizing: border-box;
        }
        html {
          scroll-behavior: smooth;
        }
        body {
          margin: 0;
          min-height: 100vh;
          color: var(--text);
          background:
            radial-gradient(circle at top left, rgba(88, 214, 180, 0.1), transparent 34%),
            radial-gradient(circle at 100% 0, rgba(137, 184, 255, 0.1), transparent 28%),
            linear-gradient(180deg, var(--bg), var(--bg-2) 48%, #0c131c);
          font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
          font-variant-numeric: tabular-nums;
          overflow-x: hidden;
          position: relative;
        }
        body::before {
          content: "";
          position: fixed;
          inset: 0;
          pointer-events: none;
          background:
            linear-gradient(rgba(149, 165, 186, 0.06) 1px, transparent 1px),
            linear-gradient(90deg, rgba(149, 165, 186, 0.06) 1px, transparent 1px);
          background-size: 28px 28px;
          opacity: 0.45;
        }
        body::after {
          content: "";
          position: fixed;
          inset: 0;
          pointer-events: none;
          background: linear-gradient(180deg, rgba(9, 14, 20, 0.3), transparent 22%, transparent 78%, rgba(0, 0, 0, 0.2));
        }
        a,
        button,
        input {
          font: inherit;
        }
        code,
        pre {
          font-family: "IBM Plex Mono", "SFMono-Regular", Menlo, monospace;
          font-variant-numeric: tabular-nums;
        }
        .shell {
          position: relative;
          z-index: 1;
          max-width: 1500px;
          margin: 0 auto;
          padding: 24px 18px 34px;
        }
        .layout > *,
        .hero-head > *,
        .detail-hero-top > *,
        .section-head > *,
        .workflow-head > *,
        .issue-head > * {
          min-width: 0;
        }
        .panel {
          background: linear-gradient(180deg, var(--panel-strong), var(--panel));
          border: 1px solid var(--border);
          border-radius: 28px;
          box-shadow: var(--shadow);
        }
        .hero {
          overflow: hidden;
          position: relative;
          margin-bottom: 16px;
          padding: clamp(20px, 3vw, 32px);
          display: flex;
          flex-direction: column;
          gap: 16px;
          background:
            radial-gradient(circle at 88% 18%, rgba(137, 184, 255, 0.18), transparent 18rem),
            linear-gradient(135deg, rgba(18, 28, 40, 0.98), rgba(16, 37, 35, 0.94));
        }
        .hero::after {
          content: "";
          position: absolute;
          right: -42px;
          top: -52px;
          width: 220px;
          height: 220px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(88, 214, 180, 0.18), transparent 70%);
          pointer-events: none;
        }
        .hero-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
        }
        .hero-copy {
          display: none;
        }
        .brand-lockup {
          display: inline-flex;
          align-items: center;
          gap: 12px;
          flex: 1 1 auto;
        }
        .brand-emblem {
          display: grid;
          place-items: center;
          width: 42px;
          height: 42px;
          flex: none;
        }
        .brand-mark {
          width: 26px;
          height: 26px;
          display: block;
        }
        .brand-copy {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .brand-name {
          margin: 0;
          font-family: "Fraunces", Georgia, serif;
          font-size: clamp(1.45rem, 2.8vw, 2rem);
          font-weight: 600;
          line-height: 1;
          letter-spacing: -0.03em;
          color: var(--text);
        }
        .brand-note {
          margin: 0;
          color: var(--muted);
          font-size: 0.83rem;
          line-height: 1.35;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        .sub {
          margin: 0;
          color: var(--muted);
          font-size: 0.84rem;
          line-height: 1.5;
          max-width: 80ch;
        }
        .hero-actions {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-shrink: 0;
        }
        .toolbar-button {
          appearance: none;
          border: 1px solid var(--border);
          background: rgba(20, 30, 42, 0.92);
          color: var(--text);
          border-radius: 999px;
          padding: 9px 14px;
          font-size: 0.84rem;
          font-weight: 600;
          cursor: pointer;
          box-shadow: var(--shadow-soft);
          transition: transform 120ms ease, border-color 120ms ease, background-color 120ms ease;
        }
        .toolbar-button:hover {
          transform: translateY(-1px);
          border-color: rgba(88, 214, 180, 0.34);
          background: rgba(25, 37, 52, 0.96);
        }
        .toolbar-button.is-live {
          background: var(--accent-soft);
          color: var(--accent-strong);
          border-color: rgba(88, 214, 180, 0.28);
        }
        .overview-strip {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 12px;
        }
        .stat-tile {
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 4px;
          background: rgba(20, 30, 43, 0.78);
          border: 1px solid rgba(42, 57, 75, 0.92);
          border-radius: 16px;
        }
        .stat-kicker {
          display: block;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.14em;
          font-size: 0.72rem;
          font-weight: 600;
        }
        .stat-value {
          font-family: "Fraunces", Georgia, serif;
          font-size: clamp(1.5rem, 2.2vw, 1.85rem);
          line-height: 1;
        }
        .stat-note {
          margin-top: 2px;
          color: var(--muted);
          font-size: 0.78rem;
          line-height: 1.45;
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 3;
          overflow: hidden;
        }
        .layout {
          display: grid;
          grid-template-columns: minmax(310px, 360px) minmax(0, 1fr);
          gap: 16px;
          align-items: start;
        }
        .rail {
          position: sticky;
          top: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-height: calc(100vh - 32px);
          overflow: hidden;
          padding: 16px;
        }
        .rail-head {
          padding-bottom: 14px;
          border-bottom: 1px solid rgba(42, 57, 75, 0.95);
        }
        .rail-title {
          margin: 0 0 10px;
          font-size: 0.96rem;
          font-weight: 700;
          letter-spacing: 0.04em;
        }
        .filter {
          width: 100%;
          border: 1px solid var(--border);
          background: rgba(13, 21, 31, 0.92);
          color: var(--text);
          border-radius: 16px;
          padding: 12px 14px;
          outline: none;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
        }
        .filter:focus {
          border-color: rgba(137, 184, 255, 0.42);
          box-shadow: 0 0 0 4px rgba(137, 184, 255, 0.12);
        }
        .filter::placeholder {
          color: #6c7b8d;
        }
        .rail-hint {
          margin: 10px 0 0;
          color: var(--muted);
          font-size: 0.8rem;
          line-height: 1.55;
        }
        .legend {
          display: grid;
          gap: 4px;
          margin-top: 12px;
          padding: 13px 14px;
          border: 1px solid var(--border);
          border-radius: 18px;
          background: var(--panel-soft);
        }
        .legend-title {
          margin: 0;
          color: var(--accent-strong);
          font-size: 0.78rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .legend-copy {
          margin: 0;
          color: var(--muted);
          font-size: 0.8rem;
          line-height: 1.55;
        }
        .workflow-list {
          display: grid;
          gap: 10px;
          overflow: auto;
          padding-right: 4px;
          scrollbar-gutter: stable;
        }
        .workflow-card {
          width: 100%;
          text-align: left;
          padding: 15px 15px 14px;
          border: 1px solid var(--border);
          border-radius: 22px;
          background: rgba(20, 30, 43, 0.92);
          color: var(--text);
          cursor: pointer;
          box-shadow: var(--shadow-soft);
          transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
        }
        .workflow-card:hover {
          transform: translateY(-1px);
          border-color: rgba(88, 214, 180, 0.28);
        }
        .workflow-card.active {
          border-color: rgba(88, 214, 180, 0.44);
          box-shadow: 0 0 0 4px rgba(88, 214, 180, 0.08), var(--shadow-soft);
        }
        .workflow-head {
          display: grid;
          grid-template-columns: 12px minmax(0, 1fr);
          align-items: start;
          gap: 12px;
          margin-bottom: 12px;
        }
        .status-dot {
          width: 11px;
          height: 11px;
          border-radius: 999px;
          margin-top: 6px;
          flex: none;
          box-shadow: 0 0 0 5px rgba(255, 255, 255, 0.04);
        }
        .tone-active {
          color: var(--ok);
          background: var(--ok);
        }
        .tone-idle {
          color: #708398;
          background: #708398;
        }
        .tone-alert {
          color: var(--danger);
          background: var(--danger);
        }
        .tone-scan {
          color: var(--warning);
          background: var(--warning);
        }
        .workflow-title {
          margin: 0;
          font-family: "Fraunces", Georgia, serif;
          font-size: 1.18rem;
          line-height: 1.06;
          letter-spacing: -0.02em;
          overflow-wrap: anywhere;
        }
        .workflow-tone {
          margin-top: 4px;
          color: var(--muted);
          font-size: 0.8rem;
          font-weight: 600;
          text-transform: capitalize;
          min-height: 2.5em;
        }
        .workflow-meta {
          color: var(--muted);
          font-size: 0.82rem;
          line-height: 1.48;
          overflow-wrap: anywhere;
          min-height: 2.96em;
        }
        .workflow-card .workflow-meta:last-child {
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          overflow: hidden;
        }
        .pill-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin: 10px 0;
          min-height: 28px;
        }
        .pill {
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          border: 1px solid var(--border);
          padding: 4px 9px;
          font-size: 0.72rem;
          font-weight: 700;
          color: var(--text);
          background: rgba(30, 43, 58, 0.95);
          letter-spacing: 0.03em;
          white-space: nowrap;
        }
        .pill.warn {
          color: #f5d18f;
          background: var(--warning-soft);
          border-color: rgba(217, 164, 74, 0.24);
        }
        .pill.danger {
          color: #ffd0cb;
          background: var(--danger-soft);
          border-color: rgba(255, 139, 127, 0.22);
        }
        .stage {
          min-height: 680px;
          padding: 18px;
          background: linear-gradient(180deg, rgba(15, 23, 33, 0.98), rgba(11, 18, 27, 0.96));
        }
        .workflow-detail {
          display: grid;
          gap: 16px;
        }
        .detail-hero {
          padding: 22px;
          border: 1px solid var(--border);
          border-radius: 24px;
          background:
            radial-gradient(circle at 100% 0, rgba(88, 214, 180, 0.12), transparent 28%),
            linear-gradient(180deg, rgba(20, 30, 44, 0.98), rgba(17, 26, 37, 0.98));
        }
        .detail-hero-top {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
          margin-bottom: 14px;
        }
        .detail-name {
          margin: 0 0 10px;
          font-family: "Fraunces", Georgia, serif;
          font-size: clamp(1.8rem, 3vw, 2.5rem);
          line-height: 0.98;
          letter-spacing: -0.04em;
          overflow-wrap: anywhere;
        }
        .detail-path {
          margin: 0;
          color: var(--muted);
          font-size: 0.88rem;
          line-height: 1.6;
          max-width: 76ch;
          overflow-wrap: anywhere;
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          overflow: hidden;
          min-height: 3.2em;
        }
        .detail-links {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
        }
        .detail-link {
          color: var(--link);
          text-decoration: none;
          font-size: 0.88rem;
          font-weight: 600;
        }
        .detail-link:hover {
          text-decoration: underline;
        }
        .workflow-map {
          margin: 14px 0;
          padding: 12px;
          border: 1px solid rgba(42, 57, 75, 0.92);
          border-radius: 22px;
          background: rgba(14, 21, 31, 0.78);
          overflow-x: auto;
          scrollbar-gutter: stable both-edges;
        }
        .workflow-map-head {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          align-items: flex-start;
          margin-bottom: 10px;
        }
        .workflow-map-title {
          margin: 0;
          color: var(--text);
          font-size: 0.94rem;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .workflow-map-note {
          margin: 0;
          color: var(--muted);
          font-size: 0.78rem;
          line-height: 1.45;
          text-align: right;
        }
        .workflow-map svg {
          display: block;
          min-width: 100%;
          height: auto;
        }
        .workflow-map-canvas {
          position: relative;
          min-width: max-content;
        }
        .workflow-map-svg {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          overflow: visible;
          pointer-events: none;
        }
        .flow-node-card {
          position: absolute;
          padding: 11px 12px 10px;
          border-radius: 18px;
          border: 1.5px solid rgba(55, 72, 92, 0.96);
          background: rgba(24, 35, 49, 0.98);
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          overflow: hidden;
        }
        .flow-node-card.upstream {
          background: rgba(20, 45, 42, 0.72);
          border-color: rgba(88, 214, 180, 0.28);
        }
        .flow-node-card.active {
          background: rgba(25, 46, 44, 0.96);
          border-color: rgba(88, 214, 180, 0.44);
        }
        .flow-node-card.current {
          background: rgba(31, 58, 54, 1);
          border-color: rgba(88, 214, 180, 0.9);
          box-shadow: 0 0 0 1px rgba(88, 214, 180, 0.12) inset;
        }
        .flow-node-card-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 8px;
        }
        .flow-node-card-label {
          color: #e7eef6;
          font-size: 0.8rem;
          font-weight: 700;
          line-height: 1.1;
          letter-spacing: 0.01em;
          overflow-wrap: anywhere;
        }
        .flow-node-card-sub {
          margin-top: 6px;
          color: #99adbf;
          font-size: 0.68rem;
          line-height: 1.28;
          overflow-wrap: anywhere;
        }
        .flow-node-card-count {
          display: inline-grid;
          place-items: center;
          min-width: 16px;
          height: 16px;
          padding: 0 5px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          color: #f2f6fb;
          font-size: 0.66rem;
          font-weight: 700;
          flex: none;
        }
        .flow-edge {
          fill: none;
          stroke: rgba(110, 131, 155, 0.58);
          stroke-width: 3;
          stroke-linecap: round;
        }
        .flow-edge.alert {
          stroke: rgba(255, 139, 127, 0.72);
          stroke-dasharray: 8 7;
        }
        .flow-node-rect {
          fill: rgba(24, 35, 49, 0.98);
          stroke: rgba(55, 72, 92, 0.96);
          stroke-width: 1.5;
        }
        .flow-node.upstream .flow-node-rect {
          fill: rgba(20, 45, 42, 0.72);
          stroke: rgba(88, 214, 180, 0.28);
        }
        .flow-node.active .flow-node-rect {
          fill: rgba(25, 46, 44, 0.96);
          stroke: rgba(88, 214, 180, 0.44);
        }
        .flow-node.current .flow-node-rect {
          fill: rgba(31, 58, 54, 1);
          stroke: rgba(88, 214, 180, 0.9);
          stroke-width: 2;
        }
        .flow-node-label {
          fill: #e7eef6;
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.01em;
          font-kerning: none;
          font-variant-ligatures: none;
          text-rendering: geometricPrecision;
        }
        .flow-node-sub {
          fill: #99adbf;
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 11px;
          font-kerning: none;
          font-variant-ligatures: none;
          text-rendering: geometricPrecision;
        }
        .flow-count-pill {
          fill: rgba(255, 255, 255, 0.08);
        }
        .flow-count-text {
          fill: #f2f6fb;
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 11px;
          font-weight: 700;
          font-kerning: none;
          font-variant-ligatures: none;
        }
        .story-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          margin: 14px 0;
        }
        .story-card {
          min-width: 0;
          padding: 15px 16px;
          border: 1px solid rgba(42, 57, 75, 0.92);
          border-radius: 20px;
          background: rgba(14, 21, 31, 0.74);
        }
        .story-card.alert {
          border-color: rgba(188, 81, 71, 0.24);
          background: rgba(78, 32, 35, 0.45);
        }
        .story-kicker {
          margin: 0 0 8px;
          color: var(--accent);
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.14em;
        }
        .story-title {
          margin: 0 0 8px;
          color: var(--text);
          font-family: "Fraunces", Georgia, serif;
          font-size: 1.12rem;
          line-height: 1.08;
          letter-spacing: -0.02em;
          overflow-wrap: anywhere;
        }
        .story-copy {
          margin: 0;
          color: var(--muted);
          font-size: 0.85rem;
          line-height: 1.55;
          min-height: 5.1em;
          overflow-wrap: anywhere;
        }
        .lane-strip {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 16px;
        }
        .lane-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: 34px;
          padding: 6px 11px;
          border-radius: 999px;
          border: 1px solid rgba(42, 57, 75, 0.92);
          background: rgba(21, 31, 44, 0.82);
          color: var(--muted);
          font-size: 0.79rem;
          line-height: 1.2;
          white-space: nowrap;
        }
        .lane-chip.is-current {
          color: var(--text);
          border-color: rgba(88, 214, 180, 0.34);
          background: rgba(26, 51, 49, 0.9);
          box-shadow: 0 0 0 1px rgba(88, 214, 180, 0.08) inset;
        }
        .lane-chip-count {
          display: inline-grid;
          place-items: center;
          min-width: 20px;
          height: 20px;
          padding: 0 6px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          color: var(--text);
          font-size: 0.72rem;
          font-weight: 700;
        }
        .metric-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(160px, 1fr));
          gap: 12px;
        }
        .metric-card {
          min-height: 138px;
          padding: 16px;
          border: 1px solid var(--border);
          border-radius: 22px;
          background: rgba(19, 29, 41, 0.88);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }
        .metric-card.alert {
          border-color: rgba(188, 81, 71, 0.24);
          background: rgba(78, 32, 35, 0.72);
        }
        .metric-card.polling-card {
          gap: 10px;
        }
        .metric-label {
          color: var(--muted);
          font-size: 0.75rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }
        .metric-value {
          margin-top: 10px;
          font-family: "Fraunces", Georgia, serif;
          font-size: 1.7rem;
          line-height: 0.98;
          letter-spacing: -0.04em;
          overflow-wrap: anywhere;
        }
        .metric-value.polling-value {
          font-size: 1.3rem;
          letter-spacing: -0.02em;
          min-height: 2.6em;
        }
        .metric-foot {
          margin-top: 12px;
          color: var(--muted);
          font-size: 0.8rem;
          line-height: 1.45;
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 3;
          overflow: hidden;
          min-height: 3.5em;
        }
        .progress-track {
          position: relative;
          height: 10px;
          border-radius: 999px;
          background: rgba(45, 58, 75, 0.92);
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          border-radius: inherit;
          background: linear-gradient(90deg, var(--accent), #55a58f);
          transition: width 220ms ease;
        }
        .progress-fill.is-checking {
          background: linear-gradient(90deg, #b37e27, #dfb45c);
        }
        .progress-meta {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          color: var(--muted);
          font-size: 0.78rem;
          line-height: 1.45;
          min-height: 2.9em;
        }
        .progress-meta > span {
          min-width: 0;
          min-height: 2.9em;
        }
        .progress-meta > span:last-child {
          text-align: right;
        }
        .section {
          padding: 16px;
          border: 1px solid var(--border);
          border-radius: 24px;
          background: rgba(18, 27, 38, 0.9);
        }
        .section-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 14px;
          margin-bottom: 14px;
        }
        .section-title {
          margin: 0;
          font-size: 0.98rem;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .section-note {
          color: var(--muted);
          font-size: 0.82rem;
          line-height: 1.5;
          text-align: right;
          min-height: 2.9em;
        }
        .issue-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }
        .running-grid {
          display: grid;
          gap: 12px;
        }
        .retry-grid {
          display: grid;
          gap: 12px;
        }
        .issue-card {
          min-width: 0;
          min-height: 216px;
          padding: 16px;
          border: 1px solid var(--border);
          border-radius: 22px;
          background: rgba(22, 33, 46, 0.96);
          display: flex;
          flex-direction: column;
          box-shadow: var(--shadow-soft);
        }
        .issue-card.alert {
          border-color: rgba(188, 81, 71, 0.24);
          background: rgba(78, 32, 35, 0.58);
        }
        .issue-card.scan {
          border-color: rgba(155, 106, 24, 0.2);
          background: rgba(74, 58, 23, 0.48);
        }
        .running-card {
          min-height: 0;
        }
        .retry-card {
          min-height: 0;
        }
        .issue-head {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: flex-start;
          margin-bottom: 12px;
        }
        .issue-head-main {
          min-width: 0;
        }
        .issue-id {
          margin: 0;
          font-family: "Fraunces", Georgia, serif;
          font-size: 1.2rem;
          line-height: 1;
          letter-spacing: -0.03em;
          overflow-wrap: anywhere;
        }
        .issue-title-line {
          margin-top: 8px;
          color: var(--muted);
          font-size: 0.85rem;
          line-height: 1.45;
          min-height: 2.5em;
          overflow-wrap: anywhere;
        }
        .issue-stage-intent {
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid rgba(42, 57, 75, 0.92);
          color: var(--muted);
          font-size: 0.79rem;
          line-height: 1.5;
          min-height: 4.6em;
          overflow-wrap: anywhere;
        }
        .issue-meta {
          display: grid;
          gap: 6px;
          color: var(--muted);
          font-size: 0.82rem;
          line-height: 1.5;
        }
        .issue-meta > div {
          overflow-wrap: anywhere;
        }
        .running-body {
          display: grid;
          grid-template-columns: minmax(380px, 1.2fr) minmax(280px, 0.8fr);
          gap: 14px;
          align-items: start;
        }
        .running-facts {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
        }
        .fact-card {
          min-width: 0;
          padding: 12px 13px;
          border: 1px solid rgba(42, 57, 75, 0.92);
          border-radius: 18px;
          background: rgba(27, 39, 54, 0.9);
        }
        .fact-label {
          color: var(--muted);
          font-size: 0.72rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .fact-value {
          margin-top: 8px;
          color: var(--text);
          font-size: 0.88rem;
          line-height: 1.45;
          overflow-wrap: anywhere;
          min-height: 2.9em;
        }
        .message-panel {
          min-width: 0;
          padding: 14px 15px;
          border: 1px solid rgba(42, 57, 75, 0.92);
          border-radius: 18px;
          background: rgba(14, 21, 31, 0.92);
          display: flex;
          flex-direction: column;
          min-height: 240px;
        }
        .message-label {
          color: var(--muted);
          font-size: 0.72rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 10px;
        }
        .message-headline {
          margin: 0 0 10px;
          color: var(--text);
          font-family: "Fraunces", Georgia, serif;
          font-size: 1.08rem;
          line-height: 1.1;
          letter-spacing: -0.02em;
          overflow-wrap: anywhere;
        }
        .message-meta {
          margin: 0 0 10px;
          color: var(--muted);
          font-size: 0.76rem;
          line-height: 1.45;
          min-height: 2.9em;
          overflow-wrap: anywhere;
        }
        .message-body {
          min-height: 172px;
          max-height: 244px;
          overflow-y: auto;
          overflow-x: hidden;
          scrollbar-gutter: stable both-edges;
          color: #d6e2ef;
          font-size: 0.92rem;
          line-height: 1.68;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .issue-message {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid rgba(42, 57, 75, 0.92);
          color: #d6e2ef;
          font-size: 0.84rem;
          line-height: 1.58;
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 4;
          overflow: hidden;
          min-height: 88px;
        }
        .empty-state {
          padding: 20px;
          border: 1px dashed rgba(90, 108, 131, 0.38);
          border-radius: 22px;
          color: var(--muted);
          background: var(--panel-soft);
          line-height: 1.62;
        }
        .meta {
          color: var(--muted);
          font-size: 0.84rem;
          line-height: 1.55;
        }
        .alert-banner {
          margin-top: 14px;
          padding: 16px;
          border: 1px solid rgba(255, 139, 127, 0.24);
          border-radius: 20px;
          background: var(--danger-soft);
        }
        .alert-banner strong {
          display: block;
          margin-bottom: 6px;
          color: #ffb7ae;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 0.78rem;
        }
        .alert-banner p {
          margin: 0;
          color: #f0c4be;
          font-size: 0.86rem;
          line-height: 1.58;
        }
        .bottom-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: 14px;
        }
        .telemetry-block {
          font-size: 0.84rem;
          color: var(--muted);
          line-height: 1.55;
        }
        .telemetry-block pre,
        .raw-json pre {
          margin: 0;
          max-height: 360px;
          padding: 14px;
          overflow: auto;
          border-radius: 18px;
          border: 1px solid var(--border);
          background: rgba(10, 16, 24, 0.98);
          color: #d5e2ee;
          font-size: 0.78rem;
          line-height: 1.55;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          scrollbar-gutter: stable both-edges;
        }
        details.raw-json summary {
          cursor: pointer;
          color: var(--link);
          font-size: 0.82rem;
          font-weight: 600;
          margin-bottom: 10px;
        }
        .status-tag {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-width: 124px;
          padding: 7px 11px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: rgba(21, 31, 44, 0.92);
          font-size: 0.76rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.07em;
          white-space: nowrap;
        }
        .blink {
          animation: none;
        }
        code {
          display: inline-block;
          padding: 0 0.3rem;
          border-radius: 0.35rem;
          background: rgba(27, 39, 54, 0.95);
        }
        ::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }
        ::-webkit-scrollbar-thumb {
          background: rgba(149, 165, 186, 0.28);
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        @media (max-width: 1220px) {
          .story-grid,
          .overview-strip,
          .metric-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .issue-grid,
          .bottom-grid {
            grid-template-columns: 1fr;
          }
          .running-body {
            grid-template-columns: 1fr;
          }
          .running-facts {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 980px) {
          .layout {
            grid-template-columns: 1fr;
          }
          .rail {
            position: static;
            max-height: none;
          }
          .workflow-list {
            overflow: visible;
          }
        }
        @media (max-width: 760px) {
          .story-grid,
          .overview-strip,
          .metric-grid,
          .issue-grid {
            grid-template-columns: 1fr;
          }
          .running-facts {
            grid-template-columns: 1fr;
          }
          .hero-head {
            flex-direction: column;
            align-items: flex-start;
          }
          .stage-head,
          .detail-hero-top {
            flex-direction: column;
          }
          .section-note {
            text-align: left;
          }
        }
      </style>
    </head>
    <body>
      <main class="shell">
        <section class="hero panel">
          <div class="hero-head">
            <div class="brand-lockup">
              <div class="brand-emblem">${renderBrandMark("brand-mark")}</div>
              <div class="brand-copy">
                <p class="brand-name">Symphony Workflow Studio</p>
                <p class="brand-note">Operator board for autonomous Linear workflows</p>
              </div>
            </div>
            <div class="hero-actions">
              <button class="toolbar-button" id="refresh-all" type="button">Refresh now</button>
              <button class="toolbar-button is-live" id="toggle-live" type="button">Live updates: On</button>
            </div>
          </div>
          <div class="overview-strip" id="overview-strip"></div>
          <p class="sub">
            Quiet workflows stay understated, pressure points stand out immediately, and each
            workflow opens into a focused activity view with agents, retries, and health signals.
          </p>
        </section>
          <section class="layout">
          <aside class="panel rail">
            <div class="rail-head">
              <p class="rail-title">Workflows</p>
              <input class="filter" id="workflow-filter" type="search" placeholder="Filter by workflow id or path" />
              <p class="rail-hint">Use <code>j</code>/<code>k</code> or the arrow keys to move. <code>r</code> refreshes the data.</p>
              <div class="legend">
                <p class="legend-title">Reading the board</p>
                <p class="legend-copy">Alert means retries or stalled agents. Active means visible progress. Scan means the poller is checking. Idle means the workflow is currently quiet.</p>
              </div>
            </div>
            <div class="workflow-list" id="workflow-list"></div>
          </aside>
          <section class="panel stage">
            <div class="workflow-detail" id="workflow-detail">Loading...</div>
          </section>
        </section>
      </main>
      <script>
        const STALE_RUNNING_EVENT_MS = 5 * 60 * 1000;
        const QUIET_SESSION_MS = 8 * 60 * 1000;
        let selectedKey = window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : null;
        let latestList = [];
        let autoRefresh = true;
        let refreshHandle = null;
        let filterText = '';

        async function fetchWorkflows() {
          const res = await fetch('/api/v1/workflows');
          return res.json();
        }

        async function fetchWorkflowDetail(key) {
          const res = await fetch('/api/v1/workflows/' + encodeURIComponent(key));
          return res.json();
        }

        async function refreshAll() {
          await fetch('/api/v1/refresh', { method: 'POST' });
        }

        function workflowTitle(entry) {
          return entry.workflow && entry.workflow.id
            ? entry.workflow.id
            : (entry.workflow && entry.workflow.path) || entry.key;
        }

        function workflowHealth(entry) {
          const running = entry.counts ? entry.counts.running : 0;
          const retrying = entry.counts ? entry.counts.retrying : 0;
          const checking = entry.polling ? entry.polling.checking : false;
          const attention = workflowAttention(entry);

          if (attention.staleAgents > 0 || retrying > 0) {
            return { label: attention.staleAgents > 0 ? 'stalled' : 'alert', tone: 'alert' };
          }
          if (running > 0) {
            return { label: 'active', tone: 'active' };
          }
          if (checking) {
            return { label: 'scanning', tone: 'scan' };
          }

          return { label: 'idle', tone: 'idle' };
        }

        function detailHealth(payload) {
          const running = Array.isArray(payload.running) ? payload.running.length : 0;
          const retrying = Array.isArray(payload.retrying) ? payload.retrying.length : 0;
          const checking = payload.polling && payload.polling.checking === true;
          const attention = payloadAttention(payload);

          if (attention.staleAgents > 0 || retrying > 0) {
            return { label: attention.staleAgents > 0 ? 'stalled signals' : 'warnings present', tone: 'alert' };
          }
          if (running > 0) {
            return { label: 'agents in motion', tone: 'active' };
          }
          if (checking) {
            return { label: 'polling now', tone: 'scan' };
          }

          return { label: 'all quiet', tone: 'idle' };
        }

        function renderOverview(payload) {
          const target = document.getElementById('overview-strip');
          if (!target) return;

          const workflows = payload && payload.counts ? payload.counts.workflows || 0 : 0;
          const running = payload && payload.counts ? payload.counts.running || 0 : 0;
          const attentionCount = latestList.filter((entry) => workflowAttention(entry).score > 0).length;
          const hot = latestList
            .filter((entry) => workflowAttention(entry).score > 0 || (entry.counts && entry.counts.running > 0))
            .map((entry) => workflowTitle(entry))
            .slice(0, 2)
            .join(', ');

          target.innerHTML =
            statTile('Workflows', String(workflows), 'Distinct loops loaded in this process.') +
            statTile('Active Agents', String(running), running > 0 ? 'Live sessions are burning tokens now.' : 'No workers are on the field.') +
            statTile('Attention', String(attentionCount), attentionCount > 0 ? 'Start with red lanes and stalled sessions.' : 'No workflow is demanding intervention.') +
            statTile('Heat Radar', hot || 'Calm', hot ? 'Busy boards: ' + escapeHtml(hot) : 'No noisy lanes at the moment.');
        }

        function renderList(payload) {
          const listEl = document.getElementById('workflow-list');
          if (!listEl) return;

          latestList = Array.isArray(payload.workflows) ? payload.workflows : [];
          if (latestList.length === 0) {
            listEl.innerHTML = '<div class="meta">No workflows loaded.</div>';
            return;
          }

          if (!selectedKey || !latestList.some((entry) => entry.key === selectedKey)) {
            selectedKey = latestList[0].key;
          }

          const visible = latestList.filter((entry) => {
            if (!filterText) return true;
            const haystack = (workflowTitle(entry) + ' ' + ((entry.workflow && entry.workflow.path) || '')).toLowerCase();
            return haystack.includes(filterText);
          });

          if (!visible.some((entry) => entry.key === selectedKey) && visible[0]) {
            selectedKey = visible[0].key;
          }

          if (visible.length === 0) {
            listEl.innerHTML = '<div class="empty-state">No workflows match this filter. Clear the search box to restore the board.</div>';
            return;
          }

          listEl.innerHTML = visible.map((entry) => {
            const activeClass = entry.key === selectedKey ? 'active' : '';
            const running = entry.counts ? entry.counts.running : 0;
            const retrying = entry.counts ? entry.counts.retrying : 0;
            const nextPoll = entry.polling ? formatMilliseconds(entry.polling.next_poll_in_ms) : 'n/a';
            const health = workflowHealth(entry);
            const attention = workflowAttention(entry);
            const trackerText = trackerSummary(entry.tracker);
            const leadBadge = attention.staleAgents > 0
              ? pill('stalled ' + attention.staleAgents, 'danger')
              : retrying > 0
                ? pill('retrying ' + retrying, 'warn')
                : '';

            return '<button class="workflow-card ' + activeClass + '" data-key="' + escapeHtml(entry.key) + '">' +
              '<div class="workflow-head">' +
                '<span class="status-dot tone-' + health.tone + ' ' + (health.tone === 'active' || health.tone === 'alert' ? 'blink' : '') + '"></span>' +
                '<div>' +
                  '<div class="workflow-title">' + escapeHtml(workflowTitle(entry)) + '</div>' +
                  '<div class="workflow-tone">' + escapeHtml(health.label) + '</div>' +
                '</div>' +
              '</div>' +
              '<div class="pill-row">' +
                leadBadge +
                pill('running ' + running, running > 0 ? '' : '') +
                pill('port ' + ((entry.http_port === null || entry.http_port === undefined) ? 'off' : entry.http_port), '') +
              '</div>' +
              '<div class="workflow-meta">' + escapeHtml(trackerText) + '</div>' +
              '<div class="workflow-meta">next sweep ' + escapeHtml(nextPoll) + '</div>' +
              '<div class="workflow-meta">' + escapeHtml((entry.workflow && entry.workflow.path) || '') + '</div>' +
            '</button>';
          }).join('');

          listEl.querySelectorAll('button[data-key]').forEach((button) => {
            button.addEventListener('click', () => {
              const key = button.getAttribute('data-key');
              if (!key) return;
              setSelectedKey(key);
              void load();
            });
          });
        }

        function renderDetail(payload) {
          const detailEl = document.getElementById('workflow-detail');
          if (!detailEl) return;

          if (payload && payload.error) {
            detailEl.innerHTML = '<div class="empty-state">' + escapeHtml(payload.error.message || 'Unknown error') + '</div>';
            return;
          }

          const chosen = latestList.find((entry) => entry.key === selectedKey);
          const title = chosen ? workflowTitle(chosen) : 'Workflow Detail';
          const trackerText = trackerSummary(payload.tracker || (chosen ? chosen.tracker : null));

          const running = Array.isArray(payload.running) ? payload.running : [];
          const retrying = Array.isArray(payload.retrying) ? payload.retrying : [];
          const health = detailHealth(payload);
          const attention = payloadAttention(payload);
          const nextPoll = payload.polling ? formatMilliseconds(payload.polling.next_poll_in_ms) : 'n/a';
          const soloUrl = typeof payload.http_port === 'number' ? 'http://127.0.0.1:' + payload.http_port + '/' : null;
          const alertSummary = attentionSummary(attention);
          const trackerBadge = trackerBadgeLabel(payload.tracker || (chosen ? chosen.tracker : null));
          const visualization = payload.visualization || null;
          const stageSummary = summarizeWorkflowStages(running, retrying, visualization);
          const narrative = workflowNarrative(payload, running, retrying, attention, stageSummary, visualization);

          detailEl.innerHTML =
            '<section class="detail-hero">' +
                '<div class="detail-hero-top">' +
                  '<div>' +
                  '<h3 class="detail-name">' + escapeHtml(title) + '</h3>' +
                  '<p class="detail-path">' + escapeHtml((payload.workflow && payload.workflow.path) || '') + '</p>' +
                '</div>' +
                '<div class="detail-links">' +
                  pill(trackerBadge, '') +
                  statusTag(health.label, health.tone) +
                  (soloUrl ? '<a class="detail-link" href="' + escapeHtml(soloUrl) + '" target="_blank" rel="noreferrer">open workflow page</a>' : '') +
                '</div>' +
              '</div>' +
              '<div class="workflow-meta">' + escapeHtml(trackerText) + '</div>' +
              renderWorkflowMap(visualization, stageSummary) +
              '<div class="story-grid">' +
                storyCard('Now', narrative.nowTitle, narrative.nowBody, narrative.nowTone) +
                storyCard('Current lane', narrative.stageTitle, narrative.stageBody, '') +
                storyCard('Next', narrative.nextTitle, narrative.nextBody, narrative.nextTone) +
              '</div>' +
              renderLaneStrip(stageSummary.lanes) +
              '<div class="metric-grid">' +
                metricCard('Running', String(running.length), running.length > 0 ? 'Sessions currently advancing work.' : 'No active agent sessions.') +
                metricCard('Attention', String(attention.total), attention.total > 0 ? alertSummary : 'No immediate operator action needed.', attention.total > 0 ? 'alert' : '') +
                metricCard('Token Load', formatCompactNumber(payload.codex_totals ? payload.codex_totals.total_tokens : 0), 'Aggregate token burn across this workflow.') +
                renderPollingCard(payload.polling) +
              '</div>' +
              (attention.total > 0
                ? '<div class="alert-banner"><strong>Needs Attention</strong><p>' + escapeHtml(alertSummary) + '</p></div>'
                : '') +
            '</section>' +
            '<section class="section">' +
              '<div class="section-head">' +
                '<h4 class="section-title">Running Agents</h4>' +
                '<div class="section-note">' + (running.length > 0 ? runningAttentionNote(attention) : 'No agents currently running.') + '</div>' +
              '</div>' +
              (running.length > 0
                ? '<div class="running-grid">' + running.slice().sort(compareIssueEntries).map((entry) => renderRunningCard(entry, visualization)).join('') + '</div>'
                : '<div class="empty-state">No agents are moving in this workflow right now. The poller is still armed.</div>') +
            '</section>' +
            '<section class="section">' +
              '<div class="section-head">' +
                '<h4 class="section-title">Retry Queue</h4>' +
                '<div class="section-note">' + (retrying.length > 0 ? 'These are the likely trouble spots.' : 'Retry queue is empty.') + '</div>' +
              '</div>' +
              (retrying.length > 0
                ? '<div class="retry-grid">' + retrying.slice().sort(compareIssueEntries).map(renderRetryCard).join('') + '</div>'
                : '<div class="empty-state">Nothing is waiting on backoff or redispatch.</div>') +
            '</section>' +
            '<section class="bottom-grid">' +
              '<section class="section telemetry-block">' +
                '<div class="section-head">' +
                  '<h4 class="section-title">Health Snapshot</h4>' +
                  '<div class="section-note">Fast signals for the selected workflow.</div>' +
                '</div>' +
                '<pre>' + escapeHtml(renderTelemetry(payload)) + '</pre>' +
              '</section>' +
              '<section class="section raw-json">' +
                '<div class="section-head">' +
                  '<h4 class="section-title">Payload</h4>' +
                  '<div class="section-note">Raw payload for debugging.</div>' +
                '</div>' +
                '<details class="raw-json">' +
                  '<summary>Toggle JSON payload</summary>' +
                  '<pre>' + escapeHtml(JSON.stringify(payload, null, 2)) + '</pre>' +
                '</details>' +
              '</section>' +
            '</section>';
        }

        async function load() {
          try {
            const workflows = await fetchWorkflows();
            renderOverview(workflows);
            renderList(workflows);

            if (selectedKey) {
              const detail = await fetchWorkflowDetail(selectedKey);
              renderDetail(detail);
            }
          } catch (error) {
            const detailEl = document.getElementById('workflow-detail');
            if (detailEl) {
              detailEl.innerHTML = '<div class="empty-state">' + escapeHtml(String(error)) + '</div>';
            }
          }
        }

        function renderRunningCard(entry, visualization) {
          const activity = describeActivity(entry.last_message, entry.last_event);
          const stage = findStageByState(visualization, entry.state);
          const tokens = entry.tokens || {};
          const status = runningEntryStatus(entry);
          const tone = status.level === 'alert' ? 'alert' : status.level === 'scan' ? 'scan' : 'active';
          const extraClass = status.level === 'alert' ? ' alert' : status.level === 'scan' ? ' scan' : '';
          const totalTokens = formatCompactNumber(tokens.total_tokens || 0);
          const inputTokens = formatCompactNumber(tokens.input_tokens || 0);
          const outputTokens = formatCompactNumber(tokens.output_tokens || 0);

          return '<article class="issue-card running-card' + extraClass + '">' +
            '<div class="issue-head">' +
              '<div class="issue-head-main">' +
                '<h5 class="issue-id">' + escapeHtml(entry.issue_identifier || entry.issue_id || 'unknown') + '</h5>' +
                '<div class="issue-title-line">' + escapeHtml(entry.issue_title || 'Active issue') + '</div>' +
                '<div class="issue-stage-intent">' + escapeHtml(stageIntent(stage)) + '</div>' +
                '<div class="pill-row">' +
                  pill(entry.state || 'unknown', '') +
                  pill('turn ' + (entry.turn_count || 0), '') +
                  pill(status.label, status.level === 'alert' ? 'danger' : status.level === 'scan' ? 'warn' : '') +
                '</div>' +
              '</div>' +
              statusTag(entry.last_event_at ? relativeFromIso(entry.last_event_at) : 'silent', tone) +
            '</div>' +
            '<div class="running-body">' +
              '<div class="message-panel">' +
                '<div class="message-label">Latest activity</div>' +
                '<div class="message-headline">' + escapeHtml(activity.title) + '</div>' +
                '<div class="message-meta">' + escapeHtml(activity.meta) + '</div>' +
                '<div class="message-body">' + escapeHtml(activity.body) + '</div>' +
              '</div>' +
              '<div class="running-facts">' +
                factCard('Session', shorten(entry.session_id || 'n/a', 36)) +
                factCard('Started', relativeFromIso(entry.started_at)) +
                factCard('Updated', entry.last_event_at ? relativeFromIso(entry.last_event_at) : 'no event yet') +
                factCard('Last event', entry.last_event || 'none') +
                factCard('Tokens', totalTokens + ' total') +
                factCard('I/O', inputTokens + ' in / ' + outputTokens + ' out') +
              '</div>' +
            '</div>' +
          '</article>';
        }

        function renderRetryCard(entry) {
          const dueLabel = entry.due_at ? relativeFromIso(entry.due_at) : 'queued';
          const errorMessage = String(entry.error || 'No error message recorded.');
          const activity = describeRetryMessage(errorMessage);

          return '<article class="issue-card retry-card alert">' +
            '<div class="issue-head">' +
              '<div class="issue-head-main">' +
                '<h5 class="issue-id">' + escapeHtml(entry.issue_identifier || entry.issue_id || 'unknown') + '</h5>' +
                '<div class="pill-row">' +
                  pill('attempt ' + (entry.attempt || 0), 'warn') +
                  pill('retry queued', 'danger') +
                '</div>' +
              '</div>' +
              statusTag(entry.due_at ? 'due ' + dueLabel : 'queued', 'alert') +
            '</div>' +
            '<div class="running-body">' +
              '<div class="message-panel">' +
                '<div class="message-label">Latest blocker</div>' +
                '<div class="message-headline">' + escapeHtml(activity.title) + '</div>' +
                '<div class="message-meta">' + escapeHtml(activity.meta) + '</div>' +
                '<div class="message-body">' + escapeHtml(activity.body) + '</div>' +
              '</div>' +
              '<div class="running-facts">' +
                factCard('Issue ID', entry.issue_id || 'unknown') +
                factCard('Attempt', String(entry.attempt || 0)) +
                factCard('Next retry', entry.due_at ? dueLabel : 'queued') +
                factCard('Queue status', 'Waiting for redispatch') +
                factCard('Error type', retryErrorSummary(errorMessage)) +
                factCard('Suggested focus', 'Inspect blocker and rerun path') +
              '</div>' +
            '</div>' +
          '</article>';
        }

        function renderTelemetry(payload) {
          const lines = [];
          const totals = payload.codex_totals || {};
          const polling = payload.polling || {};
          const attention = payloadAttention(payload);
          lines.push('generated: ' + (payload.generated_at || 'n/a'));
          lines.push('next sweep: ' + formatMilliseconds(polling.next_poll_in_ms));
          lines.push('interval: ' + formatMilliseconds(polling.poll_interval_ms));
          lines.push('runtime: ' + formatSeconds(totals.seconds_running || 0));
          lines.push('attention: ' + attention.total + ' (' + attentionSummary(attention) + ')');
          lines.push('tokens.in: ' + formatCompactNumber(totals.input_tokens || 0));
          lines.push('tokens.out: ' + formatCompactNumber(totals.output_tokens || 0));
          lines.push('tokens.total: ' + formatCompactNumber(totals.total_tokens || 0));
          lines.push('rate limits: ' + summarizeRateLimits(payload.rate_limits));
          return lines.join('\\n');
        }

        function summarizeRateLimits(rateLimits) {
          if (!rateLimits) {
            return 'none';
          }

          try {
            return JSON.stringify(rateLimits);
          } catch (error) {
            return String(rateLimits);
          }
        }

        function setSelectedKey(key) {
          selectedKey = key;
          window.location.hash = encodeURIComponent(key);
        }

        function statTile(label, value, note) {
          return '<article class="stat-tile">' +
            '<span class="stat-kicker">' + escapeHtml(label) + '</span>' +
            '<div class="stat-value">' + escapeHtml(value) + '</div>' +
            '<div class="stat-note">' + escapeHtml(note) + '</div>' +
          '</article>';
        }

        function storyCard(kicker, title, copy, tone) {
          return '<article class="story-card ' + escapeHtml(tone || '') + '">' +
            '<div class="story-kicker">' + escapeHtml(kicker) + '</div>' +
            '<div class="story-title">' + escapeHtml(title) + '</div>' +
            '<p class="story-copy">' + escapeHtml(copy) + '</p>' +
          '</article>';
        }

        function metricCard(label, value, foot) {
          const tone = arguments.length > 3 ? arguments[3] : '';
          return '<article class="metric-card ' + escapeHtml(tone) + '">' +
            '<div class="metric-label">' + escapeHtml(label) + '</div>' +
            '<div class="metric-value">' + escapeHtml(value) + '</div>' +
            '<div class="metric-foot">' + escapeHtml(foot) + '</div>' +
          '</article>';
        }

        function renderPollingCard(polling) {
          const progress = pollingProgress(polling);
          const checking = polling && polling.checking === true;
          const interval = polling ? formatMilliseconds(polling.poll_interval_ms) : 'n/a';
          const nextSweep = polling ? formatMilliseconds(polling.next_poll_in_ms) : 'n/a';

          return '<article class="metric-card polling-card">' +
            '<div class="metric-label">Polling</div>' +
            '<div class="metric-value polling-value">' + escapeHtml(checking ? 'Reconciling now' : 'Next sweep in ' + nextSweep) + '</div>' +
            '<div class="progress-track">' +
              '<div class="progress-fill ' + (checking ? 'is-checking' : '') + '" style="width:' + String(progress) + '%"></div>' +
            '</div>' +
            '<div class="progress-meta">' +
              '<span>' + escapeHtml(checking ? 'Workflow check in progress.' : 'Cadence ' + interval) + '</span>' +
              '<span>' + escapeHtml(checking ? 'live' : nextSweep + ' remaining') + '</span>' +
            '</div>' +
          '</article>';
        }

        function factCard(label, value) {
          return '<div class="fact-card">' +
            '<div class="fact-label">' + escapeHtml(label) + '</div>' +
            '<div class="fact-value">' + escapeHtml(value) + '</div>' +
          '</div>';
        }

        function renderLaneStrip(lanes) {
          if (!Array.isArray(lanes) || lanes.length === 0) {
            return '';
          }

          return '<div class="lane-strip">' + lanes.map((lane) =>
            '<div class="lane-chip ' + (lane.current ? 'is-current' : '') + '">' +
              '<span>' + escapeHtml(lane.label) + '</span>' +
              '<span class="lane-chip-count">' + escapeHtml(String(lane.count)) + '</span>' +
            '</div>'
          ).join('') + '</div>';
        }

        function renderWorkflowMap(visualization, stageSummary) {
          const lanes = Array.isArray(stageSummary && stageSummary.lanes) ? stageSummary.lanes.filter((lane) => lane.id !== 'retry_queue') : [];
          if (lanes.length === 0) {
            return '';
          }

          const transitions = Array.isArray(visualization && visualization.transitions) && visualization.transitions.length > 0
            ? visualization.transitions.filter((transition) => lanes.some((lane) => lane.id === transition.from) && lanes.some((lane) => lane.id === transition.to))
            : buildSequentialTransitions(lanes);
          const indexById = new Map(lanes.map((lane, index) => [lane.id, index]));
          const nodeWidth = 122;
          const nodeHeight = 66;
          const gap = 20;
          const paddingX = 18;
          const centerY = 108;
          const width = Math.max(760, paddingX * 2 + lanes.length * nodeWidth + Math.max(0, lanes.length - 1) * gap);
          const height = 216;
          const currentIndex = lanes.findIndex((lane) => lane.current);

          const edgesSvg = transitions.map((transition) => {
            const fromIndex = indexById.get(transition.from);
            const toIndex = indexById.get(transition.to);
            if (fromIndex === undefined || toIndex === undefined) {
              return '';
            }

            const fromX = paddingX + fromIndex * (nodeWidth + gap) + nodeWidth;
            const toX = paddingX + toIndex * (nodeWidth + gap);
            const y = centerY;
            const toneClass = transition.tone === 'alert' ? ' alert' : '';

            if (fromIndex === toIndex) {
              const nodeX = paddingX + fromIndex * (nodeWidth + gap);
              const startX = nodeX + nodeWidth * 0.78;
              const endX = nodeX + nodeWidth * 0.22;
              return '<path class="flow-edge' + toneClass + '" d="M ' + startX + ' ' + (y - 10) + ' C ' + startX + ' 32 ' + endX + ' 32 ' + endX + ' ' + (y - 10) + '" />';
            }

            if (Math.abs(toIndex - fromIndex) === 1) {
              return '<path class="flow-edge' + toneClass + '" d="M ' + fromX + ' ' + y + ' C ' + (fromX + 18) + ' ' + y + ' ' + (toX - 18) + ' ' + y + ' ' + toX + ' ' + y + '" />';
            }

            const span = Math.abs(toIndex - fromIndex);
            const arcDown = toIndex < fromIndex;
            const controlY = arcDown ? y + 54 + span * 12 : y - 54 - span * 10;
            return '<path class="flow-edge' + toneClass + '" d="M ' + fromX + ' ' + y + ' C ' + (fromX + 34) + ' ' + controlY + ' ' + (toX - 34) + ' ' + controlY + ' ' + toX + ' ' + y + '" />';
          }).join('');

          const nodeCards = lanes.map((lane, index) => {
            const x = paddingX + index * (nodeWidth + gap);
            const status = lane.current ? 'current' : lane.count > 0 ? 'active' : currentIndex > index && currentIndex >= 0 ? 'upstream' : 'idle';
            const subtitle = lane.state || 'step';

            return '<article class="flow-node-card ' + status + '" style="left:' + x + 'px; top:' + (centerY - nodeHeight / 2) + 'px; width:' + nodeWidth + 'px; height:' + nodeHeight + 'px;">' +
              '<div class="flow-node-card-head">' +
                '<div class="flow-node-card-label">' + escapeHtml(lane.label) + '</div>' +
                '<div class="flow-node-card-count">' + escapeHtml(String(lane.count)) + '</div>' +
              '</div>' +
              '<div class="flow-node-card-sub">' + escapeHtml(subtitle) + '</div>' +
            '</article>';
          }).join('');

          return '<section class="workflow-map">' +
            '<div class="workflow-map-head">' +
              '<p class="workflow-map-title">Workflow map</p>' +
              '<p class="workflow-map-note">Solid path is the main route. Dashed red paths mark failure or loopback transitions.</p>' +
            '</div>' +
            '<div class="workflow-map-canvas" style="width:' + width + 'px; height:' + height + 'px;">' +
              '<svg class="workflow-map-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Workflow stages">' +
                edgesSvg +
              '</svg>' +
              nodeCards +
            '</div>' +
          '</section>';
        }

        function buildSequentialTransitions(lanes) {
          const transitions = [];
          for (let index = 0; index < lanes.length - 1; index += 1) {
            transitions.push({
              from: lanes[index].id,
              to: lanes[index + 1].id,
              tone: 'default',
            });
          }

          return transitions;
        }

        function pill(label, tone) {
          return '<span class="pill ' + escapeHtml(tone || '') + '">' + escapeHtml(label) + '</span>';
        }

        function statusTag(label, tone) {
          return '<span class="status-tag tone-' + escapeHtml(tone || 'idle') + '">' +
            '<span class="status-dot tone-' + escapeHtml(tone || 'idle') + '"></span>' +
            escapeHtml(label) +
          '</span>';
        }

        function relativeFromIso(value) {
          if (!value) {
            return 'n/a';
          }

          const timestamp = Date.parse(value);
          if (Number.isNaN(timestamp)) {
            return value;
          }

          const diffMs = Date.now() - timestamp;
          if (Math.abs(diffMs) < 1000) {
            return 'just now';
          }

          const ahead = diffMs < 0;
          const abs = Math.abs(diffMs);
          const seconds = Math.round(abs / 1000);
          const minutes = Math.round(seconds / 60);
          const hours = Math.round(minutes / 60);

          let chunk = '';
          if (hours >= 1) {
            chunk = hours + 'h';
          } else if (minutes >= 1) {
            chunk = minutes + 'm';
          } else {
            chunk = seconds + 's';
          }

          return ahead ? 'in ' + chunk : chunk + ' ago';
        }

        function formatMilliseconds(value) {
          if (value === null || value === undefined || Number.isNaN(Number(value))) {
            return 'n/a';
          }

          const total = Math.max(0, Number(value));
          if (total < 1000) {
            return Math.round(total) + 'ms';
          }

          const seconds = total / 1000;
          if (seconds < 60) {
            return seconds.toFixed(seconds < 10 ? 1 : 0) + 's';
          }

          const minutes = Math.floor(seconds / 60);
          const remainder = Math.round(seconds % 60);
          return minutes + 'm ' + remainder + 's';
        }

        function formatSeconds(value) {
          const seconds = Number(value || 0);
          if (!Number.isFinite(seconds) || seconds <= 0) {
            return '0s';
          }

          if (seconds < 60) {
            return seconds.toFixed(seconds < 10 ? 1 : 0) + 's';
          }

          const minutes = Math.floor(seconds / 60);
          const remainder = Math.round(seconds % 60);
          if (minutes < 60) {
            return minutes + 'm ' + remainder + 's';
          }

          const hours = Math.floor(minutes / 60);
          return hours + 'h ' + (minutes % 60) + 'm';
        }

        function formatCompactNumber(value) {
          const numeric = Number(value || 0);
          if (!Number.isFinite(numeric)) {
            return '0';
          }

          if (numeric >= 1000000) {
            return (numeric / 1000000).toFixed(1).replace(/\\.0$/, '') + 'm';
          }
          if (numeric >= 1000) {
            return (numeric / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
          }

          return String(Math.round(numeric));
        }

        function shorten(text, maxLength) {
          const value = String(text || '');
          if (value.length <= maxLength) {
            return value;
          }

          return value.slice(0, maxLength - 3) + '...';
        }

        function truncate(text, maxLength) {
          return shorten(text, maxLength);
        }

        function describeActivity(message, fallbackEvent) {
          const fallbackTitle = humanizeActivityLabel(fallbackEvent || 'activity');
          if (!message) {
            return {
              title: fallbackTitle,
              meta: 'No structured event details available yet.',
              body: 'No recent agent note.',
            };
          }

          const raw = String(message);
          const parsed = safeJsonParse(raw);
          if (!parsed) {
            return {
              title: fallbackTitle,
              meta: 'Raw event text',
              body: truncate(raw, 1800),
            };
          }

          const described = describeStructuredActivity(parsed, fallbackTitle);
          if (described) {
            return described;
          }

          return {
            title: fallbackTitle,
            meta: 'Structured event',
            body: truncate(extractReadableText(parsed) || raw, 1800),
          };
        }

        function describeStructuredActivity(payload, fallbackTitle) {
          const method = typeof payload.method === 'string' ? payload.method : '';
          if (method === 'codex/event/user_message') {
            const msg = payload.params && payload.params.msg && typeof payload.params.msg.message === 'string'
              ? payload.params.msg.message
              : '';

            return {
              title: 'Task brief sent to Codex',
              meta: 'Initial handoff into the active Codex session.',
              body: truncate(msg || 'The operator task brief was sent to the agent.', 1800),
            };
          }

          if (method === 'item/completed' || method === 'item/started') {
            return describeItemActivity(payload.params ? payload.params.item : null, method === 'item/completed');
          }

          if (method === 'session_started') {
            return {
              title: 'Codex session started',
              meta: 'Session bootstrap completed.',
              body: truncate(extractReadableText(payload) || 'A new session is now active.', 1800),
            };
          }

          if (method.startsWith('codex/event/')) {
            return {
              title: humanizeActivityLabel(method.replace('codex/event/', '')),
              meta: 'Codex event',
              body: truncate(extractReadableText(payload.params || payload) || 'Event received from Codex.', 1800),
            };
          }

          if (method) {
            return {
              title: humanizeActivityLabel(method),
              meta: 'Structured event',
              body: truncate(extractReadableText(payload.params || payload) || 'Event payload received.', 1800),
            };
          }

          return null;
        }

        function describeItemActivity(item, completed) {
          if (!item || typeof item !== 'object') {
            return {
              title: completed ? 'Work item completed' : 'Work item started',
              meta: completed ? 'No additional item details were captured.' : 'Waiting for more detail.',
              body: completed ? 'The agent finished an item.' : 'The agent started an item.',
            };
          }

          if (item.type === 'commandExecution') {
            const primaryAction = describeCommandAction(item.commandActions);
            const output = truncate(cleanAggregatedOutput(item.aggregatedOutput), 1800);
            const title = primaryAction.title || (completed ? 'Command finished' : 'Command started');
            const metaParts = [];
            if (item.exitCode !== undefined && item.exitCode !== null) {
              metaParts.push('exit ' + item.exitCode);
            }
            if (item.durationMs !== undefined && item.durationMs !== null) {
              metaParts.push(formatMilliseconds(item.durationMs));
            }
            if (item.cwd) {
              metaParts.push('cwd ' + shorten(String(item.cwd), 48));
            }

            const bodyParts = [];
            if (primaryAction.body) {
              bodyParts.push(primaryAction.body);
            }
            if (item.command) {
              bodyParts.push('Command: ' + stripShellWrapper(String(item.command)));
            }
            if (output) {
              bodyParts.push('Output:\\n' + output);
            }

            return {
              title,
              meta: metaParts.join(' • ') || (completed ? 'Command completed.' : 'Command in progress.'),
              body: truncate(bodyParts.join('\\n\\n') || 'Command activity captured.', 1800),
            };
          }

          return {
            title: humanizeActivityLabel(item.type || (completed ? 'item completed' : 'item started')),
            meta: completed ? 'Codex work item completed.' : 'Codex work item started.',
            body: truncate(extractReadableText(item) || 'No readable item payload was captured.', 1800),
          };
        }

        function describeCommandAction(actions) {
          const first = Array.isArray(actions) && actions.length > 0 ? actions[0] : null;
          if (!first || typeof first !== 'object') {
            return { title: '', body: '' };
          }

          const path = typeof first.path === 'string' ? first.path : typeof first.name === 'string' ? first.name : '';
          const shortPath = path ? shorten(path, 64) : '';

          if (first.type === 'read') {
            return {
              title: shortPath ? 'Reading ' + shortPath : 'Read completed',
              body: shortPath ? 'The agent inspected ' + shortPath + '.' : 'The agent inspected a file.',
            };
          }
          if (first.type === 'write') {
            return {
              title: shortPath ? 'Updated ' + shortPath : 'Write completed',
              body: shortPath ? 'The agent changed ' + shortPath + '.' : 'The agent changed a file.',
            };
          }
          if (first.type === 'create') {
            return {
              title: shortPath ? 'Created ' + shortPath : 'File created',
              body: shortPath ? 'The agent created ' + shortPath + '.' : 'The agent created a file.',
            };
          }

          return {
            title: humanizeActivityLabel(first.type || 'command action'),
            body: shortPath ? shortPath : '',
          };
        }

        function describeRetryMessage(errorMessage) {
          const raw = String(errorMessage || 'No error message recorded.');
          const compact = raw.replace(/^error:/i, '').trim();
          const symphonyMatch = compact.match(/^([A-Za-z0-9_]+):\\s*(.*)$/);
          const title = symphonyMatch ? humanizeActivityLabel(symphonyMatch[1]) : retryErrorSummary(compact);
          const body = symphonyMatch && symphonyMatch[2] ? symphonyMatch[2] : compact;

          return {
            title: title || 'Retry queued',
            meta: 'Automatic retry is waiting on this blocker.',
            body: truncate(body || raw, 1800),
          };
        }

        function cleanAggregatedOutput(output) {
          const text = typeof output === 'string' ? output.trim() : '';
          if (!text) {
            return '';
          }

          return text
            .split('\\n')
            .slice(0, 18)
            .join('\\n');
        }

        function stripShellWrapper(command) {
          const value = String(command || '').trim();
          const match = value.match(/^\\/bin\\/[A-Za-z0-9_-]+\\s+-lc\\s+["']([\\s\\S]*)["']$/);
          return truncate(match ? match[1] : value, 220);
        }

        function extractReadableText(value) {
          if (value === null || value === undefined) {
            return '';
          }
          if (typeof value === 'string') {
            return value;
          }
          if (Array.isArray(value)) {
            return value
              .map((item) => extractReadableText(item))
              .filter(Boolean)
              .slice(0, 6)
              .join('\\n');
          }
          if (typeof value === 'object') {
            const preferredKeys = ['message', 'text', 'body', 'content', 'reason', 'command', 'aggregatedOutput'];
            for (const key of preferredKeys) {
              if (typeof value[key] === 'string' && value[key].trim()) {
                return value[key];
              }
            }

            const collected = [];
            for (const key of Object.keys(value)) {
              const nested = extractReadableText(value[key]);
              if (nested) {
                collected.push(nested);
              }
              if (collected.length >= 4) {
                break;
              }
            }
            return collected.join('\\n');
          }

          return String(value);
        }

        function safeJsonParse(value) {
          try {
            return JSON.parse(value);
          } catch (error) {
            return null;
          }
        }

        function humanizeActivityLabel(value) {
          const text = String(value || '')
            .replace(/^item\\//, '')
            .replace(/^codex\\/event\\//, '')
            .replaceAll(/[_.\\/:-]+/g, ' ')
            .trim();

          if (!text) {
            return 'Activity';
          }

          return text.charAt(0).toUpperCase() + text.slice(1);
        }

        function summarizeWorkflowStages(running, retrying, visualization) {
          const stateCounts = new Map();
          const recencySorted = running.slice().sort((left, right) => {
            const leftTime = parseIso(left.last_event_at) ?? parseIso(left.started_at) ?? 0;
            const rightTime = parseIso(right.last_event_at) ?? parseIso(right.started_at) ?? 0;
            return rightTime - leftTime;
          });
          const primaryEntry = recencySorted[0] || null;

          running.forEach((entry) => {
            const state = entry && entry.state ? String(entry.state) : 'Working';
            stateCounts.set(state, (stateCounts.get(state) || 0) + 1);
          });

          const configuredStages = Array.isArray(visualization && visualization.stages) && visualization.stages.length > 0
            ? visualization.stages.map((stage) => ({
                id: stage.id,
                label: stage.label,
                state: stage.state,
                description: stage.description,
              }))
            : Array.from(stateCounts.keys()).sort((left, right) => left.localeCompare(right)).map((state) => ({
                id: slugifyFlowId(state),
                label: state,
                state,
                description: null,
              }));

          const configuredStateSet = new Set(configuredStages.map((stage) => stage.state).filter(Boolean));
          const extraStates = Array.from(stateCounts.keys())
            .filter((state) => !configuredStateSet.has(state))
            .sort((left, right) => left.localeCompare(right))
            .map((state) => ({
              id: slugifyFlowId(state),
              label: state,
              state,
              description: null,
            }));

          const lanes = configuredStages.concat(extraStates).map((stage) => ({
            id: stage.id,
            label: stage.label,
            state: stage.state,
            description: stage.description,
            count: stage.state ? stateCounts.get(stage.state) || 0 : 0,
            current: primaryEntry ? (primaryEntry.state || 'Working') === stage.state : false,
          }));

          if (retrying.length > 0) {
            lanes.push({
              id: 'retry_queue',
              label: 'Retry queued',
              state: null,
              description: 'Issues waiting for retry backoff before the next automated attempt.',
              count: retrying.length,
              current: !primaryEntry,
            });
          }

          return {
            primaryEntry,
            primaryState: primaryEntry ? (primaryEntry.state || 'Working') : (retrying.length > 0 ? 'Retry queued' : 'Idle'),
            lanes,
          };
        }

        function workflowNarrative(payload, running, retrying, attention, stageSummary, visualization) {
          const nextPoll = payload && payload.polling ? formatMilliseconds(payload.polling.next_poll_in_ms) : 'n/a';
          const primary = stageSummary.primaryEntry;
          const primaryActivity = primary ? describeActivity(primary.last_message, primary.last_event) : null;

          if (primary) {
            const stage = findStageByState(visualization, primary.state) || stageSummary.lanes.find((lane) => lane.state === primary.state) || null;
            const stageTitle = stage ? stage.label : (primary.state || 'Working');
            const nowBody = primary.issue_title
              ? (primary.issue_identifier + ' is active in ' + stageTitle + '. ' + primary.issue_title + '.')
              : (primary.issue_identifier + ' is active in ' + stageTitle + '.');
            const stageBody = stage && stage.description
              ? stage.description
              : (primaryActivity ? (primaryActivity.title + '. ' + primaryActivity.meta) : 'Codex is currently working this lane.');
            const next = buildNextTransitionCopy(visualization, stage, retrying, attention, payload, nextPoll);

            return {
              nowTitle: 'Executing',
              nowBody,
              nowTone: attention.staleAgents > 0 ? 'alert' : '',
              stageTitle,
              stageBody,
              nextTitle: next.title,
              nextBody: next.body,
              nextTone: next.tone,
            };
          }

          if (retrying.length > 0) {
            const dueLabel = retrying[0] && retrying[0].due_at ? relativeFromIso(retrying[0].due_at) : 'soon';
            return {
              nowTitle: 'Waiting on retry',
              nowBody: retrying.length + ' issue' + (retrying.length === 1 ? '' : 's') + ' are paused behind retry backoff.',
              nowTone: 'alert',
              stageTitle: stageSummary.primaryState,
              stageBody: 'No active Codex session right now. The queue is blocked until the next retry window.',
              nextTitle: 'Redispatch',
              nextBody: 'Next retry window opens ' + dueLabel + '.',
              nextTone: 'alert',
            };
          }

          if (payload.polling && payload.polling.checking === true) {
            return {
              nowTitle: 'Scanning board',
              nowBody: 'The workflow is checking Linear for eligible issues and state changes.',
              nowTone: '',
              stageTitle: 'Idle',
              stageBody: 'No issue is currently assigned to an agent.',
              nextTitle: 'Reconcile in progress',
              nextBody: 'Results should appear as soon as the current poll completes.',
              nextTone: '',
            };
          }

          return {
            nowTitle: 'Standing by',
            nowBody: 'No active agents and no queued retries in this workflow.',
            nowTone: '',
            stageTitle: 'Idle',
            stageBody: 'The workflow is waiting for the next eligible issue or a manual state change.',
            nextTitle: 'Next sweep',
            nextBody: 'Board scan in ' + nextPoll + '.',
            nextTone: '',
          };
        }

        function findStageByState(visualization, state) {
          if (!visualization || !Array.isArray(visualization.stages) || !state) {
            return null;
          }

          return visualization.stages.find((stage) => stage.state === state) || null;
        }

        function stageIntent(stage) {
          return stage && stage.description
            ? stage.description
            : 'No lane guidance is configured for this state.';
        }

        function buildNextTransitionCopy(visualization, stage, retrying, attention, payload, nextPoll) {
          if (attention.staleAgents > 0) {
            return {
              title: 'Operator check',
              body: 'One or more sessions look stalled. Inspect the active agent cards before the next retry.',
              tone: 'alert',
            };
          }

          if (retrying.length > 0) {
            const dueLabel = retrying[0] && retrying[0].due_at ? relativeFromIso(retrying[0].due_at) : 'soon';
            return {
              title: 'Retry pending',
              body: retrying.length + ' issue' + (retrying.length === 1 ? '' : 's') + ' waiting for redispatch, next due ' + dueLabel + '.',
              tone: 'alert',
            };
          }

          if (payload.polling && payload.polling.checking === true) {
            return {
              title: 'Board reconcile',
              body: 'The workflow is reconciling tracker state while active work continues.',
              tone: '',
            };
          }

          if (!stage || !visualization || !Array.isArray(visualization.transitions)) {
            return {
              title: 'Next sweep',
              body: 'Board scan in ' + nextPoll + '.',
              tone: '',
            };
          }

          const outgoing = visualization.transitions.filter((transition) => transition.from === stage.id);
          const successTransition = outgoing.find((transition) => transition.tone !== 'alert' && transition.to !== stage.id) || outgoing.find((transition) => transition.to !== stage.id) || null;
          const failureTransition = outgoing.find((transition) => transition.tone === 'alert' || transition.to === stage.id) || null;
          const parts = [];

          if (successTransition) {
            parts.push('Success path leads to ' + transitionTargetLabel(visualization, successTransition.to) + '.');
          }
          if (failureTransition) {
            parts.push((failureTransition.label || 'Failure path remains in this lane') + '.');
          }

          return {
            title: successTransition ? transitionTargetLabel(visualization, successTransition.to) : 'Next sweep',
            body: parts.join(' ') || ('Board scan in ' + nextPoll + '.'),
            tone: failureTransition && !successTransition ? 'alert' : '',
          };
        }

        function transitionTargetLabel(visualization, targetId) {
          if (!visualization || !Array.isArray(visualization.stages)) {
            return targetId;
          }

          const target = visualization.stages.find((stage) => stage.id === targetId);
          return target ? target.label : targetId;
        }

        function slugifyFlowId(value) {
          return String(value || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'stage';
        }

        function wrapFlowLabel(value) {
          const words = String(value || '').split(/\s+/).filter(Boolean);
          if (words.length === 0) {
            return ['Stage'];
          }

          const lines = [];
          let current = '';
          words.forEach((word) => {
            const candidate = current ? current + ' ' + word : word;
            if (candidate.length <= 14 || current.length === 0) {
              current = candidate;
              return;
            }

            lines.push(current);
            current = word;
          });

          if (current) {
            lines.push(current);
          }

          return lines.slice(0, 2);
        }

        function escapeHtml(text) {
          return String(text)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
        }

        function compareIssueEntries(left, right) {
          const leftId = String(left.issue_identifier || left.issue_id || '');
          const rightId = String(right.issue_identifier || right.issue_id || '');
          return leftId.localeCompare(rightId);
        }

        function retryErrorSummary(errorMessage) {
          const compact = errorMessage.trim().split(/\\s+/).slice(0, 4).join(' ');
          return compact || 'unknown';
        }

        function trackerSummary(tracker) {
          if (!tracker) {
            return 'Tracker scope unavailable';
          }

          const trackerName = tracker.kind ? capitalize(String(tracker.kind)) : 'Tracker';
          if (tracker.scope_type === 'project') {
            return trackerName + ' project ' + (tracker.scope_label || 'unknown');
          }
          if (tracker.scope_type === 'team') {
            return trackerName + ' team ' + (tracker.scope_label || 'unknown');
          }

          return trackerName + ' workspace';
        }

        function trackerBadgeLabel(tracker) {
          if (!tracker) {
            return 'tracker';
          }

          if (tracker.scope_type === 'project') {
            return 'project';
          }
          if (tracker.scope_type === 'team') {
            return 'team';
          }

          return 'workspace';
        }

        function capitalize(value) {
          if (!value) {
            return '';
          }

          return value.charAt(0).toUpperCase() + value.slice(1);
        }

        function workflowAttention(entry) {
          const retrying = entry.counts ? Number(entry.counts.retrying || 0) : 0;
          const staleAgents = Number(entry.attention && entry.attention.stale_agents ? entry.attention.stale_agents : 0);
          return {
            retries: retrying,
            staleAgents,
            total: retrying + staleAgents,
            score: retrying * 100 + staleAgents * 10 + Number(entry.counts ? entry.counts.running || 0 : 0),
          };
        }

        function payloadAttention(payload) {
          const running = Array.isArray(payload.running) ? payload.running : [];
          const retries = Array.isArray(payload.retrying) ? payload.retrying.length : 0;
          const staleAgents = running.filter((entry) => runningEntryStatus(entry).level === 'alert').length;
          const quietAgents = running.filter((entry) => runningEntryStatus(entry).level === 'scan').length;
          return {
            retries,
            staleAgents,
            quietAgents,
            total: retries + staleAgents,
          };
        }

        function attentionSummary(attention) {
          const parts = [];
          if (attention.retries > 0) {
            parts.push(attention.retries === 1 ? '1 retry' : attention.retries + ' retries');
          }
          if (attention.staleAgents > 0) {
            parts.push(attention.staleAgents + ' stalled session' + (attention.staleAgents === 1 ? '' : 's'));
          }
          if (parts.length === 0 && attention.quietAgents > 0) {
            parts.push(attention.quietAgents + ' quiet session' + (attention.quietAgents === 1 ? '' : 's'));
          }
          return parts.length > 0 ? parts.join(', ') : 'no notable issues';
        }

        function runningAttentionNote(attention) {
          if (attention.staleAgents > 0) {
            return attention.staleAgents + ' session' + (attention.staleAgents === 1 ? ' looks' : 's look') + ' stalled.';
          }
          if (attention.quietAgents > 0) {
            return attention.quietAgents + ' session' + (attention.quietAgents === 1 ? ' is' : 's are') + ' quiet but still alive.';
          }
          return 'Live tickets on the board.';
        }

        function runningEntryStatus(entry) {
          const lastEventTime = parseIso(entry.last_event_at);
          const startedTime = parseIso(entry.started_at);
          const now = Date.now();

          if (lastEventTime !== null && now - lastEventTime >= STALE_RUNNING_EVENT_MS) {
            return { label: 'stalled', level: 'alert' };
          }

          if (lastEventTime === null && startedTime !== null && now - startedTime >= QUIET_SESSION_MS) {
            return { label: 'silent', level: 'alert' };
          }

          if (lastEventTime !== null && now - lastEventTime >= 90 * 1000) {
            return { label: 'quiet', level: 'scan' };
          }

          return { label: entry.last_event || 'moving', level: 'active' };
        }

        function parseIso(value) {
          if (!value) {
            return null;
          }

          const parsed = Date.parse(value);
          return Number.isNaN(parsed) ? null : parsed;
        }

        function pollingProgress(polling) {
          if (!polling) {
            return 0;
          }

          if (polling.checking === true) {
            return 100;
          }

          const interval = Number(polling.poll_interval_ms || 0);
          const next = Number(polling.next_poll_in_ms || 0);

          if (!Number.isFinite(interval) || interval <= 0) {
            return 0;
          }

          const completed = interval - Math.max(0, next);
          return Math.max(0, Math.min(100, Math.round((completed / interval) * 100)));
        }

        function startLoop() {
          if (refreshHandle) {
            clearInterval(refreshHandle);
          }

          refreshHandle = setInterval(() => {
            if (autoRefresh) {
              void load();
            }
          }, 2000);
        }

        function stepSelection(direction) {
          const visible = latestList.filter((entry) => {
            if (!filterText) return true;
            const haystack = (workflowTitle(entry) + ' ' + ((entry.workflow && entry.workflow.path) || '')).toLowerCase();
            return haystack.includes(filterText);
          });

          if (visible.length === 0) {
            return;
          }

          const currentIndex = Math.max(visible.findIndex((entry) => entry.key === selectedKey), 0);
          const nextIndex = (currentIndex + direction + visible.length) % visible.length;
          setSelectedKey(visible[nextIndex].key);
          void load();
        }

        const refreshButton = document.getElementById('refresh-all');
        if (refreshButton) {
          refreshButton.addEventListener('click', async () => {
            await refreshAll();
            await load();
          });
        }

        const toggleButton = document.getElementById('toggle-live');
        if (toggleButton) {
          toggleButton.addEventListener('click', () => {
            autoRefresh = !autoRefresh;
            toggleButton.textContent = 'Live updates: ' + (autoRefresh ? 'On' : 'Off');
            toggleButton.classList.toggle('is-live', autoRefresh);
          });
        }

        const filterInput = document.getElementById('workflow-filter');
        if (filterInput) {
          filterInput.addEventListener('input', (event) => {
            filterText = String(event.target && event.target.value ? event.target.value : '').trim().toLowerCase();
            renderList({ workflows: latestList, counts: { workflows: latestList.length, running: 0, retrying: 0 } });
            if (selectedKey) {
              void fetchWorkflowDetail(selectedKey).then(renderDetail);
            }
          });
        }

        window.addEventListener('hashchange', () => {
          const key = window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : null;
          if (key) {
            selectedKey = key;
            void load();
          }
        });

        window.addEventListener('keydown', (event) => {
          const target = event.target;
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
            return;
          }

          if (event.key === 'j' || event.key === 'ArrowDown') {
            event.preventDefault();
            stepSelection(1);
          } else if (event.key === 'k' || event.key === 'ArrowUp') {
            event.preventDefault();
            stepSelection(-1);
          } else if (event.key === 'r') {
            event.preventDefault();
            void refreshAll().then(load);
          }
        });

        load();
        startLoop();
      </script>
    </body>
  </html>`;
};
