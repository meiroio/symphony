import type { AppServerSession, CodexEvent, EffectiveConfig, Issue } from "../types";
import { executeDynamicTool, dynamicToolSpecs } from "./dynamic-tool";
import { logger } from "../utils/logger";

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
const TURN_START_ID = 3;

const NON_INTERACTIVE_TOOL_INPUT_ANSWER =
  "This is a non-interactive session. Operator input is unavailable.";

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: unknown;
  method?: unknown;
  params?: unknown;
  [key: string]: unknown;
}

interface RunTurnOptions {
  onMessage?: (event: CodexEvent) => void;
}

export class AppServerClient {
  private readonly configProvider: () => EffectiveConfig;

  constructor(configProvider: () => EffectiveConfig) {
    this.configProvider = configProvider;
  }

  async startSession(workspace: string): Promise<AppServerSession> {
    const config = this.configProvider();

    const process = Bun.spawn(["bash", "-lc", config.codex.command], {
      cwd: workspace,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdoutBus = new JsonLineBus(process.stdout, (line) => {
      logStreamLine("response stream", line);
    });

    stdoutBus.start();
    this.consumeStderr(process.stderr);

    try {
      await this.sendMessage(process, {
        id: INITIALIZE_ID,
        method: "initialize",
        params: {
          capabilities: {
            experimentalApi: true,
          },
          clientInfo: {
            name: "symphony-bun",
            title: "Symphony Bun",
            version: "0.1.0",
          },
        },
      });

      await this.awaitResponse(stdoutBus, INITIALIZE_ID, config.codex.readTimeoutMs);

      await this.sendMessage(process, {
        method: "initialized",
        params: {},
      });

      await this.sendMessage(process, {
        id: THREAD_START_ID,
        method: "thread/start",
        params: {
          approvalPolicy: config.codex.approvalPolicy,
          sandbox: config.codex.threadSandbox,
          cwd: workspace,
          dynamicTools: dynamicToolSpecs(),
        },
      });

      const threadStart = await this.awaitResponse(stdoutBus, THREAD_START_ID, config.codex.readTimeoutMs);
      const threadId = asString(asRecord(asRecord(threadStart.result).thread).id);

      if (!threadId) {
        throw new Error("invalid_thread_payload");
      }

      return {
        process,
        approvalPolicy: config.codex.approvalPolicy,
        autoApproveRequests: config.codex.approvalPolicy === "never",
        threadSandbox: config.codex.threadSandbox,
        turnSandboxPolicy: config.codex.turnSandboxPolicy,
        threadId,
        workspace,
        codexAppServerPid: process.pid ? String(process.pid) : null,
        messageBus: stdoutBus,
      };
    } catch (error) {
      stdoutBus.stop();
      process.kill();
      throw error;
    }
  }

  async runTurn(
    session: AppServerSession,
    prompt: string,
    issue: Issue,
    options: RunTurnOptions = {},
  ): Promise<{ sessionId: string; threadId: string; turnId: string }> {
    const onMessage = options.onMessage ?? (() => {});
    const config = this.configProvider();
    const stdoutBus = session.messageBus as JsonLineBus;

    await this.sendMessage(session.process, {
      id: TURN_START_ID,
      method: "turn/start",
      params: {
        threadId: session.threadId,
        input: [{ type: "text", text: prompt }],
        cwd: session.workspace,
        title: `${issue.identifier ?? "issue"}: ${issue.title ?? "Untitled"}`,
        approvalPolicy: session.approvalPolicy,
        sandboxPolicy: session.turnSandboxPolicy,
      },
    });

    const turnStart = await this.awaitResponse(stdoutBus, TURN_START_ID, config.codex.readTimeoutMs);
    const turnId = asString(asRecord(asRecord(turnStart.result).turn).id);

    if (!turnId) {
      throw new Error("invalid_turn_payload");
    }

    const sessionId = `${session.threadId}-${turnId}`;

    onMessage({
      event: "session_started",
      timestamp: new Date(),
      sessionId,
      threadId: session.threadId,
      turnId,
      codexAppServerPid: session.codexAppServerPid ?? undefined,
    });

    const deadline = Date.now() + config.codex.turnTimeoutMs;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("turn_timeout");
      }

      const message = await this.nextMessageWithExit(stdoutBus, session.process, remaining);

      if (message.type === "exit") {
        throw new Error(`port_exit:${message.code}`);
      }

      const payload = message.payload;
      const method = asString(payload.method);

      if (method === "turn/completed") {
        onMessage({
          event: "turn_completed",
          timestamp: new Date(),
          sessionId,
          payload,
          raw: payload,
          usage: asRecord(payload.usage),
          codexAppServerPid: session.codexAppServerPid ?? undefined,
        });

        return {
          sessionId,
          threadId: session.threadId,
          turnId,
        };
      }

      if (method === "turn/failed") {
        onMessage({
          event: "turn_failed",
          timestamp: new Date(),
          sessionId,
          payload,
          raw: payload,
          codexAppServerPid: session.codexAppServerPid ?? undefined,
        });

        throw new Error("turn_failed");
      }

      if (method === "turn/cancelled") {
        onMessage({
          event: "turn_cancelled",
          timestamp: new Date(),
          sessionId,
          payload,
          raw: payload,
          codexAppServerPid: session.codexAppServerPid ?? undefined,
        });

        throw new Error("turn_cancelled");
      }

      const handled = await this.handleInteractiveMessage(
        payload,
        session,
        onMessage,
        sessionId,
      );

      if (handled === "turn_input_required") {
        throw new Error("turn_input_required");
      }

      if (handled === "approval_required") {
        throw new Error("approval_required");
      }

      if (handled) {
        continue;
      }

      onMessage({
        event: "notification",
        timestamp: new Date(),
        sessionId,
        payload,
        raw: payload,
        usage: asRecord(payload.usage),
        codexAppServerPid: session.codexAppServerPid ?? undefined,
      });
    }
  }

  stopSession(session: AppServerSession): void {
    try {
      (session.messageBus as JsonLineBus).stop();
      session.process.kill();
    } catch {
      // ignore
    }
  }

  private async handleInteractiveMessage(
    payload: JsonRpcResponse,
    session: AppServerSession,
    onMessage: (event: CodexEvent) => void,
    sessionId: string,
  ): Promise<"handled" | "approval_required" | "turn_input_required" | null> {
    const method = asString(payload.method);

    if (!method) {
      return null;
    }

    const approvalMethods = new Map<string, string>([
      ["item/commandExecution/requestApproval", "acceptForSession"],
      ["item/fileChange/requestApproval", "acceptForSession"],
      ["execCommandApproval", "approved_for_session"],
      ["applyPatchApproval", "approved_for_session"],
    ]);

    const approvalDecision = approvalMethods.get(method);
    if (approvalDecision) {
      const id = payload.id;
      if (session.autoApproveRequests && id !== undefined) {
        await this.sendMessage(session.process, {
          id,
          result: {
            decision: approvalDecision,
          },
        });

        onMessage({
          event: "approval_auto_approved",
          timestamp: new Date(),
          sessionId,
          payload,
          codexAppServerPid: session.codexAppServerPid ?? undefined,
        });

        return "handled";
      }

      return "approval_required";
    }

    if (method === "item/tool/requestUserInput") {
      const id = payload.id;
      const params = asRecord(payload.params);

      if (id !== undefined) {
        const fallbackAnswers = buildUnavailableAnswers(params);

        if (fallbackAnswers) {
          await this.sendMessage(session.process, {
            id,
            result: {
              answers: fallbackAnswers,
            },
          });

          onMessage({
            event: "tool_input_auto_answered",
            timestamp: new Date(),
            sessionId,
            payload,
            codexAppServerPid: session.codexAppServerPid ?? undefined,
          });

          return "handled";
        }
      }

      return "turn_input_required";
    }

    if (method === "item/tool/call") {
      const id = payload.id;
      if (id === undefined) {
        return "handled";
      }

      const params = asRecord(payload.params);
      const toolName =
        asString(params.tool) ?? asString(params.name) ?? asString(asRecord(params.tool).name);
      const argumentsPayload = params.arguments ?? params.input ?? {};

      const result = await executeDynamicTool(toolName, argumentsPayload, this.configProvider());

      await this.sendMessage(session.process, {
        id,
        result,
      });

      onMessage({
        event:
          result.success === true
            ? "tool_call_completed"
            : toolName
              ? "tool_call_failed"
              : "unsupported_tool_call",
        timestamp: new Date(),
        sessionId,
        payload,
        codexAppServerPid: session.codexAppServerPid ?? undefined,
      });

      return "handled";
    }

    if (method.startsWith("turn/") && needsInput(payload)) {
      onMessage({
        event: "turn_input_required",
        timestamp: new Date(),
        sessionId,
        payload,
        codexAppServerPid: session.codexAppServerPid ?? undefined,
      });

      return "turn_input_required";
    }

    return null;
  }

  private async nextMessageWithExit(
    bus: JsonLineBus,
    process: Bun.Subprocess,
    timeoutMs: number,
  ): Promise<{ type: "message"; payload: JsonRpcResponse } | { type: "exit"; code: number }> {
    const messagePromise = bus.next(timeoutMs).then((payload) => ({ type: "message" as const, payload }));
    const exitPromise = process.exited.then((code) => ({ type: "exit" as const, code }));

    return Promise.race([messagePromise, exitPromise]);
  }

  private async awaitResponse(
    bus: JsonLineBus,
    requestId: number,
    timeoutMs: number,
  ): Promise<JsonRpcResponse> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("response_timeout");
      }

      const payload = await bus.next(remaining);
      if (payload.id !== requestId) {
        continue;
      }

      if (payload.error !== undefined) {
        throw new Error(`response_error:${JSON.stringify(payload.error)}`);
      }

      return payload;
    }
  }

  private async sendMessage(process: Bun.Subprocess, message: Record<string, unknown>): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    const stdin = process.stdin;

    if (!stdin || typeof stdin === "number") {
      throw new Error("codex_stdin_unavailable");
    }

    stdin.write(encoded);
  }

  private consumeStderr(stderr: ReadableStream<Uint8Array> | null): void {
    if (!stderr) {
      return;
    }

    const decoder = new TextDecoder();

    void (async () => {
      const reader = stderr.getReader();
      let pending = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (pending.trim()) {
            logStreamLine("stderr", pending);
          }
          break;
        }

        pending += decoder.decode(value, { stream: true });

        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";

        for (const line of lines) {
          logStreamLine("stderr", line);
        }
      }
    })();
  }
}

class JsonLineBus {
  private readonly stream: ReadableStream<Uint8Array> | null;
  private readonly onMalformedLine: (line: string) => void;
  private readonly queue: JsonRpcResponse[] = [];
  private readonly waiters: Array<{
    resolve: (value: JsonRpcResponse) => void;
    reject: (reason?: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private started = false;
  private closed = false;

  constructor(stream: ReadableStream<Uint8Array> | null, onMalformedLine: (line: string) => void) {
    this.stream = stream;
    this.onMalformedLine = onMalformedLine;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;

    if (!this.stream) {
      this.closed = true;
      return;
    }

    void this.readLoop();
  }

  stop(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("stream_closed"));
      }
    }
  }

  next(timeoutMs: number): Promise<JsonRpcResponse> {
    if (this.queue.length > 0) {
      const payload = this.queue.shift();
      if (payload) {
        return Promise.resolve(payload);
      }
    }

    if (this.closed) {
      return Promise.reject(new Error("stream_closed"));
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.findIndex((entry) => entry.resolve === resolve);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }

        reject(new Error("response_timeout"));
      }, timeoutMs);

      this.waiters.push({ resolve, reject, timeout });
    });
  }

  private async readLoop(): Promise<void> {
    if (!this.stream) {
      this.closed = true;
      return;
    }

    const reader = this.stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          if (pending.trim()) {
            this.tryPushLine(pending);
          }
          break;
        }

        pending += decoder.decode(value, { stream: true });

        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";

        for (const line of lines) {
          this.tryPushLine(line);
        }
      }
    } finally {
      this.closed = true;
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timeout);
          waiter.reject(new Error("stream_closed"));
        }
      }
    }
  }

  private tryPushLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let payload: JsonRpcResponse;

    try {
      payload = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      this.onMalformedLine(trimmed);
      return;
    }

    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timeout);
        waiter.resolve(payload);
        return;
      }
    }

    this.queue.push(payload);
  }
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
};

const asString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const needsInput = (payload: JsonRpcResponse): boolean => {
  const method = asString(payload.method) ?? "";
  if (
    [
      "turn/input_required",
      "turn/needs_input",
      "turn/need_input",
      "turn/request_input",
      "turn/request_response",
      "turn/provide_input",
      "turn/approval_required",
    ].includes(method)
  ) {
    return true;
  }

  const params = asRecord(payload.params);
  return (
    params.requiresInput === true ||
    params.needsInput === true ||
    params.input_required === true ||
    params.inputRequired === true ||
    params.type === "input_required" ||
    params.type === "needs_input"
  );
};

const buildUnavailableAnswers = (
  params: Record<string, unknown>,
): Record<string, { answers: string[] }> | null => {
  const questions = Array.isArray(params.questions) ? params.questions : null;
  if (!questions || questions.length === 0) {
    return null;
  }

  const answers: Record<string, { answers: string[] }> = {};

  for (const question of questions) {
    const questionId = asString(asRecord(question).id);
    if (!questionId) {
      return null;
    }

    answers[questionId] = {
      answers: [NON_INTERACTIVE_TOOL_INPUT_ANSWER],
    };
  }

  return answers;
};

const logStreamLine = (streamLabel: string, line: string): void => {
  const text = line.trim().slice(0, 1_000);
  if (!text) {
    return;
  }

  if (/\b(error|warn|warning|failed|fatal|panic|exception)\b/i.test(text)) {
    logger.warn(`Codex ${streamLabel} output`, { line: text });
  } else {
    logger.debug(`Codex ${streamLabel} output`, { line: text });
  }
};
