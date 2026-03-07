import { afterEach, describe, expect, test } from "bun:test";

import { LinearClient } from "../src/tracker/linear-client";

const endpoint = "https://api.linear.app/graphql";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const mockIssuesResponse = () =>
  new Response(
    JSON.stringify({
      data: {
        issues: {
          nodes: [],
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );

describe("linear client scope selection", () => {
  test("uses team key scope query when tracker.team_key is configured", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      capturedBody = JSON.parse(rawBody) as Record<string, unknown>;
      return mockIssuesResponse();
    }) as typeof fetch;

    const client = new LinearClient({
      endpoint,
      apiKey: "token",
      projectSlug: null,
      teamKey: "PIP",
      teamId: null,
      assignee: null,
    });

    await client.fetchCandidateIssues(["In Review"]);

    expect(capturedBody).not.toBeNull();
    const captured = capturedBody as unknown as Record<string, unknown>;
    expect(String(captured.query ?? "")).toContain("team: {key: {eq: $teamKey}}");
    expect((captured.variables as Record<string, unknown>).teamKey).toBe("PIP");
  });

  test("uses team id scope query when tracker.team_id is configured", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      capturedBody = JSON.parse(rawBody) as Record<string, unknown>;
      return mockIssuesResponse();
    }) as typeof fetch;

    const client = new LinearClient({
      endpoint,
      apiKey: "token",
      projectSlug: null,
      teamKey: null,
      teamId: "deadbeef-team-id",
      assignee: null,
    });

    await client.fetchCandidateIssues(["In Review"]);

    expect(capturedBody).not.toBeNull();
    const captured = capturedBody as unknown as Record<string, unknown>;
    expect(String(captured.query ?? "")).toContain("team: {id: {eq: $teamId}}");
    expect((captured.variables as Record<string, unknown>).teamId).toBe("deadbeef-team-id");
  });

  test("prefers project scope when both project and team are configured", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      capturedBody = JSON.parse(rawBody) as Record<string, unknown>;
      return mockIssuesResponse();
    }) as typeof fetch;

    const client = new LinearClient({
      endpoint,
      apiKey: "token",
      projectSlug: "symphony-2f9fcdc281e6",
      teamKey: "PIP",
      teamId: null,
      assignee: null,
    });

    await client.fetchCandidateIssues(["In Review"]);

    expect(capturedBody).not.toBeNull();
    const captured = capturedBody as unknown as Record<string, unknown>;
    expect(String(captured.query ?? "")).toContain("project: {slugId: {eq: $projectSlug}}");
    expect((captured.variables as Record<string, unknown>).projectSlug).toBe(
      "symphony-2f9fcdc281e6",
    );
  });
});
