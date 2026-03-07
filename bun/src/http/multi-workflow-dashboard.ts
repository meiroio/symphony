import { Elysia } from "elysia";

import type { RuntimeSnapshot } from "../types";
import { statePayload } from "./presenter";

export interface MultiWorkflowEntry {
  key: string;
  workflowId: string | null;
  workflowPath: string | null;
  httpPort: number | null;
  snapshot: RuntimeSnapshot;
}

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
    workflows: entries.map((entry) => ({
      key: entry.key,
      workflow: {
        id: entry.workflowId,
        path: entry.workflowPath,
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
    })),
  };
};

const workflowDetailPayload = (entry: MultiWorkflowEntry): Record<string, unknown> => {
  return {
    key: entry.key,
    http_port: entry.httpPort,
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

const renderDashboardHtml = (): string => {
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Symphony Workflow Dashboard</title>
      <style>
        :root {
          --bg: #f2f5f9;
          --panel: #ffffff;
          --text: #142136;
          --muted: #5a6880;
          --accent: #0a6d62;
          --accent-soft: #d7f4ef;
          --border: #d6dde9;
          --warning: #7b341e;
          --warning-soft: #ffe5d5;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          color: var(--text);
          background: linear-gradient(120deg, #eaf5ff, #f2f5f9 38%, #f6f8fb);
          font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        .shell {
          max-width: 1180px;
          margin: 0 auto;
          padding: 20px 14px;
        }
        h1 {
          margin: 0 0 4px;
          font-size: 1.8rem;
          letter-spacing: -0.02em;
        }
        .sub {
          margin: 0 0 16px;
          color: var(--muted);
          font-size: 0.95rem;
        }
        .layout {
          display: grid;
          grid-template-columns: minmax(280px, 340px) 1fr;
          gap: 14px;
        }
        .panel {
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: 0 8px 24px rgba(4, 18, 36, 0.06);
        }
        .list {
          padding: 10px;
          min-height: 560px;
        }
        .item {
          width: 100%;
          text-align: left;
          border: 1px solid var(--border);
          border-radius: 10px;
          background: #fff;
          padding: 10px 12px;
          margin-bottom: 8px;
          cursor: pointer;
        }
        .item.active {
          border-color: var(--accent);
          background: var(--accent-soft);
        }
        .item .title {
          font-weight: 700;
          margin-bottom: 4px;
          word-break: break-word;
        }
        .item .meta {
          color: var(--muted);
          font-size: 0.82rem;
        }
        .badge {
          display: inline-block;
          margin-right: 6px;
          border-radius: 999px;
          border: 1px solid var(--border);
          padding: 2px 7px;
          font-size: 0.75rem;
          font-weight: 700;
          color: var(--muted);
          background: #fff;
        }
        .badge.warn {
          color: var(--warning);
          border-color: #ffd0b2;
          background: var(--warning-soft);
        }
        .detail {
          padding: 14px;
          min-height: 560px;
        }
        .detail pre {
          margin: 0;
          font-size: 0.82rem;
          line-height: 1.45;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 10px;
        }
        .toolbar button {
          border: 1px solid var(--border);
          background: #fff;
          border-radius: 8px;
          padding: 6px 10px;
          cursor: pointer;
        }
        @media (max-width: 860px) {
          .layout { grid-template-columns: 1fr; }
          .list, .detail { min-height: 0; }
        }
      </style>
    </head>
    <body>
      <main class="shell">
        <h1>Symphony Workflow Dashboard</h1>
        <p class="sub">Select a workflow to inspect its current agent activity.</p>
        <section class="layout">
          <aside class="panel list" id="workflow-list"></aside>
          <section class="panel detail">
            <div class="toolbar">
              <strong id="selected-title">Workflow Detail</strong>
              <button id="refresh-all" type="button">Refresh All</button>
            </div>
            <pre id="workflow-detail">Loading...</pre>
          </section>
        </section>
      </main>
      <script>
        let selectedKey = null;
        let latestList = [];

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

          listEl.innerHTML = latestList.map((entry) => {
            const activeClass = entry.key === selectedKey ? 'active' : '';
            const running = entry.counts ? entry.counts.running : 0;
            const retrying = entry.counts ? entry.counts.retrying : 0;
            return '<button class="item ' + activeClass + '" data-key="' + entry.key + '">' +
              '<div class="title">' + escapeHtml(workflowTitle(entry)) + '</div>' +
              '<div class="meta"><span class="badge">running ' + running + '</span>' +
              '<span class="badge ' + (retrying > 0 ? 'warn' : '') + '">retrying ' + retrying + '</span></div>' +
              '<div class="meta">' + escapeHtml((entry.workflow && entry.workflow.path) || '') + '</div>' +
              '</button>';
          }).join('');

          listEl.querySelectorAll('button[data-key]').forEach((button) => {
            button.addEventListener('click', () => {
              const key = button.getAttribute('data-key');
              if (!key) return;
              selectedKey = key;
              void load();
            });
          });
        }

        function renderDetail(payload) {
          const titleEl = document.getElementById('selected-title');
          const detailEl = document.getElementById('workflow-detail');
          if (!titleEl || !detailEl) return;

          const chosen = latestList.find((entry) => entry.key === selectedKey);
          titleEl.textContent = chosen ? workflowTitle(chosen) : 'Workflow Detail';
          detailEl.textContent = JSON.stringify(payload, null, 2);
        }

        async function load() {
          try {
            const workflows = await fetchWorkflows();
            renderList(workflows);

            if (selectedKey) {
              const detail = await fetchWorkflowDetail(selectedKey);
              renderDetail(detail);
            }
          } catch (error) {
            const detailEl = document.getElementById('workflow-detail');
            if (detailEl) {
              detailEl.textContent = String(error);
            }
          }
        }

        function escapeHtml(text) {
          return String(text)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
        }

        const refreshButton = document.getElementById('refresh-all');
        if (refreshButton) {
          refreshButton.addEventListener('click', async () => {
            await refreshAll();
            await load();
          });
        }

        load();
        setInterval(load, 2000);
      </script>
    </body>
  </html>`;
};
