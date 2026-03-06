import type { EffectiveConfig, TrackerAdapter } from "../types";
import { LinearClient } from "./linear-client";

export interface TrackerFactoryOptions {}

export const createTracker = (
  config: EffectiveConfig,
  _options: TrackerFactoryOptions = {},
): TrackerAdapter => {
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
