type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const envLevel = (Bun.env.SYMPHONY_LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
const threshold = levelOrder[envLevel] ?? levelOrder.info;
const debugEnabled = threshold <= levelOrder.debug;

const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "string") {
    if (value.length === 0) {
      return '""';
    }

    if (/\s|=/.test(value)) {
      return JSON.stringify(value);
    }

    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const renderContext = (context: Record<string, unknown>): string => {
  return Object.entries(context)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
};

const write = (level: LogLevel, message: string, context: Record<string, unknown> = {}): void => {
  if (levelOrder[level] < threshold) {
    return;
  }

  const timestamp = new Date().toISOString();
  const prefix = `ts=${timestamp} level=${level} msg=${JSON.stringify(message)}`;
  const suffix = Object.keys(context).length > 0 ? ` ${renderContext(context)}` : "";
  const line = `${prefix}${suffix}`;

  switch (level) {
    case "debug":
    case "info":
      console.log(line);
      return;
    case "warn":
      console.warn(line);
      return;
    case "error":
      console.error(line);
      return;
  }
};

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) =>
    write("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => write("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => write("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) =>
    write("error", message, context),
  errorWithTrace: (message: string, error: unknown, context: Record<string, unknown> = {}) => {
    const reason = error instanceof Error ? error.message : String(error);
    const logContext: Record<string, unknown> = {
      ...context,
      reason,
    };

    if (debugEnabled && error instanceof Error && error.stack) {
      logContext.trace = error.stack;
    }

    write("error", message, logContext);
  },
  isDebugEnabled: (): boolean => debugEnabled,
};
