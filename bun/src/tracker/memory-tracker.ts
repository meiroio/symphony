import type { Issue, TrackerAdapter } from "../types";

export class MemoryTracker implements TrackerAdapter {
  private readonly issues: Issue[];

  constructor(issues: Issue[]) {
    this.issues = issues;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.issues;
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const normalized = new Set(stateNames.map((state) => state.trim().toLowerCase()));
    return this.issues.filter((issue) => normalized.has((issue.state ?? "").trim().toLowerCase()));
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    const ids = new Set(issueIds);
    return this.issues.filter((issue) => issue.id && ids.has(issue.id));
  }
}
