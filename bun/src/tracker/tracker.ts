import type { EffectiveConfig, Issue, TrackerAdapter } from "../types";
import { MemoryTracker } from "./memory-tracker";
import { LinearClient } from "./linear-client";

export interface TrackerFactoryOptions {
  memoryIssues?: Issue[];
}

export const createTracker = (
  config: EffectiveConfig,
  options: TrackerFactoryOptions = {},
): TrackerAdapter => {
  if (config.tracker.kind === "memory") {
    return new MemoryTracker(options.memoryIssues ?? []);
  }

  const linear = new LinearClient({
    endpoint: config.tracker.endpoint,
    apiKey: config.tracker.apiKey,
    projectSlug: config.tracker.projectSlug,
    assignee: config.tracker.assignee,
  });

  return {
    fetchCandidateIssues: () => linear.fetchCandidateIssues(config.tracker.activeStates),
    fetchIssuesByStates: (stateNames: string[]) => linear.fetchIssuesByStates(stateNames),
    fetchIssueStatesByIds: (issueIds: string[]) => linear.fetchIssueStatesByIds(issueIds),
  };
};
