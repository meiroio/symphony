import { Elysia } from "elysia";

import type { EffectiveConfig } from "../types";
import { Orchestrator } from "../orchestrator/orchestrator";
import { issuePayload, refreshPayload, statePayload } from "./presenter";

interface HttpServerOptions {
  orchestrator: Orchestrator;
  configProvider: () => EffectiveConfig;
}

export class HttpServer {
  private readonly orchestrator: Orchestrator;
  private readonly configProvider: () => EffectiveConfig;
  private server: Bun.Server<unknown> | null = null;

  constructor(options: HttpServerOptions) {
    this.orchestrator = options.orchestrator;
    this.configProvider = options.configProvider;
  }

  start(port: number, host: string): number {
    const app = buildApp(this.orchestrator, this.configProvider);

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
  orchestrator: Orchestrator,
  configProvider: () => EffectiveConfig,
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

  app.get("/api/v1/state", () => {
    try {
      return statePayload(orchestrator.snapshot());
    } catch {
      return {
        generated_at: new Date().toISOString(),
        error: {
          code: "snapshot_unavailable",
          message: "Snapshot unavailable",
        },
      };
    }
  });

  app.post("/api/v1/refresh", ({ set }) => {
    const payload = orchestrator.requestRefresh();
    const config = configProvider();
    set.status = 202;
    return refreshPayload(
      true,
      payload.coalesced,
      payload.requestedAt,
      config.workflowId ?? null,
      config.workflowPath ?? null,
    );
  });

  app.get("/api/v1/:issue_identifier", ({ params, set }) => {
    const identifier = params.issue_identifier;

    try {
      const result = issuePayload(identifier, orchestrator.snapshot(), configProvider().workspace.root);
      if (!result.ok) {
        set.status = 404;
        return errorEnvelope("issue_not_found", "Issue not found");
      }

      return result.payload;
    } catch {
      set.status = 404;
      return errorEnvelope("issue_not_found", "Issue not found");
    }
  });

  app.all("*", ({ set }) => {
    set.status = 404;
    return errorEnvelope("not_found", "Route not found");
  });

  return app;
};

const errorEnvelope = (code: string, message: string) => {
  return {
    error: {
      code,
      message,
    },
  };
};

const isMethodNotAllowed = (path: string, method: string): boolean => {
  if (path === "/") {
    return method !== "GET";
  }

  if (path === "/api/v1/state") {
    return method !== "GET";
  }

  if (path === "/api/v1/refresh") {
    return method !== "POST";
  }

  if (/^\/api\/v1\/[^/]+$/.test(path)) {
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
        <title>Symphony Operations Dashboard</title>
        <style>
          :root {
            color-scheme: light;
            --bg: #f4f6fb;
            --surface: #ffffff;
            --text: #1f2937;
            --muted: #4b5563;
            --accent: #0b7285;
            --border: #d1d5db;
          }
          body {
            margin: 0;
            font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
            background: radial-gradient(circle at top right, #daf2ff, #f4f6fb 38%);
            color: var(--text);
          }
          main {
            max-width: 980px;
            margin: 0 auto;
            padding: 24px 16px;
          }
          h1 {
            margin: 0 0 8px;
            font-size: 1.9rem;
            letter-spacing: -0.02em;
          }
          .panel {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 16px;
            box-shadow: 0 8px 24px rgba(2, 8, 20, 0.06);
          }
          .muted {
            color: var(--muted);
            font-size: 0.95rem;
          }
          pre {
            margin: 0;
            overflow: auto;
            font-size: 0.85rem;
            line-height: 1.45;
          }
          .badge {
            display: inline-block;
            border-radius: 999px;
            padding: 2px 8px;
            border: 1px solid var(--border);
            color: var(--accent);
            font-size: 0.75rem;
            font-weight: 700;
            text-transform: uppercase;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Symphony Operations Dashboard</h1>
          <p class="muted">
            Read-only status surface. JSON APIs are available at
            <code>/api/v1/state</code>, <code>/api/v1/:issue_identifier</code>, and
            <code>/api/v1/refresh</code>.
          </p>
          <section class="panel">
            <div class="badge">Live</div>
            <pre id="state">Loading...</pre>
          </section>
        </main>
        <script>
          async function loadState() {
            const res = await fetch('/api/v1/state');
            const payload = await res.json();
            const el = document.getElementById('state');
            if (el) {
              el.textContent = JSON.stringify(payload, null, 2);
            }
          }

          loadState();
          setInterval(loadState, 2000);
        </script>
      </body>
    </html>`;
};
