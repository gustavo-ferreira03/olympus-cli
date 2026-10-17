import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { anyApi } from "convex/server";
import { queryPrecheckStages } from "../platform/prechecks.ts";
import { toPublicCheckKey } from "./expected.ts";
import { enrichCheckResults } from "./check-inputs.ts";
import { rememberReEvaluationOffer } from "./reeval-offer.ts";

import { POLICY_ACTIONS, type PolicyAction, actionCliArguments } from "./action-catalog.ts";

const api = anyApi;
export { POLICY_ACTIONS, type PolicyAction };

export type PolicyMode = "off" | "advise" | "enforce";
export type Predicate = {
  path: string;
  equals?: string | number | boolean | null;
  empty?: boolean;
  exists?: boolean;
  greater_than?: number;
  at_least?: number;
  less_than?: number;
};
export type ResultProfile = { check: string | null; all: Predicate[] };
export type PolicyTransition = { action: PolicyAction | null; all: Predicate[] };
export type PolicyNode = {
  enforce?: boolean;
  unless?: Predicate[][];
  requires_when?: Predicate[];
  arguments?: Record<string, string | number | boolean | string[]>;
  requires: string[];
  on_unmet: PolicyAction | null;
  next: PolicyTransition[];
};
export type PolicyNote = {
  id: string;
  when: { check: string | null; all: Predicate[] };
  severity: "info" | "warning" | "error";
  message: string;
  requires_ack?: boolean;
};
export type PolicyGraph = {
  mode: PolicyMode;
  confirmation: { method: "token"; expires_after: string } | null;
  gates: Record<string, ResultProfile>;
  repair_first?: string[];
  rules?: string[];
  actions: Partial<Record<PolicyAction, PolicyNode>>;
  notes: PolicyNote[];
} | null;

const feedbackRecord = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const shell = (args: string[]) => args.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
export function summarizePrecheckHistory(raw: unknown): {
  neverRun: boolean | null;
  lastRunFailed: boolean | null;
} {
  const unknown = { neverRun: null, lastRunFailed: null };
  if (!Array.isArray(raw)) return unknown;
  if (raw.length === 0) return { neverRun: true, lastRunFailed: false };
  const latest = new Map<string, any>();
  for (const stage of raw) {
    if (
      !stage
      || typeof stage.stageId !== "string"
      || typeof stage._creationTime !== "number"
      || !Number.isFinite(stage._creationTime)
      || typeof stage.status !== "string"
    )
      return unknown;
    const previous = latest.get(stage.stageId);
    if (!previous || stage._creationTime > previous._creationTime) latest.set(stage.stageId, stage);
    else if (stage._creationTime === previous._creationTime && stage._id !== previous._id)
      return unknown;
  }
  const stages = [...latest.values()];
  const terminal = new Set(["pass", "warning", "fail", "error", "missing_fields", "skipped"]);
  if (stages.some((stage) => stage.stale === true || !terminal.has(stage.status)))
    return { neverRun: false, lastRunFailed: null };
  return {
    neverRun: false,
    lastRunFailed: stages.some(
      (stage) =>
        ["fail", "error", "missing_fields"].includes(stage.status)
        || (Array.isArray(stage.checks)
          && stage.checks.some((check: any) => ["fail", "error"].includes(check?.status))),
    ),
  };
}

export function policyDecisionFeedback(
  decision: PolicyDecision,
  state: Pick<PolicyState, "checks"> = { checks: undefined },
) {
  const brief = (value: unknown): unknown => {
    if (Array.isArray(value)) return { count: value.length };
    if (value !== null && typeof value === "object") return { fields: Object.keys(value).length };
    if (typeof value === "string" && value.length > 120) return `${value.slice(0, 117)}...`;
    return value;
  };
  const failures = decision.unmetRequirements.map((requirement) => {
    const check = feedbackRecord(
      Object.entries(feedbackRecord(state.checks)).find(
        ([candidateKey]) => toPublicCheckKey(candidateKey) === requirement.check,
      )?.[1],
    );
    const unknown = requirement.reason.startsWith("missing_") || requirement.actual == null;
    let reason: string = requirement.reason;
    if (unknown && requirement.path.startsWith("checkInputs.")) reason = "input_hashes_unavailable";
    else if (unknown && requirement.path.startsWith("output.coverageSummary.")) {
      const gap = requirement.path.endsWith("untestedGapCount");
      const diagnostic = check.output?.coverageDiagnostics?.find(
        (item: any) =>
          typeof item.code === "string"
          && item.code.startsWith(gap ? "coverage.suggestions_" : "coverage.requirements_"),
      );
      reason = diagnostic?.code ?? "coverage_unknown";
    }
    return {
      profile: requirement.profile,
      check: requirement.check,
      path: requirement.path,
      expected: requirement.expected,
      actual: unknown ? "unknown" : brief(requirement.actual),
      reason,
    };
  });
  let next: Record<string, unknown> = {};
  if (decision.recommendedCommand) next = { next: decision.recommendedCommand };
  else if (decision.recommendedAction) next = { nextAction: decision.recommendedAction };
  const feedback = {
    source: "policy",
    dispatched: false,
    action: decision.action,
    mode: decision.mode,
    failures,
    ...next,
    ...(decision.mode === "advise" && decision.confirmation
      ? {
          confirmation: {
            expiresAt: decision.confirmation.expiresAt,
            ...(decision.cliContinuation.command
              ? {
                  command: [
                    ...decision.cliContinuation.command,
                    ...decision.cliContinuation.append,
                  ],
                }
              : { append: decision.cliContinuation.append }),
          },
        }
      : {}),
  };
  const lines = [`Blocked: ${decision.action} (${decision.mode}; not dispatched)`];
  const conditionText = (expected: Record<string, any>): string => {
    if (Object.hasOwn(expected, "at_most")) return `<= ${expected.at_most}`;
    if (Object.hasOwn(expected, "one_of")) return `one of ${JSON.stringify(expected.one_of)}`;
    if (Object.hasOwn(expected, "at_least")) return `>= ${expected.at_least}`;
    if (Object.hasOwn(expected, "less_than")) return `< ${expected.less_than}`;
    if (Object.hasOwn(expected, "greater_than")) return `> ${expected.greater_than}`;
    if (Object.hasOwn(expected, "empty")) return expected.empty ? "empty" : "non-empty";
    return `= ${JSON.stringify(expected.equals)}`;
  };
  for (const failure of failures) {
    const expected = feedbackRecord(failure.expected);
    const condition = conditionText(expected);
    lines.push(
      `${failure.profile}: ${failure.path} ${JSON.stringify(failure.actual)}; need ${condition}${failure.actual === "unknown" ? ` (${failure.reason})` : ""}`,
    );
  }
  if (decision.recommendedCommand) lines.push(`Policy next: ${shell(decision.recommendedCommand)}`);
  if (feedback.confirmation) {
    const continuation =
      "command" in feedback.confirmation
        ? feedback.confirmation.command
        : feedback.confirmation.append;
    lines.push(`Confirm until ${feedback.confirmation.expiresAt}: ${shell(continuation ?? [])}`);
  }
  return { feedback, message: lines.join("\n") };
}

export type PolicyRequirement = {
  profile: string;
  check: string | null;
  path: string;
  expected: unknown;
  actual: unknown;
  reason:
    | "missing_check"
    | "missing_profile"
    | "missing_field"
    | "predicate_failed"
    | "action_not_recommended";
};
export type PolicyDecision = {
  rule?: string;
  status: "off" | "allowed" | "confirmation_required" | "blocked";
  mode: PolicyMode;
  challengeId: string;
  action: PolicyAction;
  recommendedAction: PolicyAction | null;
  fingerprint: string;
  unmetRequirements: PolicyRequirement[];
  notes: Array<{ id: string; severity: PolicyNote["severity"]; message: string }>;
  confirmation?: { method: "token"; token: string; expiresAt: string };
  recommendedCommand?: string[] | null;
  recommendationError?: string;
  cliContinuation: { command: string[] | null; append: string[] };
};

type Reader = { query: (reference: any, args: any) => Promise<any> };
export type PolicyState = {
  challengeId: string;
  problem: unknown;
  version: unknown;
  versionId: string;
  prechecks: unknown;
  reEvaluation?: unknown;
  reEvaluationOfferSeenAt?: number | null;
  prechecksSummary?: { neverRun: boolean | null; lastRunFailed: boolean | null };
  checks: unknown;
  readiness: unknown;
  image: unknown;
  build: unknown;
  scopeGate: unknown;
  runs: unknown;
  rolloutCriteria: unknown;
  fpCheck: unknown;
  autoReview: unknown;
};

let invocation: { confirmation?: string; authorization?: string; command?: string[] } = {};
export function setPolicyInvocation(value: {
  confirmation?: string;
  authorization?: string;
  command?: string[];
}): void {
  invocation = {
    confirmation: value.confirmation,
    authorization: value.authorization,
    command: value.command ? [...value.command] : undefined,
  };
}
export function policyInvocation(): {
  confirmation?: string;
  authorization?: string;
  command?: string[];
} {
  return {
    confirmation: invocation.confirmation,
    authorization: invocation.authorization,
    command: invocation.command ? [...invocation.command] : undefined,
  };
}

const endpointActions: Record<string, PolicyAction> = {
  "problems:updateDraft": "artifacts.update",
  "problems:createVersionFromPrevious": "artifacts.update",
  "problems:startEditVersion": "artifacts.update",
  "problems:snapshotVersion": "artifacts.update",
  "problems:unsnapshotVersion": "artifacts.update",
  "dockerImage:buildVersionImage": "image.build",
  "contributorTokens:runAllChecksWithToken": "prechecks.run",
  "scopeGate:triggerScopeGate": "scope_gate.run",
  "runDynamicChecks:triggerAllDynamicChecks": "checks.run_all",
  "runAgentRuns:triggerAgentRun": "rollouts.run",
  "runAgentRuns:triggerRuns": "rollouts.run",
  "reEvalRuns:triggerReEvalRuns": "re_evaluation.run",
  "fpReview:requestFpCheck": "fp_check.run",
  "verifierIncompleteness:submitVerifierIncompletenessDecision": "verifier_audit.decide",
  "orchestratorReview:triggerOrchestratorReview": "auto_review.orchestrate",
  "problems:submitDraft": "submission.submit",
};

export function policyActionForEndpoint(
  name: string,
  args: Record<string, unknown>,
): PolicyAction | undefined {
  if (name === "runDynamicChecks:triggerDynamicCheck") {
    const checkKey = typeof args.checkKey === "string" ? toPublicCheckKey(args.checkKey) : "";
    const candidate = `checks.${checkKey}`;
    return POLICY_ACTIONS.includes(candidate as PolicyAction)
      ? (candidate as PolicyAction)
      : undefined;
  }
  return endpointActions[name];
}

function stable(value: unknown): string {
  if (value === undefined) return '"[undefined]"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as object)
    .toSorted()
    .map((propertyKey) => `${JSON.stringify(propertyKey)}:${stable((value as any)[propertyKey])}`)
    .join(",")}}`;
}

export function policyFingerprint(state: unknown): string {
  return createHash("sha256").update(stable(state)).digest("hex");
}

export async function readPolicyState(client: Reader, challengeId: string): Promise<PolicyState> {
  const first = await client.query(api.problems.getWithLatestVersion, { problemId: challengeId });
  const version = first?.latestVersion;
  if (!version?._id) throw new Error(`No current version found for challenge ${challengeId}`);
  const versionId = version._id;
  const [
    prechecks,
    checks,
    readiness,
    image,
    build,
    scopeGate,
    runs,
    rolloutCriteria,
    fpCheck,
    autoReview,
    reEvaluation,
  ] = await Promise.all([
    queryPrecheckStages(client, { problemId: challengeId, versionId }),
    client.query(api.runDynamicChecks.getDynamicChecks, { versionId }),
    client.query(api.submissionReadiness.getSubmissionReadiness, { problemId: challengeId }),
    client.query(api.dockerImage.getImageStatus, { versionId }),
    client.query(api.dockerImage.getLatestBuildJobForVersion, { versionId }),
    client.query(api.scopeGate.getScopeGate, { versionId }),
    client.query(api.runAgentRuns.getAgentRuns, { versionId }),
    client.query(api.runAgentRuns.getAgentRunCriteria, { versionId }),
    client.query(api.fpReview.getFpCheckForVersion, { versionId }),
    client.query(api.orchestratorReview.getOrchestratorReview, { versionId }),
    client.query(api.reEvalRuns.getReEvalOffer, { versionId }),
  ]);
  const confirm = await client.query(api.problems.getWithLatestVersion, { problemId: challengeId });
  if (confirm?.latestVersion?._id !== versionId)
    throw new Error("Version changed while reading graph state; retry");
  return {
    challengeId,
    problem: first,
    version,
    versionId,
    prechecks,
    reEvaluation,
    reEvaluationOfferSeenAt: rememberReEvaluationOffer(versionId, reEvaluation),
    prechecksSummary:
      Array.isArray(prechecks) && prechecks.length === 0 && version.version !== 0
        ? { neverRun: null, lastRunFailed: null }
        : summarizePrecheckHistory(prechecks),
    checks: enrichCheckResults(checks, version),
    readiness,
    image,
    build,
    scopeGate,
    runs,
    rolloutCriteria,
    fpCheck,
    autoReview,
  };
}

export async function readStablePolicyState(
  client: Reader,
  challengeId: string,
): Promise<PolicyState> {
  const first = await readPolicyState(client, challengeId);
  const second = await readPolicyState(client, challengeId);
  if (policyFingerprint(first) !== policyFingerprint(second))
    throw new Error("Canonical graph state changed while it was being read; retry");
  return second;
}

function valueAt(root: unknown, path: string): { found: boolean; value: unknown } {
  if (
    !path
    || path
      .split(".")
      .some(
        (part) => !part || part === "__proto__" || part === "prototype" || part === "constructor",
      )
  )
    return { found: false, value: undefined };
  let value: any = root;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part))
      return { found: false, value: undefined };
    value = value[part];
  }
  return { found: true, value };
}

function empty(value: unknown): boolean {
  return (
    value === ""
    || (Array.isArray(value) && value.length === 0)
    || (!!value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).length === 0)
  );
}

export function evaluatePredicate(
  root: unknown,
  predicate: Predicate,
): {
  pass: boolean;
  actual: unknown;
  expected: unknown;
  reason?: "missing_field" | "predicate_failed";
} {
  const selected = valueAt(root, predicate.path);
  let expected: Record<string, unknown>;
  if (Object.hasOwn(predicate, "equals")) expected = { equals: predicate.equals };
  else if (Object.hasOwn(predicate, "empty")) expected = { empty: predicate.empty };
  else if (Object.hasOwn(predicate, "at_least")) expected = { at_least: predicate.at_least };
  else if (Object.hasOwn(predicate, "less_than")) expected = { less_than: predicate.less_than };
  else expected = { greater_than: predicate.greater_than };
  if (Object.hasOwn(predicate, "exists"))
    return {
      pass: selected.found === predicate.exists,
      actual: selected.found,
      expected: { exists: predicate.exists },
      ...(selected.found === predicate.exists ? {} : { reason: "predicate_failed" as const }),
    };
  if (!selected.found) return { pass: false, actual: null, expected, reason: "missing_field" };
  let pass = false;
  if (Object.hasOwn(predicate, "equals"))
    pass = stable(selected.value) === stable(predicate.equals);
  else if (Object.hasOwn(predicate, "empty")) pass = empty(selected.value) === predicate.empty;
  else if (Object.hasOwn(predicate, "at_least"))
    pass =
      typeof selected.value === "number"
      && Number.isFinite(selected.value)
      && typeof predicate.at_least === "number"
      && Number.isFinite(predicate.at_least)
      && selected.value >= predicate.at_least;
  else if (Object.hasOwn(predicate, "less_than"))
    pass =
      typeof selected.value === "number"
      && Number.isFinite(selected.value)
      && typeof predicate.less_than === "number"
      && Number.isFinite(predicate.less_than)
      && selected.value < predicate.less_than;
  else
    pass =
      typeof selected.value === "number"
      && Number.isFinite(selected.value)
      && selected.value > (predicate.greater_than as number);
  return { pass, actual: selected.value, expected, reason: pass ? undefined : "predicate_failed" };
}

function checkResult(state: Pick<PolicyState, "checks">, checkKey: string): any {
  const checks =
    state.checks && typeof state.checks === "object" && !Array.isArray(state.checks)
      ? (state.checks as Record<string, any>)
      : {};
  const publicKey = toPublicCheckKey(checkKey);
  for (const candidate of [checkKey, publicKey]) {
    if (Object.hasOwn(checks, candidate)) return checks[candidate];
  }
  const storedKey = Object.keys(checks).find(
    (candidate) => toPublicCheckKey(candidate) === publicKey,
  );
  if (storedKey) return checks[storedKey];
  return undefined;
}

function activeStatus(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = String((value as Record<string, unknown>).status ?? "").toLowerCase();
  return ["pending", "queued", "running", "in_progress"].includes(status) ? status : null;
}

function actionInFlightStatus(
  state: PolicyState,
  graph: NonNullable<PolicyGraph>,
  action: PolicyAction,
): string | null {
  if (action === "checks.autoReview") {
    // A running review shows in its orchestration slots before the check record updates.
    const slots = feedbackRecord(feedbackRecord(state.autoReview).slots);
    for (const slot of Object.values(slots)) {
      const record = feedbackRecord(slot);
      const status = record.stale === true ? null : activeStatus(record);
      if (status) return status;
    }
  }
  if (action.startsWith("checks.") && action !== "checks.run_all")
    return activeStatus(checkResult(state, action.slice("checks.".length)));
  if (action === "checks.run_all") {
    const checks = graph.actions[action]?.arguments?.checks;
    if (!Array.isArray(checks)) return null;
    for (const checkKey of checks) {
      if (typeof checkKey !== "string") continue;
      const status = activeStatus(checkResult(state, checkKey));
      if (status) return `${checkKey}:${status}`;
    }
    return null;
  }
  if (action === "prechecks.run") {
    const readiness = feedbackRecord(state.readiness);
    const criteria = Array.isArray(readiness.criteria) ? readiness.criteria : [];
    const prechecks = criteria.find((criterion) => feedbackRecord(criterion).id === "prechecks");
    const status = activeStatus(prechecks);
    // Readiness reports never-started prechecks (a draft before its first upload) as "pending" with
    // "not run yet"; no job exists, so treating it as in flight would leave the graph waiting forever.
    if (status === "pending" && /not run yet/i.test(String(feedbackRecord(prechecks).detail ?? "")))
      return null;
    return status;
  }
  if (action === "scope_gate.run")
    return feedbackRecord(state.scopeGate).inFlight === true ? "running" : null;
  if (action === "fp_check.run")
    return activeStatus({ status: feedbackRecord(state.fpCheck).state });
  if (action === "image.build") return activeStatus(state.build);
  return null;
}

export function policyInFlightActions(
  state: PolicyState,
  graph: NonNullable<PolicyGraph>,
): PolicyAction[] {
  const actions = POLICY_ACTIONS.filter(
    (action) => graph.actions[action] && actionInFlightStatus(state, graph, action),
  );
  return actions.includes("checks.run_all") ? ["checks.run_all"] : actions;
}

function profileFailures(
  state: PolicyState,
  name: string,
  profile: ResultProfile | undefined,
): PolicyRequirement[] {
  if (!profile)
    return [
      {
        profile: name,
        check: null,
        path: "",
        expected: "defined result profile",
        actual: undefined,
        reason: "missing_profile",
      },
    ];
  const check = profile.check ? checkResult(state, profile.check) : state;
  if (!check)
    return [
      {
        profile: name,
        check: profile.check,
        path: "",
        expected: "check result",
        actual: undefined,
        reason: "missing_check",
      },
    ];
  const failures: PolicyRequirement[] = [];
  for (const predicate of profile.all) {
    const result = evaluatePredicate(check, predicate);
    if (
      !result.pass
      && /^checkInputs\.(description|tests|solution|dockerfile)\.changedSinceCheck$/.test(
        predicate.path,
      )
      && predicate.equals === false
      && result.reason === "missing_field"
    )
      continue;
    if (!result.pass)
      failures.push({
        profile: name,
        check: profile.check,
        path: predicate.path,
        expected: result.expected,
        actual: result.actual,
        reason: result.reason!,
      });
  }
  return failures;
}

export function policyRecommendedAction(
  state: PolicyState,
  graph: NonNullable<PolicyGraph>,
): PolicyAction | null {
  const configured = Object.keys(graph.actions) as PolicyAction[];
  const incoming = new Map<PolicyAction, number>(configured.map((action) => [action, 0]));
  const activeTargets = new Set<PolicyAction>();
  for (const node of Object.values(graph.actions))
    for (const transition of node?.next ?? []) {
      if (transition.action === null) continue;
      incoming.set(transition.action, (incoming.get(transition.action) ?? 0) + 1);
      if (transition.all.every((predicate) => evaluatePredicate(state, predicate).pass))
        activeTargets.add(transition.action);
    }
  for (const action of configured) {
    if ((incoming.get(action) ?? 0) > 0 && !activeTargets.has(action)) continue;
    if (actionInFlightStatus(state, graph, action)) continue;
    const node = graph.actions[action];
    if (!actionRequirementsSatisfied(state, graph, action)) return action;
    const transition = node?.next.find((candidate) =>
      candidate.all.every((predicate) => evaluatePredicate(state, predicate).pass),
    );
    if (!transition) return action;
  }
  return null;
}

/**
 * Return active check actions that completed on the current artifacts but whose result fails the
 * graph's conditions to continue, with the failed conditions on their own result. The next step is
 * then an artifact revision, which the graph cannot express as an action.
 */
export function policyUnmetContinuations(
  state: PolicyState,
  graph: NonNullable<PolicyGraph>,
): Array<{ action: PolicyAction; unmet: string[] }> {
  const configured = Object.keys(graph.actions) as PolicyAction[];
  const result: Array<{ action: PolicyAction; unmet: string[] }> = [];
  for (const action of configured) {
    if (!action.startsWith("checks.") || action === "checks.run_all") continue;
    const key = action.slice("checks.".length);
    const check = checkResult(state, key);
    if (!check || check.status !== "completed" || check.stale === true) continue;
    const transitions = graph.actions[action]?.next ?? [];
    if (transitions.length === 0) continue;
    if (
      transitions.some((t) => t.all.every((predicate) => evaluatePredicate(state, predicate).pass))
    )
      continue;
    const own = `checks.${key}.`;
    let best: string[] | null = null;
    let bestFailures = Number.POSITIVE_INFINITY;
    for (const transition of transitions) {
      if (transition.action === null) continue;
      const failed = transition.all
        .map((predicate) => ({ predicate, outcome: evaluatePredicate(state, predicate) }))
        .filter(({ outcome }) => !outcome.pass);
      const ownFailed = failed.filter(({ predicate }) =>
        predicate.path.startsWith(`${own}output.`),
      );
      // Only a transition blocked solely by this check's own result points at an artifact revision.
      if (
        ownFailed.length === 0
        || ownFailed.length !== failed.length
        || failed.length >= bestFailures
      )
        continue;
      bestFailures = failed.length;
      best = ownFailed.map(({ predicate, outcome }) => {
        const [operator, value] = Object.entries(
          outcome.expected as Record<string, unknown>,
        )[0] ?? ["", ""];
        return `${predicate.path.slice(own.length)} ${operator} ${JSON.stringify(value)} (actual ${JSON.stringify(outcome.actual)})`;
      });
    }
    if (best) result.push({ action, unmet: best });
  }
  return result;
}

/** Return active graph nodes whose matching transition explicitly terminates the graph. */
export function policyTerminalActions(
  state: PolicyState,
  graph: NonNullable<PolicyGraph>,
): PolicyAction[] {
  const configured = Object.keys(graph.actions) as PolicyAction[];
  const incoming = new Map<PolicyAction, number>(configured.map((action) => [action, 0]));
  const activeTargets = new Set<PolicyAction>();
  for (const node of Object.values(graph.actions))
    for (const transition of node?.next ?? []) {
      if (transition.action !== null)
        incoming.set(transition.action, (incoming.get(transition.action) ?? 0) + 1);
      if (
        transition.action !== null
        && transition.all.every((predicate) => evaluatePredicate(state, predicate).pass)
      )
        activeTargets.add(transition.action);
    }
  return configured.filter((action) => {
    if ((incoming.get(action) ?? 0) > 0 && !activeTargets.has(action)) return false;
    if (actionInFlightStatus(state, graph, action)) return false;
    if (!actionRequirementsSatisfied(state, graph, action)) return false;
    return graph.actions[action]?.next.some(
      (transition) =>
        transition.action === null
        && transition.all.every((predicate) => evaluatePredicate(state, predicate).pass),
    );
  });
}

function mutableRecord(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function projectActionRunning(
  state: PolicyState,
  graph: NonNullable<PolicyGraph>,
  action: PolicyAction,
): boolean {
  const checkKeys: string[] = [];
  if (action.startsWith("checks.") && action !== "checks.run_all")
    checkKeys.push(action.slice("checks.".length));
  if (action === "checks.run_all") {
    const configured = graph.actions[action]?.arguments?.checks;
    if (Array.isArray(configured))
      checkKeys.push(
        ...configured.filter(
          (candidateKey): candidateKey is string => typeof candidateKey === "string",
        ),
      );
  }
  if (checkKeys.length > 0) {
    const checks = mutableRecord(state.checks);
    state.checks = checks;
    for (const checkKey of checkKeys) {
      const storedKey =
        Object.keys(checks).find((candidate) => toPublicCheckKey(candidate) === checkKey)
        ?? checkKey;
      checks[storedKey] = {
        ...mutableRecord(checks[storedKey]),
        status: "running",
        stale: false,
      };
    }
    return true;
  }
  if (action === "prechecks.run") {
    const readiness = mutableRecord(state.readiness);
    const criteria = Array.isArray(readiness.criteria) ? readiness.criteria : [];
    const index = criteria.findIndex(
      (criterion: unknown) => mutableRecord(criterion).id === "prechecks",
    );
    if (index < 0) return false;
    const projectedCriteria = [...criteria];
    projectedCriteria[index] = { ...mutableRecord(projectedCriteria[index]), status: "pending" };
    readiness.criteria = projectedCriteria;
    state.readiness = readiness;
    return true;
  }
  if (action === "scope_gate.run") {
    state.scopeGate = { ...mutableRecord(state.scopeGate), inFlight: true };
    return true;
  }
  return false;
}

function intersects(left: string[], right: string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

type ActionExecutionProfile = {
  observes: string[];
  changes: string[];
  exclusive: string[];
};

const artifacts = [
  "artifact.description",
  "artifact.tests",
  "artifact.solution",
  "artifact.dockerfile",
];

/** Derive concurrency behavior from the CLI's closed action catalog. */
export function policyActionExecutionProfile(
  action: PolicyAction,
  arguments_: Record<string, string | number | boolean | string[]> = {},
): ActionExecutionProfile {
  if (action.startsWith("checks.")) {
    const configured =
      action === "checks.run_all" && Array.isArray(arguments_.checks)
        ? arguments_.checks
        : [action.slice("checks.".length)];
    const keys = configured.filter(
      (candidateKey): candidateKey is string => typeof candidateKey === "string",
    );
    return {
      observes: [...artifacts],
      changes: keys.map((candidateKey) => `check.${candidateKey}`),
      exclusive: keys.map((candidateKey) => `check.${candidateKey}`),
    };
  }
  const profiles: Partial<Record<PolicyAction, ActionExecutionProfile>> = {
    "artifacts.update": { observes: [], changes: artifacts, exclusive: ["artifacts"] },
    "image.build": {
      observes: [...artifacts, "readiness.scopeGate"],
      changes: ["image"],
      exclusive: ["image.build"],
    },
    "prechecks.run": {
      observes: artifacts,
      changes: ["readiness.prechecks"],
      exclusive: ["prechecks"],
    },
    "scope_gate.run": {
      observes: [...artifacts, "readiness.prechecks"],
      changes: ["readiness.scopeGate"],
      exclusive: ["scopeGate"],
    },
    "rollouts.run": {
      observes: [...artifacts, "image"],
      changes: ["runs"],
      exclusive: ["rollouts"],
    },
    "re_evaluation.run": {
      observes: ["runs"],
      changes: ["runs.reEvaluation"],
      exclusive: ["reEvaluation"],
    },
    "fp_check.run": {
      observes: [...artifacts, "runs"],
      changes: ["fpCheck"],
      exclusive: ["fpCheck"],
    },
    "verifier_audit.decide": {
      observes: ["check.verifierIncompleteness"],
      changes: ["verifierAudit"],
      exclusive: ["verifierAudit"],
    },
    "auto_review.orchestrate": {
      observes: [...artifacts, "runs"],
      changes: ["autoReview"],
      exclusive: ["autoReview"],
    },
    "submission.submit": {
      observes: ["readiness", "runs", "autoReview"],
      changes: ["submission"],
      exclusive: ["submission"],
    },
  };
  return profiles[action] ?? { observes: [], changes: [action], exclusive: [action] };
}

/** Serialize conflicts inferred from the action catalog. */
export function policyActionsIndependent(
  graph: NonNullable<PolicyGraph>,
  left: PolicyAction,
  right: PolicyAction,
): boolean {
  const leftNode = graph.actions[left];
  const rightNode = graph.actions[right];
  if (!leftNode || !rightNode) return false;
  const a = policyActionExecutionProfile(left, leftNode.arguments);
  const b = policyActionExecutionProfile(right, rightNode.arguments);
  return !(
    intersects(a.changes, [...b.observes, ...b.changes])
    || intersects(b.changes, [...a.observes, ...a.changes])
    || intersects(a.exclusive, b.exclusive)
  );
}

function actionRequirementsSatisfied(
  state: PolicyState,
  graph: NonNullable<PolicyGraph>,
  action: PolicyAction,
): boolean {
  const node = graph.actions[action];
  if (!node) return true;
  const exempt =
    node.unless?.some(
      (group) =>
        group.length > 0 && group.every((predicate) => evaluatePredicate(state, predicate).pass),
    ) ?? false;
  const applies =
    !node.requires_when
    || node.requires_when.every((predicate) => evaluatePredicate(state, predicate).pass);
  return (
    exempt
    || !applies
    || node.requires.every((name) => profileFailures(state, name, graph.gates[name]).length === 0)
  );
}

/**
 * Return every action the existing graph permits at the current scheduling level.
 * A successor belongs to that level when dispatching the prior action (projected as
 * running, without projecting completion or PASS) makes the successor current.
 */
export function policyRecommendedActions(
  state: PolicyState,
  graph: NonNullable<PolicyGraph>,
): PolicyAction[] {
  const projected = structuredClone(state);
  const actions: PolicyAction[] = [];
  const visited = new Set<PolicyAction>();
  while (actions.length < POLICY_ACTIONS.length) {
    const action = policyRecommendedAction(projected, graph);
    if (!action || visited.has(action)) break;
    visited.add(action);
    if (actions.some((candidate) => !policyActionsIndependent(graph, candidate, action))) break;
    actions.push(action);
    if (
      actionInFlightStatus(projected, graph, action)
      || !actionRequirementsSatisfied(projected, graph, action)
    )
      break;
    if (!projectActionRunning(projected, graph, action)) break;
  }
  return actions;
}

export type NextStepConfluence = {
  pass: boolean;
  exhaustive: boolean;
  permutations: number;
  counterexample: { first: PolicyAction[]; second: PolicyAction[] } | null;
};

function* permutations<T>(values: T[]): Generator<T[]> {
  if (values.length <= 1) {
    yield values;
    return;
  }
  for (const [index, value] of values.entries())
    for (const tail of permutations([...values.slice(0, index), ...values.slice(index + 1)]))
      yield [value, ...tail];
}

function factorial(value: number): number {
  let result = 1;
  for (let factor = 2; factor <= value; factor += 1) result *= factor;
  return result;
}

function confluenceMessage(confluence: NextStepConfluence): string {
  if (confluence.exhaustive) {
    return confluence.pass
      ? `All ${confluence.permutations} start orders converge.`
      : "At least two start orders produce different projected states.";
  }
  return "The next step is too broad for exhaustive confluence analysis.";
}

/** Verify that starting the next actions in any order produces the same projected state. */
export function analyzeNextStepConfluence(
  state: PolicyState,
  graph: NonNullable<PolicyGraph>,
): NextStepConfluence {
  const nextActions = policyRecommendedActions(state, graph);
  if (nextActions.length < 2)
    return { pass: true, exhaustive: true, permutations: 1, counterexample: null };
  if (nextActions.length > 8)
    return { pass: false, exhaustive: false, permutations: 0, counterexample: null };
  const permutationCount = factorial(nextActions.length);
  let expected: string | null = null;
  let expectedOrder: PolicyAction[] | null = null;
  for (const order of permutations(nextActions)) {
    const projected = structuredClone(state);
    for (const action of order)
      if (!projectActionRunning(projected, graph, action))
        return {
          pass: false,
          exhaustive: true,
          permutations: permutationCount,
          counterexample: { first: order, second: [] },
        };
    const fingerprint = policyFingerprint(projected);
    if (expected === null) {
      expected = fingerprint;
      expectedOrder = order;
    } else if (fingerprint !== expected)
      return {
        pass: false,
        exhaustive: true,
        permutations: permutationCount,
        counterexample: { first: expectedOrder!, second: order },
      };
  }
  return { pass: true, exhaustive: true, permutations: permutationCount, counterexample: null };
}

function graphContainsAction(graph: NonNullable<PolicyGraph>, target: PolicyAction): boolean {
  return Boolean(graph.actions[target]);
}

export type PolicyAuditIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  actions: PolicyAction[];
};

export type PolicyRuleResult = {
  id: string;
  pass: boolean;
  message: string;
  counterexample?: unknown;
};

function predicatesContradict(left: Predicate[], right: Predicate[]): boolean {
  for (const a of left) {
    for (const b of right) {
      if (a.path !== b.path) continue;
      if (
        Object.hasOwn(a, "equals")
        && Object.hasOwn(b, "equals")
        && stable(a.equals) !== stable(b.equals)
      )
        return true;
      if (Object.hasOwn(a, "empty") && Object.hasOwn(b, "empty") && a.empty !== b.empty)
        return true;
    }
  }
  return false;
}

function samePredicateDomain(left: Predicate[], right: Predicate[]): boolean {
  const a = new Set(left.map((predicate) => predicate.path));
  const b = new Set(right.map((predicate) => predicate.path));
  return a.size === b.size && [...a].every((path) => b.has(path));
}

/** Static graph diagnostics plus state-specific executable invariant results. */
// oxlint-disable-next-line max-lines-per-function complexity
export function auditPolicyGraph(
  graph: NonNullable<PolicyGraph>,
  state?: PolicyState,
): {
  issues: PolicyAuditIssue[];
  rules: PolicyRuleResult[];
  topology: { reachable: PolicyAction[]; detached: PolicyAction[] };
  confluence: NextStepConfluence;
} {
  const issues: PolicyAuditIssue[] = [];
  for (const [action, node] of Object.entries(graph.actions) as Array<[PolicyAction, PolicyNode]>) {
    for (const transition of node.next) {
      if (transition.action !== null && !graph.actions[transition.action])
        issues.push({
          severity: "error",
          code: "transition_target_missing",
          message: `${action} transitions to unconfigured action ${transition.action}.`,
          actions: [action, transition.action],
        });
    }
    for (let i = 0; i < node.next.length; i += 1) {
      for (let j = i + 1; j < node.next.length; j += 1) {
        const left = node.next[i];
        const right = node.next[j];
        const independentTargets =
          left.action !== null
          && right.action !== null
          && policyActionsIndependent(graph, left.action, right.action);
        if (
          left.action !== right.action
          && samePredicateDomain(left.all, right.all)
          && !predicatesContradict(left.all, right.all)
          && !independentTargets
        )
          issues.push({
            severity: "warning",
            code: "transition_overlap",
            message: `${action} transitions ${i + 1} and ${j + 1} may both match; list order decides.`,
            actions: [
              action,
              ...(left.action ? [left.action] : []),
              ...(right.action ? [right.action] : []),
            ],
          });
      }
    }
  }
  const nextActions = state ? policyRecommendedActions(state, graph) : [];
  const confluence = state
    ? analyzeNextStepConfluence(state, graph)
    : { pass: true, exhaustive: false, permutations: 0, counterexample: null };
  const nextActionsIndependent = nextActions.every((action, index) =>
    nextActions.slice(index + 1).every((other) => policyActionsIndependent(graph, action, other)),
  );
  let independenceMessage = "No state supplied; next-action independence was not evaluated.";
  if (state !== undefined) {
    independenceMessage = nextActionsIndependent
      ? "Every action in the next step is pairwise independent."
      : "The next step contains a declared resource or effect conflict.";
  }
  const known: Record<string, PolicyRuleResult> = {
    next_actions_are_independent: {
      id: "next_actions_are_independent",
      pass: state === undefined || nextActionsIndependent,
      message: independenceMessage,
    },
    transition_targets_exist: {
      id: "transition_targets_exist",
      pass: !issues.some((issue) => issue.code === "transition_target_missing"),
      message: "Every non-terminal transition must target a configured action node.",
    },
    no_ambiguous_transitions: {
      id: "no_ambiguous_transitions",
      pass: !issues.some((issue) => issue.code === "transition_overlap"),
      message: "Transitions from one action must be mutually exclusive.",
    },
    all_transition_orders_converge: {
      id: "all_transition_orders_converge",
      pass: confluence.pass,
      message: confluenceMessage(confluence),
      ...(confluence.counterexample ? { counterexample: confluence.counterexample } : {}),
    },
    in_flight_actions_are_not_recommended: {
      id: "in_flight_actions_are_not_recommended",
      pass:
        state === undefined
        || !nextActions.some((action) => actionInFlightStatus(state, graph, action)),
      message: "No active action may be recommended to start again.",
    },

    all_next_actions_are_exposed: {
      id: "all_next_actions_are_exposed",
      pass: true,
      message: `The evaluator exposed all ${nextActions.length} actions in the next step.`,
    },
    completion_requires_platform_readiness: {
      id: "completion_requires_platform_readiness",
      pass:
        state === undefined
        || nextActions.length > 0
        || feedbackRecord(state.readiness).canSubmit === true
        || policyTerminalActions(state, graph).length > 0
        || policyInFlightActions(state, graph).length > 0
        || (Array.isArray(state.runs)
          && state.runs.some((run) =>
            ["pending", "queued", "running", "in_progress"].includes(
              String(feedbackRecord(run).status ?? "").toLowerCase(),
            ),
          )),
      message:
        "An empty next step is valid only when platform readiness passes, work is still in flight, or the graph matched an explicit terminal transition.",
    },
  };
  const rules = (graph.rules ?? []).map(
    (id): PolicyRuleResult =>
      known[id] ?? { id, pass: false, message: `Unknown executable policy rule: ${id}` },
  );
  const configured = Object.keys(graph.actions) as PolicyAction[];
  return {
    issues,
    rules,
    topology: {
      reachable: configured,
      detached: [],
    },
    confluence,
  };
}

export function policyGovernsAction(
  graph: NonNullable<PolicyGraph>,
  action: PolicyAction,
): boolean {
  return (
    (Boolean(graph.repair_first?.length) && action !== "artifacts.update")
    || graphContainsAction(graph, action)
    || (graph.actions[action]?.requires.length ?? 0) > 0
  );
}

export function matchingPolicyNotes(
  state: PolicyState,
  graph: NonNullable<PolicyGraph>,
): PolicyDecision["notes"] {
  return graph.notes
    .filter((note) => {
      const root = note.when.check ? checkResult(state, note.when.check) : state;
      return (
        root !== undefined
        && note.when.all.every((predicate) => evaluatePredicate(root, predicate).pass)
      );
    })
    .map(({ id, severity, message }) => ({ id, severity, message }));
}

type TokenPayload = {
  v: 1;
  challengeId: string;
  action: PolicyAction;
  argumentsHash: string;
  policyHash: string;
  fingerprint: string;
  exp: number;
  nonce: string;
};
type AuthorizationPayload = {
  v: 2;
  challengeId: string;
  versionId: string;
  action: PolicyAction;
  policyHash: string;
  fingerprint: string;
  stepId: string;
  nextActions: PolicyAction[];
  commandHash: string;
  exp: number;
  nonce: string;
};
function key(secret: string, challengeId: string): Buffer {
  return createHash("sha256").update(`olympus-workflow\0${secret}\0${challengeId}`).digest();
}
function encode(payload: TokenPayload, secret: string): string {
  const body = Buffer.from(stable(payload)).toString("base64url");
  const signature = createHmac("sha256", key(secret, payload.challengeId))
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}
function decode(token: string, secret: string): TokenPayload {
  const [body, supplied, extra] = token.split(".");
  if (!body || !supplied || extra) throw new Error("Malformed graph confirmation token");
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed graph confirmation token");
  }
  if (
    !payload
    || payload.v !== 1
    || typeof payload.challengeId !== "string"
    || !POLICY_ACTIONS.includes(payload.action)
    || typeof payload.policyHash !== "string"
    || typeof payload.argumentsHash !== "string"
    || typeof payload.fingerprint !== "string"
    || !Number.isSafeInteger(payload.exp)
    || typeof payload.nonce !== "string"
    || !/^[0-9a-f-]{36}$/.test(payload.nonce)
  )
    throw new Error("Malformed graph confirmation token");
  const expected = createHmac("sha256", key(secret, payload.challengeId)).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(supplied, "base64url");
  } catch {
    throw new Error("Invalid graph confirmation signature");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("Invalid graph confirmation signature");
  return payload;
}

// oxlint-disable-next-line complexity
function decodeAuthorization(token: string, secret: string): AuthorizationPayload {
  const [body, supplied, extra] = token.split(".");
  if (!body || !supplied || extra) throw new Error("Malformed policy authorization");
  let payload: AuthorizationPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed policy authorization");
  }
  if (
    !payload
    || payload.v !== 2
    || typeof payload.challengeId !== "string"
    || typeof payload.versionId !== "string"
    || !POLICY_ACTIONS.includes(payload.action)
    || typeof payload.policyHash !== "string"
    || typeof payload.fingerprint !== "string"
    || typeof payload.stepId !== "string"
    || !Array.isArray(payload.nextActions)
    || payload.nextActions.some((action) => !POLICY_ACTIONS.includes(action))
    || typeof payload.commandHash !== "string"
    || !Number.isSafeInteger(payload.exp)
    || typeof payload.nonce !== "string"
    || !/^[0-9a-f-]{36}$/.test(payload.nonce)
  )
    throw new Error("Malformed policy authorization");
  const expected = createHmac("sha256", key(secret, payload.challengeId)).update(body).digest();
  const actual = Buffer.from(supplied, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("Invalid policy authorization signature");
  return payload;
}

export function policyStepId(input: {
  challengeId: string;
  versionId: string;
  fingerprint: string;
  actions: PolicyAction[];
  commands: string[][];
}): string {
  return policyFingerprint({
    challengeId: input.challengeId,
    versionId: input.versionId,
    fingerprint: input.fingerprint,
    actions: [...input.actions].toSorted(),
    commands: input.commands
      .map((command) => [...command])
      .toSorted((a, b) => stable(a).localeCompare(stable(b))),
  });
}

export function createPolicyAuthorization(input: {
  challengeId: string;
  versionId: string;
  action: PolicyAction;
  policyHash: string;
  fingerprint: string;
  stepId: string;
  nextActions: PolicyAction[];
  command: string[];
  secret: string;
  now?: number;
  expiresAfterMs?: number;
}): { token: string; expiresAt: string } {
  const payload: AuthorizationPayload = {
    v: 2,
    challengeId: input.challengeId,
    versionId: input.versionId,
    action: input.action,
    policyHash: input.policyHash,
    fingerprint: input.fingerprint,
    stepId: input.stepId,
    nextActions: [...input.nextActions],
    commandHash: policyFingerprint(input.command),
    exp: (input.now ?? Date.now()) + (input.expiresAfterMs ?? 300_000),
    nonce: randomUUID(),
  };
  return {
    token: encode(payload as unknown as TokenPayload, input.secret),
    expiresAt: new Date(payload.exp).toISOString(),
  };
}

// oxlint-disable-next-line complexity
export function consumePolicyAuthorization(input: {
  token: string;
  challengeId: string;
  versionId: string;
  action: PolicyAction;
  policyHash: string;
  fingerprint: string;
  stepId: string;
  command: string[];
  secret: string;
  replayDirectory: string;
  now?: number;
  projected?: { nextActions: PolicyAction[]; inFlight: PolicyAction[] };
}): void {
  const payload = decodeAuthorization(input.token, input.secret);
  const projectedSiblingState =
    payload.fingerprint !== input.fingerprint
    && (input.projected?.inFlight.length ?? 0) > 0
    && input.projected!.inFlight.every((action) => payload.nextActions.includes(action))
    && input.projected!.nextActions.includes(input.action);
  const mismatch =
    payload.challengeId !== input.challengeId
    || payload.versionId !== input.versionId
    || payload.action !== input.action
    || payload.policyHash !== input.policyHash
    || (payload.fingerprint !== input.fingerprint && !projectedSiblingState)
    || (payload.stepId !== input.stepId && !projectedSiblingState)
    || payload.commandHash !== policyFingerprint(input.command);
  if (mismatch) throw new Error("Policy authorization does not match the current step and command");
  if (payload.exp <= (input.now ?? Date.now())) throw new Error("Policy authorization expired");
  consume(payload.nonce, input.replayDirectory);
}

export function localPolicySecret(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, ".workflow-confirmation-secret");
  const temporary = resolve(directory, `.workflow-confirmation-secret.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${randomBytes(32).toString("base64url")}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error("Policy confirmation secret must be a private regular file");
    const secret = readFileSync(descriptor, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret))
      throw new Error("Policy confirmation secret is invalid");
    return secret;
  } finally {
    closeSync(descriptor);
  }
}
function duration(value: string): number {
  const match = /^([1-9]\d*)(s|m|h)$/.exec(value);
  if (!match) throw new Error("Invalid graph confirmation duration");
  return Number(match[1]) * ({ s: 1_000, m: 60_000, h: 3_600_000 }[match[2]] as number);
}
function consume(nonce: string, directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, nonce);
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Policy confirmation token was already used", { cause: error });
    throw error;
  }
  try {
    writeFileSync(descriptor, `${Date.now()}\n`);
  } finally {
    closeSync(descriptor);
  }
}

export function evaluatePolicyGraph(input: {
  graph: PolicyGraph;
  policyHash?: string;
  state: PolicyState;
  action: PolicyAction;
  args: Record<string, unknown>;
  confirmation?: string;
  secret: string;
  replayDirectory: string;
  cliCommand?: string[];
  now?: number;
  preview?: boolean;
  batchDecisions?: PolicyDecision[];
  /** Internal: proven native prerequisite; waive ordering only, never node gates. */
  nativePrerequisite?: boolean;
}): PolicyDecision {
  const { graph, state, action, args } = input;
  const now = input.now ?? Date.now();
  const fingerprint = policyFingerprint(state);
  const off = !graph || graph.mode === "off";
  let recommendedCommand: string[] | null = null;
  const base: {
    mode: PolicyMode;
    challengeId: string;
    action: PolicyAction;
    fingerprint: string;
    recommendedCommand?: string[] | null;
    recommendationError?: string;
  } = { mode: graph?.mode ?? "off", challengeId: state.challengeId, action, fingerprint };
  if (off)
    return {
      ...base,
      status: "off",
      recommendedAction: null,
      unmetRequirements: [],
      notes: [],
      cliContinuation: { command: input.cliCommand ?? null, append: [] },
    };
  const failedRepairs = (graph.repair_first ?? [])
    .filter((check) => {
      const result = checkResult(state, check);
      return (
        result?.stale === true
        && (["failed", "error"].includes(result?.status)
          || String(
            result?.output?.verdict ?? result?.output?.evaluation?.verdict ?? "",
          ).toUpperCase() === "FAIL")
      );
    })
    .map((check) => `checks.${check}` as PolicyAction);
  const blockingRepairs = failedRepairs;
  if (blockingRepairs.length > 0 && action !== "artifacts.update" && !input.nativePrerequisite) {
    const requested = input.batchDecisions?.length
      ? input.batchDecisions.map((item) => item.action)
      : [action];
    const permitted = requested.every((candidate) => blockingRepairs.includes(candidate));
    const next = blockingRepairs[0];
    const command = [
      "olympus",
      ...actionCliArguments({
        action: next,
        challengeId: state.challengeId,
        arguments: graph.actions[next]?.arguments ?? {},
      }),
    ];
    return {
      ...base,
      mode: "enforce",
      status: permitted ? "allowed" : "blocked",
      recommendedAction: next,
      recommendedCommand: command,
      unmetRequirements: permitted
        ? []
        : [
            {
              profile: "repair_first",
              check: null,
              path: "action",
              expected: { equals: failedRepairs.join(" or ") },
              actual: action,
              reason: "action_not_recommended",
            },
          ],
      notes: [],
      cliContinuation: { command: input.cliCommand ?? null, append: [] },
    };
  }
  const recommendedActions = policyRecommendedActions(state, graph);
  const recommended = recommendedActions[0] ?? null;
  const inOrder = recommendedActions.includes(action) || input.nativePrerequisite === true;
  const node = graph.actions[action];
  if (node?.enforce) base.mode = "enforce";
  const exempt =
    node?.unless?.some(
      (group) =>
        group.length > 0 && group.every((predicate) => evaluatePredicate(state, predicate).pass),
    ) ?? false;
  const applies =
    !node?.requires_when
    || node.requires_when.every((predicate) => evaluatePredicate(state, predicate).pass);
  const unmet = (exempt || !applies ? [] : (node?.requires ?? [])).flatMap((name) =>
    profileFailures(state, name, graph.gates[name]),
  );
  const inFlightStatus = actionInFlightStatus(state, graph, action);
  if (inFlightStatus)
    unmet.push({
      profile: "action_in_flight",
      check: action.startsWith("checks.") ? action : null,
      path: "status",
      expected: "not pending, queued, running, or in_progress",
      actual: inFlightStatus,
      reason: "predicate_failed",
    });
  const batchBlocked =
    input.batchDecisions?.filter((item) => item.status !== "off" && item.status !== "allowed")
    ?? [];
  for (const item of batchBlocked) {
    unmet.push(...item.unmetRequirements);
    if (item.unmetRequirements.length === 0)
      unmet.push({
        profile: "batch",
        check: item.action,
        path: "action",
        expected: item.recommendedAction,
        actual: item.action,
        reason: "action_not_recommended",
      });
  }
  if (batchBlocked.some((item) => item.mode === "enforce")) base.mode = "enforce";
  const requirementsUnmet = unmet.length > 0;
  const outOfOrder = !inOrder && graphContainsAction(graph, action);
  if (unmet.length === 0 && outOfOrder)
    unmet.push({
      profile: "graph",
      check: null,
      path: "action",
      expected: { equals: recommendedActions.join(" or ") || null },
      actual: action,
      reason: "action_not_recommended",
    });
  const notes = matchingPolicyNotes(state, graph);
  let fallback: PolicyAction | null | undefined = null;
  if (!inFlightStatus) {
    fallback = batchBlocked[0]?.recommendedAction;
    if (fallback == null) {
      if (requirementsUnmet) fallback = node?.on_unmet ?? null;
      else fallback = inOrder ? action : recommended;
    }
  }
  if (fallback) {
    try {
      recommendedCommand = [
        "olympus",
        ...actionCliArguments({
          action: fallback,
          challengeId: state.challengeId,
          arguments: graph.actions[fallback]?.arguments ?? {},
        }),
      ];
    } catch (error) {
      base.recommendationError = error instanceof Error ? error.message : String(error);
    }
  }
  base.recommendedCommand = recommendedCommand;
  const continuation = (token?: string) => ({
    command: input.cliCommand ?? null,
    append: token ? [`--policy-confirmation=${token}`] : [],
  });
  if (!input.confirmation && unmet.length === 0 && (inOrder || !graphContainsAction(graph, action)))
    return {
      ...base,
      status: "allowed",
      recommendedAction: inOrder ? action : recommended,
      unmetRequirements: [],
      notes,
      cliContinuation: continuation(),
    };
  if (
    graph.mode === "enforce"
    || node?.enforce
    || batchBlocked.some((item) => item.mode === "enforce")
  )
    return {
      ...base,
      status: "blocked",
      recommendedAction: fallback,
      unmetRequirements: unmet,
      notes,
      cliContinuation: continuation(),
    };
  const policyHash = input.policyHash ?? createHash("sha256").update(stable(graph)).digest("hex");
  const argumentsHash = createHash("sha256").update(stable(args)).digest("hex");
  if (input.confirmation) {
    let payload: TokenPayload;
    try {
      payload = decode(input.confirmation, input.secret);
    } catch (error) {
      return {
        ...base,
        status: "blocked",
        recommendedAction: recommended,
        unmetRequirements: [
          {
            profile: "confirmation",
            check: null,
            path: "token",
            expected: "valid bound token",
            actual: null,
            reason: "predicate_failed",
          },
        ],
        notes: [
          ...notes,
          {
            id: "confirmation.invalid",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        cliContinuation: continuation(),
      };
    }
    const mismatch =
      payload.policyHash !== policyHash
      || payload.v !== 1
      || payload.challengeId !== state.challengeId
      || payload.action !== action
      || payload.argumentsHash !== argumentsHash
      || payload.fingerprint !== fingerprint;
    if (mismatch || payload.exp <= now)
      return {
        ...base,
        status: "blocked",
        recommendedAction: recommended,
        unmetRequirements: [
          {
            profile: "confirmation",
            check: null,
            path: mismatch ? "bindings" : "expiresAt",
            expected: mismatch
              ? "unchanged challenge/action/arguments/state"
              : `after ${new Date(now).toISOString()}`,
            actual: mismatch ? "changed" : new Date(payload.exp).toISOString(),
            reason: "predicate_failed",
          },
        ],
        notes,
        cliContinuation: continuation(),
      };
    try {
      consume(payload.nonce, input.replayDirectory);
    } catch (error) {
      return {
        ...base,
        status: "blocked",
        recommendedAction: recommended,
        unmetRequirements: [
          {
            profile: "confirmation",
            check: null,
            path: "nonce",
            expected: "unused token",
            actual: "used",
            reason: "predicate_failed",
          },
        ],
        notes: [
          ...notes,
          {
            id: "confirmation.replay",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        cliContinuation: continuation(),
      };
    }
    return {
      ...base,
      status: "allowed",
      recommendedAction: recommended,
      unmetRequirements: [],
      notes,
      cliContinuation: continuation(),
    };
  }
  if (input.preview)
    return {
      ...base,
      status: "confirmation_required",
      recommendedAction: fallback,
      unmetRequirements: unmet,
      notes,
      cliContinuation: continuation(),
    };
  const payload: TokenPayload = {
    v: 1,
    challengeId: state.challengeId,
    action,
    argumentsHash,
    policyHash,
    fingerprint,
    exp: now + duration(graph.confirmation!.expires_after),
    nonce: randomUUID(),
  };
  const token = encode(payload, input.secret);
  return {
    ...base,
    status: "confirmation_required",
    recommendedAction: fallback,
    unmetRequirements: unmet,
    notes,
    confirmation: { method: "token", token, expiresAt: new Date(payload.exp).toISOString() },
    cliContinuation: continuation(token),
  };
}
