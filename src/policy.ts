import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { credentialsDir } from "./auth.ts";
import { parseAgentTypeInput } from "./model.ts";

export interface Policy {
  version: 1;
  runs: {
    allowed_solvers: string[];
    max_new_runs_per_version: number;
    allow_manual_batch_name: boolean;
  };
  tokens: { allow_general_tokens: boolean };
}

export const defaultPolicyYaml = `version: 1 # Policy format version

runs:
  allowed_solvers: [nova] # Restrict solvers after resolving presets
  max_new_runs_per_version: 10 # Cap new runs using existing version records
  allow_manual_batch_name: false # Reject explicit batch names

tokens:
  allow_general_tokens: false # Reject explicit use of general tokens
`;

export class PolicyError extends Error {
  constructor(public rule: string, message: string, public details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PolicyError";
  }
}

export function policyPath(): string {
  return resolve(credentialsDir(), "policy.yaml");
}

function object(value: unknown, keys: string[], name: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError("policy.invalid", `${name} must be a mapping`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new PolicyError("policy.invalid", `Unknown key: ${name}.${key}`);
  }
  return value as Record<string, any>;
}

export function parsePolicy(text: string): Policy {
  try {
    const doc = parseDocument(text, { uniqueKeys: true, merge: false });
    if (doc.errors.length || doc.warnings.length) {
      throw new Error([...doc.errors, ...doc.warnings].map((item) => item.message).join("; "));
    }
    const root = object(doc.toJS({ maxAliasCount: 0 }), ["version", "runs", "tokens"], "policy");
    if (root.version !== 1) throw new Error("version must be 1");
    const runs = object(root.runs ?? {}, ["allowed_solvers", "max_new_runs_per_version", "allow_manual_batch_name"], "runs");
    const tokens = object(root.tokens ?? {}, ["allow_general_tokens"], "tokens");
    const result: Policy = {
      version: 1,
      runs: {
        allowed_solvers: runs.allowed_solvers ?? ["nova"],
        max_new_runs_per_version: runs.max_new_runs_per_version ?? 10,
        allow_manual_batch_name: runs.allow_manual_batch_name ?? false,
      },
      tokens: { allow_general_tokens: tokens.allow_general_tokens ?? false },
    };
    // Null is not a way to silently restore defaults or disable a rule.
    if ([...Object.values(runs), ...Object.values(tokens), root.runs, root.tokens].includes(null)) {
      throw new Error("Policy values cannot be null");
    }
    if (!Array.isArray(result.runs.allowed_solvers) || result.runs.allowed_solvers.length === 0 ||
        result.runs.allowed_solvers.some((solver) => typeof solver !== "string" || !parseAgentTypeInput(solver))) {
      throw new Error("runs.allowed_solvers must be a non-empty list of vega, orion, nova, or castor");
    }
    if (!Number.isSafeInteger(result.runs.max_new_runs_per_version) || result.runs.max_new_runs_per_version < 0) {
      throw new Error("runs.max_new_runs_per_version must be a non-negative integer");
    }
    if (typeof result.runs.allow_manual_batch_name !== "boolean" || typeof result.tokens.allow_general_tokens !== "boolean") {
      throw new Error("allow_manual_batch_name and allow_general_tokens must be booleans");
    }
    return result;
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError("policy.invalid", error instanceof Error ? error.message : String(error));
  }
}

export function loadPolicy(): Policy {
  let text: string;
  try {
    text = readFileSync(policyPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parsePolicy(defaultPolicyYaml);
    throw new PolicyError("policy.unreadable", `Cannot read ${policyPath()}`);
  }
  return parsePolicy(text);
}

export function assertTokenPolicy(args: { useGeneralTokens?: unknown }, policy = loadPolicy()): void {
  if (args.useGeneralTokens && !policy.tokens.allow_general_tokens) {
    throw new PolicyError("tokens.allow_general_tokens", "Explicit use of general tokens is disabled by policy");
  }
}

export function assertRunRequest(
  configs: { taskAgentType: string }[],
  batchName: unknown,
  policy = loadPolicy(),
): void {
  if (batchName !== undefined && !policy.runs.allow_manual_batch_name) {
    throw new PolicyError("runs.allow_manual_batch_name", "Manual batch names are disabled by policy");
  }
  const allowed = new Set(policy.runs.allowed_solvers.map((solver) => parseAgentTypeInput(solver)));
  if (!configs.length || configs.some((config) => !allowed.has(parseAgentTypeInput(config.taskAgentType) ?? config.taskAgentType))) {
    throw new PolicyError("runs.allowed_solvers", "The resolved rollout contains a disallowed solver", {
      allowed: policy.runs.allowed_solvers,
      requested: [...new Set(configs.map((config) => config.taskAgentType))],
    });
  }
  if (configs.length > policy.runs.max_new_runs_per_version) {
    throw new PolicyError("runs.max_new_runs_per_version", "Requested runs exceed the version limit", {
      limit: policy.runs.max_new_runs_per_version, requested: configs.length,
    });
  }
}

export function assertRunCapacity(records: unknown, requested: number, policy = loadPolicy()): void {
  // Count every returned record, regardless of verdict, stale or scratched state.
  // The API does not expose reliable original-solution lineage: do not invent it.
  if (!Array.isArray(records) || records.some((run) => !run || typeof run.id !== "string" || !run.id)) {
    throw new PolicyError("runs.state_unavailable", "Cannot determine the existing version run count");
  }
  const existing = new Set(records.map((run) => run.id)).size;
  if (existing + requested > policy.runs.max_new_runs_per_version) {
    throw new PolicyError("runs.max_new_runs_per_version", "New runs would exceed the version limit", {
      existing, requested, limit: policy.runs.max_new_runs_per_version,
    });
  }
}

// Only spending endpoints are guarded; reads, cancellation and editing remain available.
const paidEndpoints = new Set([
  "contributorTokens:runAllChecksWithToken", "dockerImage:buildVersionImage",
  "fairnessContest:contestVerifyFairness", "fpReview:requestFpCheck",
  "orchestratorReview:triggerOrchestratorReview", "reEvalRuns:triggerReEvalRuns",
  "runAgentRuns:triggerAgentRun", "runAgentRuns:triggerRuns",
  "runDynamicChecks:triggerAllDynamicChecks", "runDynamicChecks:triggerDynamicCheck",
  "scopeGate:triggerScopeGate", "solutionQualityContest:contestSolutionQuality",
  "systemComments:contestDescriptionQuality", "taskQualityContest:contestTaskQualityAsMars",
]);

export function assertPaidEndpoint(name: string, args: Record<string, unknown>): void {
  if (paidEndpoints.has(name) || Object.hasOwn(args, "useGeneralTokens")) assertTokenPolicy(args);
}
