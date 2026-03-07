import type { BlockerRef, Issue } from "../types";
import { SymphonyError } from "../utils/errors";

const ISSUE_PAGE_SIZE = 50;
const NETWORK_TIMEOUT_MS = 30_000;

const CANDIDATE_BY_PROJECT_QUERY = `
query SymphonyLinearPollByProject($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue {
            id
            identifier
            state { name }
          }
        }
      }
      createdAt
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const CANDIDATE_BY_PROJECT_ALL_QUERY = `
query SymphonyLinearPollByProjectAll($projectSlug: String!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}}, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue {
            id
            identifier
            state { name }
          }
        }
      }
      createdAt
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const CANDIDATE_BY_TEAM_KEY_QUERY = `
query SymphonyLinearPollByTeamKey($teamKey: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {team: {key: {eq: $teamKey}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue {
            id
            identifier
            state { name }
          }
        }
      }
      createdAt
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const CANDIDATE_BY_TEAM_KEY_ALL_QUERY = `
query SymphonyLinearPollByTeamKeyAll($teamKey: String!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {team: {key: {eq: $teamKey}}}, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue {
            id
            identifier
            state { name }
          }
        }
      }
      createdAt
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const CANDIDATE_BY_TEAM_ID_QUERY = `
query SymphonyLinearPollByTeamId($teamId: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {team: {id: {eq: $teamId}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue {
            id
            identifier
            state { name }
          }
        }
      }
      createdAt
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const CANDIDATE_BY_TEAM_ID_ALL_QUERY = `
query SymphonyLinearPollByTeamIdAll($teamId: String!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {team: {id: {eq: $teamId}}}, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue {
            id
            identifier
            state { name }
          }
        }
      }
      createdAt
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const ISSUE_BY_IDS_QUERY = `
query SymphonyLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
  issues(filter: {id: {in: $ids}}, first: $first) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue {
            id
            identifier
            state { name }
          }
        }
      }
      createdAt
      updatedAt
    }
  }
}
`;

const VIEWER_QUERY = `
query SymphonyLinearViewer {
  viewer { id }
}
`;

export interface LinearClientOptions {
  endpoint: string;
  apiKey: string | null;
  projectSlug: string | null;
  teamKey: string | null;
  teamId: string | null;
  assignee: string | null;
}

interface AssigneeFilter {
  matchValues: Set<string>;
}

export class LinearClient {
  private readonly endpoint: string;
  private readonly apiKey: string | null;
  private readonly projectSlug: string | null;
  private readonly teamKey: string | null;
  private readonly teamId: string | null;
  private readonly assignee: string | null;

  constructor(options: LinearClientOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.projectSlug = options.projectSlug;
    this.teamKey = options.teamKey;
    this.teamId = options.teamId;
    this.assignee = options.assignee;
  }

  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    if (!this.apiKey) {
      throw new SymphonyError("missing_linear_api_token", "Linear API token is missing");
    }

    const scope = this.resolveScopeOrThrow();

    const assigneeFilter = await this.routingAssigneeFilter();
    const normalizedStates = activeStates
      .map((state) => state.trim())
      .filter((state) => state.length > 0);
    const useStateFilter = !normalizedStates.some((state) => state === "*");

    return this.fetchByStates(scope, useStateFilter ? normalizedStates : null, assigneeFilter);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) {
      return [];
    }

    if (!this.apiKey) {
      throw new SymphonyError("missing_linear_api_token", "Linear API token is missing");
    }

    const scope = this.resolveScopeOrThrow();

    return this.fetchByStates(scope, stateNames, null);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    const ids = [...new Set(issueIds.filter((id) => typeof id === "string" && id.length > 0))];

    if (ids.length === 0) {
      return [];
    }

    const assigneeFilter = await this.routingAssigneeFilter();

    const body = await this.graphql(ISSUE_BY_IDS_QUERY, {
      ids,
      first: Math.min(ids.length, ISSUE_PAGE_SIZE),
      relationFirst: ISSUE_PAGE_SIZE,
    });

    const nodes =
      asRecord(body.data)?.issues && asRecord(asRecord(body.data).issues).nodes;

    if (!Array.isArray(nodes)) {
      throw new SymphonyError("linear_unknown_payload", "Linear response payload was not recognized", {
        body,
      });
    }

    return nodes
      .map((node) => this.normalizeIssue(node, assigneeFilter))
      .filter((issue): issue is Issue => issue !== null);
  }

  async graphql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!this.apiKey) {
      throw new SymphonyError("missing_linear_api_token", "Linear API token is missing");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new SymphonyError(
          "linear_api_status",
          `Linear API returned status ${response.status}`,
          {
            status: response.status,
            body: await safeReadBody(response),
          },
        );
      }

      const json = (await response.json()) as Record<string, unknown>;

      if (Array.isArray(json.errors) && json.errors.length > 0) {
        throw new SymphonyError("linear_graphql_errors", "Linear GraphQL responded with errors", {
          errors: json.errors,
        });
      }

      return json;
    } catch (error) {
      if (error instanceof SymphonyError) {
        throw error;
      }

      throw new SymphonyError("linear_api_request", "Linear API request failed", {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchByStates(
    scope: LinearScope,
    stateNames: string[] | null,
    assigneeFilter: AssigneeFilter | null,
  ): Promise<Issue[]> {
    let after: string | null = null;
    const allIssues: Issue[] = [];

    while (true) {
      const scopedQuery = this.scopeQuery(scope, stateNames !== null);

      const body = await this.graphql(
        scopedQuery.query,
        stateNames !== null
          ? {
              ...scopedQuery.variables,
              stateNames,
              first: ISSUE_PAGE_SIZE,
              relationFirst: ISSUE_PAGE_SIZE,
              after,
            }
          : {
              ...scopedQuery.variables,
              first: ISSUE_PAGE_SIZE,
              relationFirst: ISSUE_PAGE_SIZE,
              after,
            },
      );

      const issuesData = asRecord(asRecord(body.data)?.issues);
      const nodes = issuesData?.nodes;
      const pageInfo = asRecord(issuesData?.pageInfo);

      if (!Array.isArray(nodes)) {
        throw new SymphonyError("linear_unknown_payload", "Linear candidate payload missing nodes", {
          body,
        });
      }

      for (const node of nodes) {
        const issue = this.normalizeIssue(node, assigneeFilter);
        if (issue) {
          allIssues.push(issue);
        }
      }

      const hasNextPage = pageInfo.hasNextPage === true;
      const endCursor = typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null;

      if (!hasNextPage) {
        break;
      }

      if (!endCursor) {
        throw new SymphonyError(
          "linear_missing_end_cursor",
          "Linear payload had hasNextPage=true without endCursor",
        );
      }

      after = endCursor;
    }

    return allIssues;
  }

  private resolveScopeOrThrow(): LinearScope {
    if (this.projectSlug) {
      return { type: "projectSlug", value: this.projectSlug };
    }

    if (this.teamKey) {
      return { type: "teamKey", value: this.teamKey };
    }

    if (this.teamId) {
      return { type: "teamId", value: this.teamId };
    }

    throw new SymphonyError(
      "missing_linear_scope",
      "Linear scope is missing (set project_slug or team_key or team_id)",
    );
  }

  private scopeQuery(
    scope: LinearScope,
    withStateFilter: boolean,
  ): { query: string; variables: Record<string, unknown> } {
    if (scope.type === "projectSlug") {
      return {
        query: withStateFilter ? CANDIDATE_BY_PROJECT_QUERY : CANDIDATE_BY_PROJECT_ALL_QUERY,
        variables: {
          projectSlug: scope.value,
        },
      };
    }

    if (scope.type === "teamKey") {
      return {
        query: withStateFilter ? CANDIDATE_BY_TEAM_KEY_QUERY : CANDIDATE_BY_TEAM_KEY_ALL_QUERY,
        variables: {
          teamKey: scope.value,
        },
      };
    }

    return {
      query: withStateFilter ? CANDIDATE_BY_TEAM_ID_QUERY : CANDIDATE_BY_TEAM_ID_ALL_QUERY,
      variables: {
        teamId: scope.value,
      },
    };
  }

  private normalizeIssue(raw: unknown, assigneeFilter: AssigneeFilter | null): Issue | null {
    const issue = asRecord(raw);

    const assignee = asRecord(issue.assignee);
    const state = asRecord(issue.state);

    const normalized: Issue = {
      id: asString(issue.id),
      identifier: asString(issue.identifier),
      title: asString(issue.title),
      description: asString(issue.description),
      priority: asInteger(issue.priority),
      state: asString(state.name),
      branchName: asString(issue.branchName),
      url: asString(issue.url),
      labels: this.extractLabels(issue),
      blockedBy: this.extractBlockers(issue),
      createdAt: asDate(issue.createdAt),
      updatedAt: asDate(issue.updatedAt),
      assigneeId: asString(assignee.id),
      assignedToWorker: this.assignedToWorker(assignee, assigneeFilter),
    };

    return normalized;
  }

  private extractLabels(rawIssue: Record<string, unknown>): string[] {
    const labelNodes = asRecord(rawIssue.labels).nodes;
    if (!Array.isArray(labelNodes)) {
      return [];
    }

    return labelNodes
      .map((node) => asString(asRecord(node).name))
      .filter((name): name is string => !!name)
      .map((name) => name.toLowerCase());
  }

  private extractBlockers(rawIssue: Record<string, unknown>): BlockerRef[] {
    const nodes = Array.isArray(asRecord(rawIssue.inverseRelations).nodes)
      ? (asRecord(rawIssue.inverseRelations).nodes as unknown[])
      : [];

    if (!Array.isArray(nodes)) {
      return [];
    }

    const blockers: BlockerRef[] = [];

    for (const relation of nodes) {
      const relationMap = asRecord(relation);
      const relationType = asString(relationMap.type)?.toLowerCase();
      if (relationType !== "blocks") {
        continue;
      }

      const blocker = asRecord(relationMap.issue);
      blockers.push({
        id: asString(blocker.id),
        identifier: asString(blocker.identifier),
        state: asString(asRecord(blocker.state).name),
      });
    }

    return blockers;
  }

  private async routingAssigneeFilter(): Promise<AssigneeFilter | null> {
    const assignee = this.assignee?.trim();
    if (!assignee) {
      return null;
    }

    if (assignee === "me") {
      const body = await this.graphql(VIEWER_QUERY, {});
      const viewerId = asString(asRecord(asRecord(body.data).viewer).id);
      if (!viewerId) {
        throw new SymphonyError("missing_linear_viewer_identity", "Linear viewer id is missing");
      }

      return {
        matchValues: new Set([viewerId]),
      };
    }

    return {
      matchValues: new Set([assignee]),
    };
  }

  private assignedToWorker(
    assigneePayload: Record<string, unknown>,
    assigneeFilter: AssigneeFilter | null,
  ): boolean {
    if (!assigneeFilter) {
      return true;
    }

    const assigneeId = asString(assigneePayload.id);
    if (!assigneeId) {
      return false;
    }

    return assigneeFilter.matchValues.has(assigneeId);
  }
}

type LinearScope =
  | { type: "projectSlug"; value: string }
  | { type: "teamKey"; value: string }
  | { type: "teamId"; value: string };

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

  return value;
};

const asInteger = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  return null;
};

const asDate = (value: unknown): Date | null => {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const safeReadBody = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return "<unavailable>";
  }
};
