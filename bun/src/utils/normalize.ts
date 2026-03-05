export const normalizeIssueState = (state: unknown): string => {
  if (typeof state !== "string") {
    return "";
  }

  return state.trim().toLowerCase();
};

export const sanitizeWorkspaceKey = (identifier: string | null | undefined): string => {
  const source = identifier && identifier.trim() ? identifier : "issue";
  return source.replace(/[^A-Za-z0-9._-]/g, "_");
};

export const parseInteger = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  return null;
};

export const parsePositiveInteger = (value: unknown): number | null => {
  const parsed = parseInteger(value);
  if (parsed !== null && parsed > 0) {
    return parsed;
  }

  return null;
};

export const parseNonNegativeInteger = (value: unknown): number | null => {
  const parsed = parseInteger(value);
  if (parsed !== null && parsed >= 0) {
    return parsed;
  }

  return null;
};

export const parseCsvStringOrArray = (value: unknown): string[] | null => {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : String(entry).trim()))
      .filter((entry) => entry.length > 0);

    return normalized.length > 0 ? normalized : null;
  }

  if (typeof value === "string") {
    const normalized = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return normalized.length > 0 ? normalized : null;
  }

  return null;
};

export const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const normalizeMaybeString = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  return null;
};

export const normalizeStringArray = (value: unknown): string[] => {
  const parsed = parseCsvStringOrArray(value);
  return parsed ?? [];
};

export const clampMin = (value: number, min: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }

  return value < min ? min : value;
};

export const toIso = (date: Date | null): string | null => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
};
