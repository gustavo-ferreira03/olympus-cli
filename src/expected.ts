/**
 * Check keys and precheck stages reconstructed from the current Olympus backend.
 *
 * A stored result does not prove triggerability. Keys move into
 * TRIGGERABLE_CHECK_KEYS only after a controlled trigger or equivalent
 * authoritative evidence.
 */

export const GATING_CHECK_KEYS = [
  "verifyBuild",
  "verifyTests",
  "verifySolution",
  "verifyFlakiness",
  "verifyFairness",
  "taskQuality",
  "solutionQuality",
  "descriptionQuality",
] as const;

/** Triggerable checks that belong to later/optional workflow stages. */
export const NON_GATING_CHECK_KEYS = [
  "autoReview",
  "verifierIncompleteness",
] as const;

/** Stored on old versions but rejected by the current trigger endpoint. */
export const RETIRED_CHECK_KEYS = [
  "environmentQuality",
  "crossRunAnalysis",
] as const;

/** Keys `checks run` and `checks run-all --checks` may send. */
export const TRIGGERABLE_CHECK_KEYS = [
  ...GATING_CHECK_KEYS,
  ...NON_GATING_CHECK_KEYS,
] as const;

/** Every key that may need a label when rendering stored payloads. */
export const RENDERABLE_CHECK_KEYS = [
  ...TRIGGERABLE_CHECK_KEYS,
  ...RETIRED_CHECK_KEYS,
] as const;

/** Backwards-compatible alias retained from upstream 0.1.0. */
export const DYNAMIC_CHECK_KEYS = RENDERABLE_CHECK_KEYS;

export type GatingCheckKey = (typeof GATING_CHECK_KEYS)[number];
export type NonGatingCheckKey = (typeof NON_GATING_CHECK_KEYS)[number];
export type RetiredCheckKey = (typeof RETIRED_CHECK_KEYS)[number];
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

export const AGENT_RUN_KEYS = [
  "vegaVega",
  "vegaOrion",
  "vegaVega2",
  "vegaOrion2",
  "vegaOrion3",
  "orionVega",
  "orionOrion",
  "novaVega1",
  "novaVega2",
  "novaVega3",
  "novaOrion1",
  "novaOrion2",
] as const;

export type AgentRunKey = (typeof AGENT_RUN_KEYS)[number];
