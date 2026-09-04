/**
 * Check keys and precheck stages reconstructed from the current Olympus backend.
 *
 * A stored result does not prove triggerability. Keys move into
 * TRIGGERABLE_CHECK_KEYS only after a controlled trigger or equivalent
 * authoritative evidence.
 */

export const GATING_CHECK_KEYS = [
  "verifyTests",
  "verifySolution",
  "verifyFlakiness",
  "testQuality",
  "taskQuality",
  "solutionQuality",
  "descriptionQuality",
] as const;

/** Triggerable checks that belong to later/optional workflow stages. */
export const NON_GATING_CHECK_KEYS = [
  "autoReview",
  "verifierIncompleteness",
] as const;

/** Keys `checks run` and `checks run-all --checks` may send. */
export const TRIGGERABLE_CHECK_KEYS = [
  ...GATING_CHECK_KEYS,
  ...NON_GATING_CHECK_KEYS,
] as const;

/** Map public CLI names to the backend's stored/trigger keys. */
export function toBackendCheckKey(key: string): string {
  return key === "testQuality" ? "verifyFairness" : key;
}

/** Normalize backend keys to current public CLI names. */
export function toPublicCheckKey(key: string): string {
  return key === "verifyFairness" ? "testQuality" : key;
}

/** Every current key that may need a label when rendering backend payloads. */
export const RENDERABLE_CHECK_KEYS = [
  ...TRIGGERABLE_CHECK_KEYS,
  "verifyFairness",
] as const;

export type GatingCheckKey = (typeof GATING_CHECK_KEYS)[number];
export type NonGatingCheckKey = (typeof NON_GATING_CHECK_KEYS)[number];
export type TriggerableCheckKey = (typeof TRIGGERABLE_CHECK_KEYS)[number];
export type RenderableCheckKey = (typeof RENDERABLE_CHECK_KEYS)[number];

export const PRECHECK_STAGE_IDS = [
  "github_setup",
  "problem_and_tests",
  "plagiarism_review",
  "dockerfile",
  "solution_patch",
] as const;

export type PrecheckStageId = (typeof PRECHECK_STAGE_IDS)[number];
