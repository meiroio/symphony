import { describe, expect, test } from "bun:test";

import { LinearClient } from "../src/tracker/linear-client";
import { SymphonyError } from "../src/utils/errors";

describe("linear client", () => {
  test("fetchIssuesByStates([]) returns empty without API calls", async () => {
    let calls = 0;

    await withFetchStub(async () => {
      calls += 1;
      return jsonResponse({ data: {} });
    }, async () => {
      const client = createClient();
      const issues = await client.fetchIssuesByStates([]);

      expect(issues).toEqual([]);
      expect(calls).toBe(0);
    });
  });

  test("candidate fetch uses slugId filter and normalizes labels/blockers", async () => {
    const requests: Array<Record<string, unknown>> = [];

    await withFetchStub(async (_input, init) => {
      requests.push(parseJsonBody(init));

      return jsonResponse({
        data: {
          issues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "MT-1",
                title: "Issue 1",
                description: "Body",
                priority: 2,
                state: { name: "Todo" },
                branchName: null,
                url: "https://linear.app/meiro-io/issue/MT-1",
                assignee: { id: "assignee-1" },
                labels: {
                  nodes: [{ name: "Bug" }, { name: "Backend" }],
                },
                inverseRelations: {
                  nodes: [
                    {
                      type: "blocks",
                      issue: {
                        id: "issue-0",
                        identifier: "MT-0",
                        state: { name: "In Progress" },
                      },
                    },
                    {
                      type: "relatesTo",
                      issue: {
                        id: "issue-x",
                        identifier: "MT-X",
                        state: { name: "Todo" },
                      },
                    },
                  ],
                },
                createdAt: "2026-03-05T12:00:00.000Z",
                updatedAt: "2026-03-05T12:01:00.000Z",
              },
            ],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      });
    }, async () => {
      const client = createClient();
      const issues = await client.fetchCandidateIssues(["Todo"]);

      expect(issues.length).toBe(1);
      expect(issues[0]?.labels).toEqual(["bug", "backend"]);
      expect(issues[0]?.blockedBy).toEqual([
        {
          id: "issue-0",
          identifier: "MT-0",
          state: "In Progress",
        },
      ]);
      expect(issues[0]?.assignedToWorker).toBeTrue();
    });

    expect(requests.length).toBe(1);
    const body = requests[0] ?? {};
    expect(String(body.query ?? "")).toContain("slugId");
    expect(body.variables).toEqual({
      projectSlug: "proj",
      stateNames: ["Todo"],
      first: 50,
      relationFirst: 50,
      after: null,
    });
  });

  test("pagination preserves order across pages", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let callIndex = 0;

    await withFetchStub(async (_input, init) => {
      requests.push(parseJsonBody(init));
      callIndex += 1;

      if (callIndex === 1) {
        return jsonResponse({
          data: {
            issues: {
              nodes: [candidateNode("issue-1", "MT-1")],
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-1",
              },
            },
          },
        });
      }

      return jsonResponse({
        data: {
          issues: {
            nodes: [candidateNode("issue-2", "MT-2")],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      });
    }, async () => {
      const client = createClient();
      const issues = await client.fetchCandidateIssues(["Todo"]);

      expect(issues.map((issue) => issue.identifier)).toEqual(["MT-1", "MT-2"]);
    });

    expect(requests.length).toBe(2);
    expect((requests[1]?.variables as Record<string, unknown> | undefined)?.after).toBe("cursor-1");
  });

  test("issue state refresh query uses [ID!] variable typing", async () => {
    let query = "";

    await withFetchStub(async (_input, init) => {
      const body = parseJsonBody(init);
      query = String(body.query ?? "");

      return jsonResponse({
        data: {
          issues: {
            nodes: [],
          },
        },
      });
    }, async () => {
      const client = createClient();
      const issues = await client.fetchIssueStatesByIds(["a", "b"]);
      expect(issues).toEqual([]);
    });

    expect(query).toContain("$ids: [ID!]!");
  });

  test("maps API status and GraphQL errors to typed Symphony errors", async () => {
    await withFetchStub(async () => new Response("boom", { status: 500 }), async () => {
      const client = createClient();

      try {
        await client.fetchCandidateIssues(["Todo"]);
        throw new Error("expected to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(SymphonyError);
        expect((error as SymphonyError).code).toBe("linear_api_status");
      }
    });

    await withFetchStub(
      async () =>
        jsonResponse({
          errors: [{ message: "nope" }],
        }),
      async () => {
        const client = createClient();

        try {
          await client.fetchCandidateIssues(["Todo"]);
          throw new Error("expected to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(SymphonyError);
          expect((error as SymphonyError).code).toBe("linear_graphql_errors");
        }
      },
    );
  });
});

const createClient = (): LinearClient => {
  return new LinearClient({
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    projectSlug: "proj",
    assignee: null,
  });
};

const candidateNode = (id: string, identifier: string): Record<string, unknown> => {
  return {
    id,
    identifier,
    title: `Title ${identifier}`,
    description: null,
    priority: 2,
    state: { name: "Todo" },
    branchName: null,
    url: null,
    assignee: { id: "assignee-1" },
    labels: { nodes: [] },
    inverseRelations: { nodes: [] },
    createdAt: "2026-03-05T12:00:00.000Z",
    updatedAt: "2026-03-05T12:00:00.000Z",
  };
};

const parseJsonBody = (init: RequestInit | undefined): Record<string, unknown> => {
  const body = init?.body;
  if (typeof body !== "string") {
    return {};
  }

  return JSON.parse(body) as Record<string, unknown>;
};

const jsonResponse = (payload: Record<string, unknown>): Response => {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
};

const withFetchStub = async (
  stub: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};
