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
export const NON_GATING_CHECK_KEYS = ["autoReview", "verifierIncompleteness"] as const;

/**
 * Optional checks `checks run` triggers directly; they never gate submission and are
 * left out of run-all. The web triggers rolloutCoach via triggerDynamicCheck.
 */
export const OPTIONAL_CHECK_KEYS = ["rolloutCoach"] as const;

/** Keys `checks run` and `checks run-all --checks` may send. */
export const TRIGGERABLE_CHECK_KEYS = [
  ...GATING_CHECK_KEYS,
  ...NON_GATING_CHECK_KEYS,
  ...OPTIONAL_CHECK_KEYS,
] as const;

/** Map public CLI names to the backend's stored/trigger keys. */
const LEGACY_TEST_QUALITY_KEY = "verifyFairness";

export function toBackendCheckKey(key: string): string {
  return key === "testQuality" ? LEGACY_TEST_QUALITY_KEY : key;
}

/** Normalize backend keys to current public CLI names. */
export function toPublicCheckKey(key: string): string {
  return key === LEGACY_TEST_QUALITY_KEY ? "testQuality" : key;
}

/** Normalize result and metadata fields at the backend boundary. */
export function toPublicCheckField(key: string): string {
  if (key === LEGACY_TEST_QUALITY_KEY) return "testQuality";
  const legacyPrefix = `_${LEGACY_TEST_QUALITY_KEY}`;
  return key.startsWith(legacyPrefix) ? `_testQuality${key.slice(legacyPrefix.length)}` : key;
}

export function isRenderableCheckKey(key: string): boolean {
  return TRIGGERABLE_CHECK_KEYS.includes(toPublicCheckKey(key) as any);
}

export type GatingCheckKey = (typeof GATING_CHECK_KEYS)[number];
export type NonGatingCheckKey = (typeof NON_GATING_CHECK_KEYS)[number];
export type TriggerableCheckKey = (typeof TRIGGERABLE_CHECK_KEYS)[number];

export const PRECHECK_STAGE_IDS = [
  "github_setup",
  "problem_and_tests",
  "plagiarism_review",
  "dockerfile",
  "solution_patch",
] as const;

export type PrecheckStageId = (typeof PRECHECK_STAGE_IDS)[number];
