import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import { Elysia } from "elysia";

import type { EffectiveConfig } from "../types";
import { Orchestrator } from "../orchestrator/orchestrator";
import { logger } from "../utils/logger";
import { isBrandAssetPath, registerBrandRoutes, renderBrandHead, renderBrandMark } from "./favicon";
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
  const linearWebhookPath = resolveLinearWebhookPath(configProvider);

  registerBrandRoutes(app);

  app.onRequest(({ request, set }) => {
    const path = new URL(request.url).pathname;
    const method = request.method.toUpperCase();

    if (isMethodNotAllowed(path, method, linearWebhookPath)) {
      set.status = 405;
      return errorEnvelope("method_not_allowed", "Method not allowed");
    }

    return;
  });

  app.onError(({ error, request, set, code }) => {
    logger.errorWithTrace("HTTP request failed", error, {
      code,
      method: request.method.toUpperCase(),
      path: new URL(request.url).pathname,
    });

    set.status = 500;
    return errorEnvelope("internal_error", "Internal server error");
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

  if (linearWebhookPath) {
    app.post(linearWebhookPath, async ({ request, set }) => {
      const config = configProvider();
      if (config.tracker.kind !== "linear") {
        set.status = 404;
        return errorEnvelope("not_found", "Route not found");
      }

      const rawBody = await request.text();

      if (
        config.tracker.webhookSecret &&
        !hasValidLinearWebhookSignature(
          rawBody,
          request.headers.get("linear-signature") ?? request.headers.get("x-linear-signature"),
          config.tracker.webhookSecret,
        )
      ) {
        logger.warn("Linear webhook rejected: invalid signature", {
          workflow_id: config.workflowId ?? "workflow",
          webhook_path: linearWebhookPath,
        });
        set.status = 401;
        return errorEnvelope("invalid_signature", "Invalid webhook signature");
      }

      const payload = parseWebhookPayload(rawBody);
      if (payload === null) {
        set.status = 400;
        return errorEnvelope("invalid_json", "Invalid webhook JSON payload");
      }

      const action = maybeString(payload.action);
      const eventType = maybeString(payload.type);

      try {
        const refresh = orchestrator.requestRefresh();
        logger.info("Linear webhook accepted", {
          workflow_id: config.workflowId ?? "workflow",
          webhook_path: linearWebhookPath,
          event_type: eventType,
          event_action: action,
          coalesced: refresh.coalesced,
        });

        set.status = 202;
        return {
          queued: true,
          coalesced: refresh.coalesced,
          requested_at: refresh.requestedAt.toISOString(),
          source: "linear_webhook",
          event: {
            type: eventType,
            action,
          },
        };
      } catch (error) {
        logger.errorWithTrace("Failed to process Linear webhook", error, {
          workflow_id: config.workflowId ?? "workflow",
          webhook_path: linearWebhookPath,
          event_type: eventType,
          event_action: action,
        });
        set.status = 503;
        return errorEnvelope("orchestrator_unavailable", "Orchestrator unavailable");
      }
    });
  }

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

const isMethodNotAllowed = (
  path: string,
  method: string,
  linearWebhookPath: string | null,
): boolean => {
  if (path === "/") {
    return method !== "GET";
  }

  if (isBrandAssetPath(path)) {
    return method !== "GET";
  }

  if (path === "/api/v1/state") {
    return method !== "GET";
  }

  if (path === "/api/v1/refresh") {
    return method !== "POST";
  }

  if (linearWebhookPath && path === linearWebhookPath) {
    return method !== "POST";
  }

  if (/^\/api\/v1\/[^/]+$/.test(path)) {
    return method !== "GET";
  }

  return false;
};

const resolveLinearWebhookPath = (configProvider: () => EffectiveConfig): string | null => {
  try {
    const config = configProvider();
    if (config.tracker.kind !== "linear") {
      return null;
    }

    const rawPath = config.tracker.webhookPath?.trim();
    if (!rawPath) {
      return null;
    }

    const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    return normalized.replace(/\/{2,}/g, "/");
  } catch {
    return null;
  }
};

const hasValidLinearWebhookSignature = (
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean => {
  if (!signatureHeader) {
    return false;
  }

  const received = signatureHeader.trim().toLowerCase();
  if (!received) {
    return false;
  }

  const digestHex = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedVariants = new Set([digestHex, `sha256=${digestHex}`]);

  if (expectedVariants.has(received)) {
    return true;
  }

  for (const expected of expectedVariants) {
    if (safeTimingEqual(received, expected)) {
      return true;
    }
  }

  return false;
};

const safeTimingEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
};

const parseWebhookPayload = (rawBody: string): Record<string, unknown> | null => {
  const text = rawBody.trim().length === 0 ? "{}" : rawBody;

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const maybeString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const renderDashboardHtml = (): string => {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
${renderBrandHead("Symphony Operations Dashboard")}
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
          .brand-lockup {
            display: inline-flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 18px;
          }
          .brand-emblem {
            display: grid;
            place-items: center;
            width: 52px;
            height: 52px;
            border-radius: 16px;
          }
          .brand-mark {
            width: 30px;
            height: 30px;
            display: block;
          }
          .brand-copy {
            display: flex;
            flex-direction: column;
            gap: 2px;
          }
          .brand-name {
            margin: 0;
            font-size: 0.84rem;
            font-weight: 800;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: #0f172a;
          }
          .brand-note {
            margin: 0;
            color: var(--muted);
            font-size: 0.9rem;
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
          <div class="brand-lockup">
            <div class="brand-emblem">${renderBrandMark("brand-mark")}</div>
            <div class="brand-copy">
              <p class="brand-name">Symphony</p>
              <p class="brand-note">Agent orchestration for Linear workflows</p>
            </div>
          </div>
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
