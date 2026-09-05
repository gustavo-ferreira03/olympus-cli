import { createHash } from "node:crypto";
import { anyApi } from "convex/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { credentialsDir } from "./auth.ts";
import { parseAgentTypeInput } from "./model.ts";
import { TRIGGERABLE_CHECK_KEYS, toPublicCheckKey, toBackendCheckKey } from "./expected.ts";

export interface Policy {
  runs: {
    max_runs: Partial<Record<"nova" | "vega" | "orion" | "castor", number | null>>;
    allow_full_preset: boolean;
    allow_manual_batch_name: boolean;
    allow_contests: boolean;
    re_evaluation: { enabled: boolean; max_attempts: number | null };
  };
  tokens: {
    allow_general_tokens: boolean;
    max_operation_fraction: number | null;
    min_remaining_balance: number | null;
  };
  checks: {
    allowed: string[];
    require_explicit_selection: boolean;
    max_checks_per_request: number;
    max_active: number | null;
    allow_contests: boolean;
  };
  auto_review: { allow_force_refresh: boolean };
}

export const defaultPolicyYaml = `runs:
  max_runs: {nova: 10, vega: 0, orion: 0, castor: 0} # Maximum current original runs per model
  allow_full_preset: false # Allow the full rollout preset
  allow_manual_batch_name: false # Allow explicit batch names
  allow_contests: false # Allow run contests
  re_evaluation:
    enabled: true # Allow re-evaluating existing solutions
    max_attempts: 1 # Maximum attempts per solution set across challenge versions

tokens:
  allow_general_tokens: false # Allow explicit use of general tokens
  max_operation_fraction: null # Maximum request cost divided by reported balance
  min_remaining_balance: null # Minimum reported balance after request cost

checks:
  allowed: [verifyTests, verifySolution, verifyFlakiness, testQuality, taskQuality, solutionQuality, descriptionQuality, autoReview, verifierIncompleteness] # Allowed dynamic checks
  require_explicit_selection: true # Require explicit check selection
  max_checks_per_request: 3 # Maximum distinct checks submitted together
  max_active: 3 # Maximum active dynamic checks per challenge
  allow_contests: false # Allow check contests

auto_review:
  allow_force_refresh: false # Allow forced reruns of all review dimensions
`;

export class PolicyError extends Error {
  constructor(
    public rule: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

export function policyPath(): string {
  return resolve(credentialsDir(), "policy.yaml");
}

function object(
  value: unknown,
  keys: string[],
  name: string,
): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PolicyError("policy.invalid", `${name} must be a mapping`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key))
      throw new PolicyError("policy.invalid", `Unknown key: ${name}.${key}`);
  }
  return value as Record<string, any>;
}

export function parsePolicy(text: string): Policy {
  try {
    const doc = parseDocument(text, { uniqueKeys: true, merge: false });
    if (doc.errors.length || doc.warnings.length)
      throw new Error(
        [...doc.errors, ...doc.warnings].map((item) => item.message).join("; "),
      );
    const root = object(
      doc.toJS({ maxAliasCount: 0 }),
      ["runs", "tokens", "checks", "auto_review"],
      "policy",
    );
    const group = (key: string, keys: string[]) =>
      object(root[key] === undefined ? {} : root[key], keys, key);
    const runs = group("runs", [
      "max_runs",
      "allow_full_preset",
      "allow_manual_batch_name",
      "allow_contests",
      "re_evaluation",
    ]);
    const tokens = group("tokens", [
      "allow_general_tokens",
      "max_operation_fraction",
      "min_remaining_balance",
    ]);
    const checks = group("checks", [
      "allowed",
      "require_explicit_selection",
      "max_checks_per_request",
      "max_active",
      "allow_contests",
    ]);
    const review = group("auto_review", ["allow_force_refresh"]);
    const reeval = object(runs.re_evaluation === undefined ? {} : runs.re_evaluation, ["enabled", "max_attempts"], "runs.re_evaluation");
    const value = (group: Record<string, any>, key: string, fallback: any) =>
      group[key] === undefined ? fallback : group[key];
    const result: Policy = {
      runs: {
        max_runs: value(runs, "max_runs", {nova: 10, vega: 0, orion: 0, castor: 0}),
        allow_full_preset: value(runs, "allow_full_preset", false),
        allow_manual_batch_name: value(runs, "allow_manual_batch_name", false),
        allow_contests: value(runs, "allow_contests", false),
        re_evaluation: { enabled: value(reeval, "enabled", true), max_attempts: value(reeval, "max_attempts", 1) },
      },
      tokens: {
        allow_general_tokens: value(tokens, "allow_general_tokens", false),
        max_operation_fraction: value(tokens, "max_operation_fraction", null),
        min_remaining_balance: value(tokens, "min_remaining_balance", null),
      },
      checks: {
        allowed: value(checks, "allowed", [...TRIGGERABLE_CHECK_KEYS]),
        require_explicit_selection: value(
          checks,
          "require_explicit_selection",
          true,
        ),
        max_checks_per_request: value(checks, "max_checks_per_request", 3),
        max_active: value(checks, "max_active", 3),
        allow_contests: value(checks, "allow_contests", false),
      },
      auto_review: {
        allow_force_refresh: value(review, "allow_force_refresh", false),
      },
    };
    const caps = object(result.runs.max_runs, ["nova", "vega", "orion", "castor"], "runs.max_runs");
    for (const [model, cap] of Object.entries(caps)) {
      if (cap !== null && (!Number.isSafeInteger(cap) || cap < 0))
        throw new Error(`runs.max_runs.${model} must be null or a non-negative integer`);
    }
    if (
      !Array.isArray(result.checks.allowed) ||
      result.checks.allowed.some(
        (key) => !TRIGGERABLE_CHECK_KEYS.includes(key as any),
      )
    ) {
      throw new Error(
        `checks.allowed must contain public dynamic check keys: ${TRIGGERABLE_CHECK_KEYS.join(", ")}`,
      );
    }
    const integers = {
      "checks.max_checks_per_request": result.checks.max_checks_per_request,
    };
    for (const [key, n] of Object.entries(integers))
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error(`${key} must be a non-negative integer`);
    const attempts = result.runs.re_evaluation.max_attempts;
    if (attempts !== null && (!Number.isSafeInteger(attempts) || attempts < 0)) throw new Error("runs.re_evaluation.max_attempts must be null or a non-negative integer");
    const active = result.checks.max_active;
    if (active !== null && (!Number.isSafeInteger(active) || active < 0))
      throw new Error(
        "checks.max_active must be null or a non-negative integer",
      );
    const fraction = result.tokens.max_operation_fraction;
    if (
      fraction !== null &&
      (typeof fraction !== "number" ||
        !Number.isFinite(fraction) ||
        fraction <= 0 ||
        fraction > 1)
    )
      throw new Error(
        "tokens.max_operation_fraction must be null or a number in (0, 1]",
      );
    const reserve = result.tokens.min_remaining_balance;
    if (
      reserve !== null &&
      (typeof reserve !== "number" || !Number.isFinite(reserve) || reserve < 0)
    )
      throw new Error(
        "tokens.min_remaining_balance must be null or a non-negative number",
      );
    for (const [key, v] of Object.entries({
      "runs.allow_manual_batch_name": result.runs.allow_manual_batch_name,
      "runs.allow_full_preset": result.runs.allow_full_preset,
      "tokens.allow_general_tokens": result.tokens.allow_general_tokens,
      "checks.require_explicit_selection":
        result.checks.require_explicit_selection,
      "auto_review.allow_force_refresh": result.auto_review.allow_force_refresh,
      "runs.re_evaluation.enabled": result.runs.re_evaluation.enabled,
      "checks.allow_contests": result.checks.allow_contests,
      "runs.allow_contests": result.runs.allow_contests,
    }))
      if (typeof v !== "boolean") throw new Error(`${key} must be a boolean`);
    return result;
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError(
      "policy.invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}


export function loadPolicy(): Policy {
  let text: string;
  try {
    text = readFileSync(policyPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return parsePolicy(defaultPolicyYaml);
    throw new PolicyError("policy.unreadable", `Cannot read ${policyPath()}`);
  }
  return parsePolicy(text);
}

export function assertTokenPolicy(
  args: { useGeneralTokens?: unknown },
  policy = loadPolicy(),
): void {
  if (args.useGeneralTokens && !policy.tokens.allow_general_tokens)
    throw new PolicyError(
      "tokens.allow_general_tokens",
      "Explicit use of general tokens is disabled by policy",
    );
}

export function solverName(value: unknown): "nova" | "vega" | "orion" | "castor" | undefined {
  if (typeof value !== "string") return undefined;
  const type = parseAgentTypeInput(value) ?? value;
  const names = {gemini_cli: "nova", claude_code: "vega", codex_cli: "orion", taiga: "castor"} as const;
  return Object.hasOwn(names, type) ? names[type] : undefined;
}

export function runLimit(model: string, policy = loadPolicy()): number {
  const name = solverName(model);
  if (!name) throw new PolicyError("runs.max_runs", "Unknown requested model");
  return policy.runs.max_runs[name] ?? 0;
}

export function assertRunCount(model: string, count: number, policy = loadPolicy()): void {
  const limit = runLimit(model, policy);
  if (count > limit) throw new PolicyError("runs.max_runs", "Requested runs exceed the limit for current inputs", { limit, requested: count });
}

type RunConfig = { taskAgentType: string; evalAgentType: string };
export function assertRunRequest(configs: RunConfig[], batchName: unknown, policy = loadPolicy()): void {
  if (batchName !== undefined && !policy.runs.allow_manual_batch_name)
    throw new PolicyError("runs.allow_manual_batch_name", "Manual batch names are disabled by policy");
  if (!configs.length) throw new PolicyError("runs.max_runs", "At least one run is required");
  assertRunCapacity([], configs, policy);
}

/** Only strict stale:false originals consume the current input quota. */
export function assertRunCapacity(records: unknown, requested: RunConfig[], policy = loadPolicy()): void {
  const unavailable = (message: string): never => { throw new PolicyError("runs.state_unavailable", message); };
  if (!Array.isArray(records)) unavailable("Cannot read current runs");
  const seen = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const run of records as any[]) {
    if (!run || typeof run.stale !== "boolean") unavailable("Run freshness is missing or invalid");
    if (run.stale !== false) continue;
    if (typeof run.id !== "string" || !run.id) unavailable("Current run ID is missing");
    const tagged = typeof run.batchTag === "string" && run.batchTag.startsWith("reeval-");
    const labeled = typeof run.label === "string" && / · re-eval [1-9]\d*$/.test(run.label);
    if (tagged !== labeled) unavailable("Conflicting re-evaluation markers");
    const label = typeof run.label === "string" ? /^(Nova|Vega|Orion|Castor) #[1-9]\d*(?: · re-eval [1-9]\d*)?$/.exec(run.label)?.[1] : undefined;
    const codename = solverName(run.taskAgentCodename), labelModel = solverName(label);
    if (run.taskAgentCodename !== undefined && !codename) unavailable("Unknown public model codename");
    if (codename && labelModel && codename !== labelModel) unavailable("Conflicting public model names");
    const model = codename ?? labelModel ?? solverName(run.taskAgentType);
    if (!model) unavailable("Cannot identify current run model");
    const identity = `${model}:${tagged}`;
    if (seen.has(run.id)) {
      if (seen.get(run.id) !== identity) unavailable("Conflicting duplicate current run");
      continue;
    }
    seen.set(run.id, identity);
    if (!tagged) counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  const requests = new Map<string, number>();
  for (const config of requested) {
    const model = solverName(config.taskAgentType);
    if (!model) throw new PolicyError("runs.max_runs", "Unknown requested model");
    requests.set(model, (requests.get(model) ?? 0) + 1);
  }
  for (const [model, count] of requests) {
    const limit = runLimit(model, policy), existing = counts.get(model) ?? 0;
    if (existing + count > limit) throw new PolicyError("runs.max_runs", "Requested runs exceed the model limit for current inputs", { model, existing, requested: count, limit });
  }
}

export const contestEndpoints = new Set([
  "fairnessContest:contestVerifyFairness",
  "solutionQualityContest:contestSolutionQuality",
  "systemComments:contestDescriptionQuality",
  "taskQualityContest:contestTaskQualityAsMars",
]);
const paidEndpoints = new Set([
  "contributorTokens:runAllChecksWithToken",
  "dockerImage:buildVersionImage",
  "fpReview:requestFpCheck",
  "orchestratorReview:triggerOrchestratorReview",
  "reEvalRuns:triggerReEvalRuns",
  "runAgentRuns:triggerAgentRun",
  "runAgentRuns:triggerRuns",
  "runDynamicChecks:triggerAllDynamicChecks",
  "runDynamicChecks:triggerDynamicCheck",
  "scopeGate:triggerScopeGate",
  ...contestEndpoints,
]);
export function isPolicyEndpoint(
  name: string,
  args: Record<string, unknown>,
): boolean {
  return name === "runAgentRuns:scratchRun" || paidEndpoints.has(name) || Object.hasOwn(args, "useGeneralTokens");
}

export function assertRunPreset(preset: unknown, policy = loadPolicy()): void {
  if (preset === "full" && !policy.runs.allow_full_preset)
    throw new PolicyError(
      "runs.allow_full_preset",
      "The full rollout preset is disabled by policy",
    );
}

export function checkKeysForEndpoint(
  name: string,
  args: Record<string, unknown>,
): string[] {
  if (name === "runDynamicChecks:triggerDynamicCheck") {
    if (typeof args.checkKey !== "string")
      throw new PolicyError(
        "checks.selection_invalid",
        "A check key is required",
      );
    return [toPublicCheckKey(args.checkKey)];
  }
  if (name === "runDynamicChecks:triggerAllDynamicChecks") {
    if (
      !Array.isArray(args.checkKeys) ||
      args.checkKeys.some((key) => typeof key !== "string")
    )
      throw new PolicyError(
        "checks.selection_invalid",
        "An explicit check list is required",
      );
    return [...new Set(args.checkKeys.map(toPublicCheckKey))];
  }
  if (name === "orchestratorReview:triggerOrchestratorReview")
    return ["autoReview"];
  return [];
}

export function assertCheckSelection(
  keys: string[],
  explicit: boolean,
  policy = loadPolicy(),
): void {
  if (!explicit && policy.checks.require_explicit_selection)
    throw new PolicyError(
      "checks.require_explicit_selection",
      "Select checks explicitly with --checks",
    );
  if (!keys.length)
    throw new PolicyError(
      "checks.selection_invalid",
      "Select at least one check",
    );
  const unique = [...new Set(keys.map(toPublicCheckKey))];
  if (unique.some((key) => !policy.checks.allowed.includes(key)))
    throw new PolicyError(
      "checks.allowed",
      "The request contains a disallowed check",
      { allowed: policy.checks.allowed, requested: unique },
    );
  if (unique.length > policy.checks.max_checks_per_request)
    throw new PolicyError(
      "checks.max_checks_per_request",
      "Too many checks in one request",
      { requested: unique.length, limit: policy.checks.max_checks_per_request },
    );
}

export function assertPaidEndpoint(
  name: string,
  args: Record<string, unknown>,
  policy?: Policy,
): void {
  if (!isPolicyEndpoint(name, args)) return;
  const effective = policy ?? loadPolicy();
  assertTokenPolicy(args, effective);
  if (name === "runAgentRuns:scratchRun" && args.scratched !== false && !effective.runs.allow_contests)
    throw new PolicyError("runs.allow_contests", "Run contests are disabled by policy");
  if (contestEndpoints.has(name) && !effective.checks.allow_contests)
    throw new PolicyError(
      "checks.allow_contests",
      "Check contests are disabled by policy",
    );
  if (
    name === "reEvalRuns:triggerReEvalRuns" &&
    !effective.runs.re_evaluation.enabled
  )
    throw new PolicyError(
      "runs.re_evaluation.enabled",
      "Re-evaluation is disabled by policy",
    );
  const keys = checkKeysForEndpoint(name, args);
  if (keys.length) assertCheckSelection(keys, true, effective);
  if (
    name === "orchestratorReview:triggerOrchestratorReview" &&
    args.forceFresh &&
    !effective.auto_review.allow_force_refresh
  )
    throw new PolicyError(
      "auto_review.allow_force_refresh",
      "Forced fresh Auto Review is disabled; resume without --force-fresh",
    );
}

// Live cost and capacity guards
// Read-only, live preflights. No local ledger/cache and no claim of atomic reservation.
const api = anyApi;
type Reader = { query: (reference: any, args: any) => Promise<any> };
const record = (value: any): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;

// These are the exact quick-run keys supported in runs.ts, not a tariff fallback.
const quickSolvers: Record<string, string> = {
  vegaVega: "claude_code", vegaOrion: "claude_code",
  orionVega: "codex_cli", orionOrion: "codex_cli",
  novaVega1: "gemini_cli", novaOrion1: "gemini_cli",
  castorVega1: "taiga", castorOrion1: "taiga",
};

async function quoteCost(client: Reader, name: string, args: Record<string, any>): Promise<number | undefined> {
  if (name === "reEvalRuns:triggerReEvalRuns") {
    const offer = await client.query(api.reEvalRuns.getReEvalOffer, { versionId: args.versionId });
    return offer?.eligible === true && amount(offer.tokenCost) ? offer.tokenCost : undefined;
  }
  if (name === "fpReview:requestFpCheck") {
    const offer = await client.query(api.fpReview.getFpCheckForVersion, { versionId: args.versionId });
    return amount(offer?.tokenCost) ? offer.tokenCost : undefined;
  }
  const isRun = name === "runAgentRuns:triggerRuns" || name === "runAgentRuns:triggerAgentRun";
  const keys = checkKeysForEndpoint(name, args);
  if (!isRun && !keys.length) return undefined;
  const config = await client.query(api.questConfig.getConfig, { slug: "olympus" });
  let prices: unknown[];
  if (isRun) {
    const solvers = name === "runAgentRuns:triggerAgentRun"
      ? [Object.hasOwn(quickSolvers, args.agentRunKey) ? quickSolvers[args.agentRunKey] : undefined]
      : Array.isArray(args.configs) && args.configs.length
        ? args.configs.map((item: any) => typeof item?.taskAgentType === "string" ? (parseAgentTypeInput(item.taskAgentType) ?? item.taskAgentType) : undefined)
        : [undefined];
    const pricing = config?.agentRunPricing;
    prices = solvers.map((solver) => solver && record(pricing) && Object.hasOwn(pricing, solver) ? pricing[solver] : undefined);
  } else {
    const overrides = config?.checkTokenCostOverrides;
    prices = keys.map((key) => {
      const backendKey = toBackendCheckKey(key);
      if (!record(overrides)) return undefined;
      // Sparse overrides are the only known tariff. Never invent a default price.
      if (Object.hasOwn(overrides, backendKey)) return overrides[backendKey];
      if (Object.hasOwn(overrides, key)) return overrides[key];
      return undefined;
    });
  }
  if (!prices.every(amount)) return undefined;
  const total = (prices as number[]).reduce((sum, price) => sum + price, 0);
  return amount(total) ? total : undefined;
}

export async function assertOperationCost(
  client: Reader, name: string, args: Record<string, any>, policy?: Policy,
): Promise<void> {
  // Scratching/restoring a run changes metadata, not token spending.
  if (name === "runAgentRuns:scratchRun" || !isPolicyEndpoint(name, args)) return;
  const effective = policy ?? loadPolicy();
  const { max_operation_fraction: fraction, min_remaining_balance: reserve } = effective.tokens;
  if (fraction === null && reserve === null) return;
  let cost: number | undefined;
  try { cost = await quoteCost(client, name, args); }
  catch { cost = undefined; }
  if (cost === undefined) {
    throw new PolicyError("tokens.cost_unavailable", "Cannot establish a prospective cost for this operation", { endpoint: name });
  }
  let balance: unknown;
  try { balance = (await client.query(api.contributorTokens.getBalance, {}))?.balance; }
  catch { /* A failed read is never a zero balance. */ }
  if (!amount(balance)) throw new PolicyError("tokens.balance_unavailable", "Cannot establish the reported token balance");
  if (fraction !== null && cost > balance * fraction)
    throw new PolicyError("tokens.max_operation_fraction", "Operation exceeds the allowed fraction of reported balance", { cost, balance, limit: fraction });
  // Conservatively subtract the entire quote, ignoring any revision-token coverage.
  if (reserve !== null && balance - cost < reserve)
    throw new PolicyError("tokens.min_remaining_balance", "Operation would breach the minimum remaining balance", { cost, balance, limit: reserve });
}

const activeStatuses = new Set(["pending", "running", "queued", "processing"]);
const inactiveStatuses = new Set(["completed", "failed", "error", "cancelled", "canceled", "not_started", "idle"]);
function stateError(): never {
  throw new PolicyError("checks.state_unavailable", "Cannot establish active checks across all challenge versions");
}
function activeJob(value: any): string | undefined {
  if (!record(value) || typeof value.status !== "string") return stateError();
  const status = value.status.toLowerCase();
  if (!activeStatuses.has(status) && !inactiveStatuses.has(status)) return stateError();
  if (!activeStatuses.has(status)) return undefined;
  if (!id(value.jobId)) return stateError();
  // Stale still-running jobs consume capacity; they are not evidence of a fresh result.
  return value.jobId;
}

export async function assertCheckCapacity(
  client: Reader, problemId: string, versionId: string, requestedKeys: string[], policy = loadPolicy(),
): Promise<void> {
  const limit = policy.checks.max_active;
  if (limit === null) return;
  if (!Array.isArray(requestedKeys) || !requestedKeys.length || requestedKeys.some((key) =>
    typeof key !== "string" || !TRIGGERABLE_CHECK_KEYS.includes(toPublicCheckKey(key) as any)))
    throw new PolicyError("checks.selection_invalid", "Capacity requires explicit known check keys");
  const requested = new Set(requestedKeys.map(toPublicCheckKey)).size;
  try {
    const versions = await client.query(api.problems.listVersions, { problemId });
    if (!Array.isArray(versions) || versions.some((version) => !record(version) || !id(version._id)) ||
      !versions.some((version) => version._id === versionId)) return stateError();
    const jobs = new Set<string>();
    let reviews: Set<string>[] = [];
    for (const currentVersion of new Set<string>(versions.map((version) => version._id))) {
      const [dynamic, review] = await Promise.all([
        client.query(api.runDynamicChecks.getDynamicChecks, { versionId: currentVersion }),
        client.query(api.orchestratorReview.getOrchestratorReview, { versionId: currentVersion }),
      ]);
      if (!record(dynamic) || !record(review) || !record(review.slots)) return stateError();
      const orchestration = new Set<string>();
      for (const [key, value] of Object.entries(dynamic)) {
        if (key.startsWith("_")) continue;
        // Historical/stored checks also occupy capacity, even if no longer triggerable.
        if (value === null) continue; // Explicit absent check, unlike missing response.
        const job = activeJob(value);
        // A legacy autoReview job is separate unless a slot proves the same ID.
        if (job) jobs.add(job);
      }
      for (const [key, slot] of Object.entries(review.slots)) {
        if (!["description", "tests", "solution", "agents", "gate", "synthesis"].includes(key)) return stateError();
        if (slot === null) continue;
        const job = activeJob(slot);
        if (job) orchestration.add(job);
      }
      if (orchestration.size) {
        // Merge overlapping current job snapshots, counting one logical review,
        // not each of its five slots (or a duplicate dynamic autoReview entry).
        let merged = orchestration;
        let changed = true;
        while (changed) {
          changed = false;
          reviews = reviews.filter((previous) => {
            if (![...previous].some((job) => merged.has(job))) return true;
            for (const job of previous) merged.add(job);
            changed = true;
            return false;
          });
        }
        reviews.push(merged);
      }
    }
    for (const review of reviews) for (const job of review) jobs.delete(job);
    const existing = jobs.size + reviews.length;
    if (existing + requested > limit)
      throw new PolicyError("checks.max_active", "Requested checks would exceed challenge active capacity", { existing, requested, limit });
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    return stateError();
  }
}

// Remote re-evaluation history and limits
interface HistoryRun {
  id: string;
  jobId: string;
  label: string;
  taskAgentType: string;
  batchTag?: string;
}
export interface CandidateSet {
  fingerprint: string;
  candidateCount: number;
  originalBatches: string[];
  reevaluationBatches: string[];
  attempts: number;
}
export interface ReevaluationHistory {
  candidateSets: CandidateSet[];
  unresolvedBatches: { batchTag: string; reason: string }[];
}
const unavailable = (message: string) => new PolicyError("runs.re_evaluation.state_unavailable", message);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Patch-content identity, not a solver-input or evaluator-input fingerprint. */
export async function groupReevaluationHistory(
  records: unknown,
  patchHash: (run: HistoryRun) => Promise<string>,
): Promise<ReevaluationHistory> {
  if (!Array.isArray(records)) throw unavailable("Run history is not an array");
  const batches = new Map<string, { reevaluation: boolean; round: number; runs: HistoryRun[]; labels: Set<string> }>();
  const seen = new Map<string, string>();
  for (const r of records) {
    if (!r || typeof r.id !== "string" || !r.id || typeof r.jobId !== "string" || !r.jobId || typeof r.label !== "string") throw unavailable("Run history lacks IDs, jobs or labels");
    const label = /^(Nova|Vega|Orion|Castor) #[1-9]\d*(?: · re-eval ([1-9]\d*))?$/.exec(r.label);
    // Historical runner types can differ from the public solver codename.
    // The backend's public codename/label identifies the candidate's solver.
    const solver = label ? parseAgentTypeInput(label[1]) : undefined;
    if (!label || !solver || (r.taskAgentCodename !== undefined && r.taskAgentCodename !== label[1])) throw unavailable(`Unrecognized solver or label for run ${r.id}`);
    if (r.batchTag !== undefined && (typeof r.batchTag !== "string" || !r.batchTag)) throw unavailable(`Invalid batch tag for run ${r.id}`);
    const reevaluation = Boolean(label[2]);
    if (reevaluation !== Boolean(r.batchTag?.startsWith("reeval-"))) throw unavailable(`Conflicting re-evaluation markers for run ${r.id}`);
    const round = Number(label[2] ?? 0);
    if (!Number.isSafeInteger(round)) throw unavailable(`Invalid re-evaluation round for run ${r.id}`);
    const tag = r.batchTag ?? `original:${r.id}`;
    const identity = JSON.stringify([r.jobId, r.label, solver, tag]);
    if (seen.has(r.id)) {
      if (seen.get(r.id) !== identity) throw unavailable(`Conflicting snapshots for run ${r.id}`);
      continue;
    }
    seen.set(r.id, identity);
    const group = batches.get(tag) ?? { reevaluation, round, runs: [], labels: new Set<string>() };
    if (group.reevaluation !== reevaluation || group.round !== round || group.labels.has(r.label)) throw unavailable(`Inconsistent batch ${tag}`);
    group.labels.add(r.label);
    group.runs.push({ id: r.id, jobId: r.jobId, label: r.label, taskAgentType: solver, batchTag: r.batchTag });
    batches.set(tag, group);
  }
  const sets = new Map<string, CandidateSet>();
  const unresolvedBatches: ReevaluationHistory["unresolvedBatches"] = [];
  for (const [tag, batch] of batches) {
    const members: string[] = [];
    // Bound request concurrency and retain only digests, never patch contents.
    try {
      for (const run of batch.runs) {
        const hash = await patchHash(run);
        if (!/^[a-f0-9]{64}$/.test(hash)) throw unavailable(`Invalid patch digest for run ${run.id}`);
        members.push(`${run.taskAgentType}:${hash}`);
      }
    } catch {
      unresolvedBatches.push({ batchTag: tag, reason: "Solution patches are unavailable or incomplete" });
      continue;
    }
    const fingerprint = digest(JSON.stringify(members.sort()));
    const set = sets.get(fingerprint) ?? { fingerprint, candidateCount: members.length, originalBatches: [], reevaluationBatches: [], attempts: 0 };
    (batch.reevaluation ? set.reevaluationBatches : set.originalBatches).push(tag);
    if (batch.reevaluation) set.attempts += 1;
    sets.set(fingerprint, set);
  }
  for (const set of sets.values()) {
    if (!set.originalBatches.length) for (const batchTag of set.reevaluationBatches) unresolvedBatches.push({ batchTag, reason: "No matching original solution set" });
    set.originalBatches.sort();
    set.reevaluationBatches.sort();
  }
  return { candidateSets: [...sets.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)), unresolvedBatches };
}

async function readHistory(client: any, problemId: string, versionId: string): Promise<any[]> {
  try {
    const versions = await client.query(api.problems.listVersions, { problemId });
    if (!Array.isArray(versions) || versions.some(v => !v || typeof v._id !== "string") || !versions.some(v => v._id === versionId)) throw unavailable("Cannot enumerate challenge versions");
    const records: any[] = [];
    for (const id of new Set(versions.map(v => v._id))) {
      const rows = await client.query(api.runAgentRuns.getAgentRuns, { versionId: id });
      if (!Array.isArray(rows)) throw unavailable("Cannot enumerate version run history");
      records.push(...rows);
    }
    return records;
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw unavailable("Could not read complete challenge run history");
  }
}

async function remotePatchHash(client: any, run: HistoryRun): Promise<string> {
  try {
    const url = await client.action(api.artifactProxy.fetchArtifact, { jobId: run.jobId, artifactKey: "solutionPatch" });
    if (typeof url !== "string" || new URL(url).protocol !== "https:") throw new Error("Invalid artifact URL");
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error("Artifact unavailable");
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 16 * 1024 * 1024) throw new Error("Artifact too large");
        hash.update(chunk.value);
      }
    } finally { await reader.cancel(); }
    if (!bytes) throw new Error("Empty artifact cannot establish source identity");
    return hash.digest("hex");
  } catch {
    // Do not leak signed artifact URLs through network errors.
    throw unavailable(`Cannot fingerprint solutionPatch for run ${run.id}`);
  }
}

export async function inspectReevaluationHistory(client: any, problemId: string, versionId: string): Promise<ReevaluationHistory> {
  return groupReevaluationHistory(await readHistory(client, problemId, versionId), run => remotePatchHash(client, run));
}

export function assertReevaluationAttempts(sets: CandidateSet[], runCount: unknown, limit: number): void {
  if (!Number.isSafeInteger(runCount) || (runCount as number) < 1) throw unavailable("Re-evaluation offer lacks a valid candidate count");
  const possible = sets.filter(set => set.candidateCount === runCount);
  if (!possible.length) throw unavailable("No complete original set matches the offered candidate count");
  const exhausted = possible.filter(set => set.attempts >= limit);
  if (!exhausted.length) return; // Every possible source fits; choosing one is unnecessary.
  if (possible.length > 1) throw new PolicyError("runs.re_evaluation.source_ambiguous", "The backend does not identify the source set, and a possible source has exhausted its limit", { limit, possibleSets: possible.length, exhaustedSets: exhausted.length });
  throw new PolicyError("runs.re_evaluation.max_attempts", "The solution set has exhausted its re-evaluation limit", { limit, existing: possible[0].attempts, fingerprint: possible[0].fingerprint });
}

const historySignature = (records: any[]) => digest(JSON.stringify(records.map(r => [r?.id, r?.jobId, r?.label, r?.batchTag, r?.taskAgentType, r?.scratched]).map(r => JSON.stringify(r)).sort()));

export async function assertRemoteReevaluationAttempts(client: any, problemId: string, versionId: string, policy: Policy = loadPolicy()): Promise<void> {
  const limit = policy.runs.re_evaluation.max_attempts;
  if (limit === null) return;
  if (limit === 0) throw new PolicyError("runs.re_evaluation.max_attempts", "Re-evaluation attempts are disabled by policy", { limit });
  const before = await readHistory(client, problemId, versionId);
  const history = await groupReevaluationHistory(before, run => remotePatchHash(client, run));
  if (history.unresolvedBatches.length) throw new PolicyError("runs.re_evaluation.state_unavailable", "Cannot enforce the limit with incomplete solution-patch history", { unresolvedBatches: history.unresolvedBatches });
  const [offer, after] = await Promise.all([
    client.query(api.reEvalRuns.getReEvalOffer, { versionId }),
    readHistory(client, problemId, versionId),
  ]);
  if (!offer?.eligible || historySignature(before) !== historySignature(after)) throw unavailable("Re-evaluation offer or history changed during preflight; inspect again before retrying");
  assertReevaluationAttempts(history.candidateSets, offer.runCount, limit);
}
