#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_CODEX_MODE ?? "success";
const logPath = process.env.FAKE_CODEX_LOG ?? "";

const log = (line: string): void => {
  if (!logPath) {
    return;
  }

  appendFileSync(logPath, `${line}\n`, "utf8");
};

const send = (payload: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

let phase: "await_initialize" | "await_initialized" | "await_thread_start" | "await_turn_start" | "await_runtime_response" = "await_initialize";
let expectedRuntimeResponse: "approval" | "tool" | "tool_user_input" | null = null;
let turnCount = 0;

const failTurn = (reason: string): void => {
  send({ method: "turn/failed", params: { reason } });
};

const onTurnStart = (msg: Record<string, unknown>): void => {
  send({
    id: msg.id,
    result: {
      turn: {
        id: `turn-${turnCount}`,
      },
    },
  });

  if (mode === "success") {
    send({ method: "turn/completed", params: {} });
    phase = "await_turn_start";
    return;
  }

  if (mode === "approval") {
    send({
      method: "item/commandExecution/requestApproval",
      id: "approval-1",
      params: {
        command: "echo hi",
      },
    });
    expectedRuntimeResponse = "approval";
    phase = "await_runtime_response";
    return;
  }

  if (mode === "tool") {
    send({
      method: "item/tool/call",
      id: "tool-call-1",
      params: {
        tool: "not_supported",
        arguments: {},
      },
    });
    expectedRuntimeResponse = "tool";
    phase = "await_runtime_response";
    return;
  }

  if (mode === "tool_user_input") {
    send({
      method: "item/tool/requestUserInput",
      id: "input-1",
      params: {
        questions: [
          {
            id: "missing-context",
            question: "Need additional input?",
          },
        ],
      },
    });
    expectedRuntimeResponse = "tool_user_input";
    phase = "await_runtime_response";
    return;
  }

  if (mode === "rate_limits") {
    send({
      method: "thread/rateLimits/updated",
      params: {
        rateLimits: {
          requestsRemaining: 42,
          tokensRemaining: 12345,
        },
      },
    });
    send({ method: "turn/completed", params: {} });
    phase = "await_turn_start";
    return;
  }

  if (mode === "input_required") {
    send({
      method: "turn/input_required",
      params: {
        requiresInput: true,
      },
    });
    phase = "await_turn_start";
    return;
  }

  failTurn(`unsupported mode: ${mode}`);
  phase = "await_turn_start";
};

const onRuntimeResponse = (msg: Record<string, unknown>): void => {
  if (expectedRuntimeResponse === "approval") {
    const responseId = msg.id;
    const decision = (msg.result as Record<string, unknown> | undefined)?.decision;

    log(`response:${String(responseId)}:${String(decision)}`);

    if (responseId === "approval-1" && typeof decision === "string" && decision.length > 0) {
      send({ method: "turn/completed", params: {} });
    } else {
      failTurn("invalid approval response");
    }

    expectedRuntimeResponse = null;
    phase = "await_turn_start";
    return;
  }

  if (expectedRuntimeResponse === "tool") {
    const responseId = msg.id;
    const success = (msg.result as Record<string, unknown> | undefined)?.success;

    log(`response:${String(responseId)}:${String(success)}`);

    if (responseId === "tool-call-1" && success === false) {
      send({ method: "turn/completed", params: {} });
    } else {
      failTurn("invalid tool response");
    }

    expectedRuntimeResponse = null;
    phase = "await_turn_start";
    return;
  }

  if (expectedRuntimeResponse === "tool_user_input") {
    const responseId = msg.id;
    log(`response:${String(responseId)}:tool_user_input`);
    send({ method: "turn/completed", params: {} });
    expectedRuntimeResponse = null;
    phase = "await_turn_start";
    return;
  }

  failTurn("unexpected runtime response");
  phase = "await_turn_start";
};

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let msg: Record<string, unknown>;

  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }

  if (typeof msg.method === "string") {
    log(`method:${msg.method}`);
  }

  if (phase === "await_initialize") {
    if (msg.method === "initialize") {
      send({ id: msg.id, result: { ok: true } });
      phase = "await_initialized";
    }
    return;
  }

  if (phase === "await_initialized") {
    if (msg.method === "initialized") {
      phase = "await_thread_start";
    }
    return;
  }

  if (phase === "await_thread_start") {
    if (msg.method === "thread/start") {
      send({
        id: msg.id,
        result: {
          thread: {
            id: "thread-1",
          },
        },
      });
      phase = "await_turn_start";
    }
    return;
  }

  if (phase === "await_turn_start") {
    if (msg.method === "turn/start") {
      turnCount += 1;
      onTurnStart(msg);
    }
    return;
  }

  if (phase === "await_runtime_response") {
    onRuntimeResponse(msg);
  }
});
