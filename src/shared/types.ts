/**
 * Shapes returned by the Convex backend.
 *
 * The backend is reached through `anyApi`, so responses arrive untyped. These
 * aliases name the fields the CLI actually reads instead of spreading `any`
 * across call sites: they document the contract without claiming it is
 * validated. Anything genuinely dynamic stays `unknown` so callers must narrow.
 */
import { type ConvexHttpClient } from "convex/browser";

/** The Convex client, narrowed to the surface the CLI uses. */
export type Client = ConvexHttpClient;

/** A record whose keys are known but whose values are backend-controlled. */
export type Json = Record<string, any>;

/** A challenge/problem record. */
export type Problem = Json;

/** A single version of a problem. */
export type ProblemVersion = Json;

/** One entry of a version's rollout criteria. */
export type Criterion = {
  label: string;
  status?: string;
  detail?: string;
  preview?: boolean;
  description?: string;
  guidance?: string;
};

/** The rollout-criteria envelope hanging off a version. */
export type CriteriaReport = { criteria?: Criterion[] } | null | undefined;

/** A single automated or human review attached to a problem. */
export type Review = Json;

/** A submission-readiness stage entry. */
export type Stage = Json;

/** One line of the local budget breakdown. */
export type BreakdownEntry = { spent: number; reserved: number };

/**
 * A snapshot of the local token budget, attached to JSON output and carried
 * on policy errors. Shared between the core accounting and the terminal that
 * prints it, so it lives here rather than in either one.
 */
export type BudgetFeedback = {
  scope: "local";
  scopeId: string | null;
  accounting: "prospective-quotes";
  cost: number | null;
  spent: number | null;
  reserved: number | null;
  limit: number;
  remaining: number | null;
  activatedAt: string | null;
  endpoint?: string;
  challengeId?: string;
  status?: "spent" | "reserved" | "released" | "blocked";
  byCheck?: Record<string, BreakdownEntry>;
  byOperation?: Record<string, BreakdownEntry>;
  unattributed?: BreakdownEntry;
  attribution?: {
    source: "dispatch-arguments-and-prospective-quotes";
    coverage: "complete" | "partial";
  };
};
