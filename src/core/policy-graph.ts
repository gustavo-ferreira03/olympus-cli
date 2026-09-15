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
import { toPublicCheckKey } from "./expected.ts";
import { enrichCheckResults } from "./check-inputs.ts";

import { POLICY_ACTIONS, type PolicyAction, actionCliArguments } from "./action-catalog.ts";

const api = anyApi;
export { POLICY_ACTIONS, type PolicyAction };

export type PolicyMode = "off" | "advise" | "enforce";
export type Predicate = {
  path: string;
  equals?: string | number | boolean | null;
  empty?: boolean;
  greater_than?: number;
  at_least?: number;
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
};
export type PolicyGraph = {
  mode: PolicyMode;
  start: PolicyAction | null;
  confirmation: { method: "token"; expires_after: string } | null;
  gates: Record<string, ResultProfile>;
  repair_first?: string[];
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
  const terminal = new Set(["pass", "fail", "error", "missing_fields", "skipped"]);
  if (stages.some((stage) => !terminal.has(stage.status)))
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
  const brief = (value: unknown): unknown =>
    Array.isArray(value)
      ? { count: value.length }
      : value !== null && typeof value === "object"
        ? { fields: Object.keys(value).length }
        : typeof value === "string" && value.length > 120
          ? `${value.slice(0, 117)}...`
          : value;
  const failures = decision.unmetRequirements.map((requirement) => {
    const check = feedbackRecord(
      Object.entries(feedbackRecord(state.checks)).find(
        ([key]) => toPublicCheckKey(key) === requirement.check,
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
  const feedback = {
    source: "policy",
    dispatched: false,
    action: decision.action,
    mode: decision.mode,
    failures,
    ...(decision.recommendedCommand
      ? { next: decision.recommendedCommand }
      : decision.recommendedAction
        ? { nextAction: decision.recommendedAction }
        : {}),
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
  for (const failure of failures) {
    const expected = feedbackRecord(failure.expected);
    const condition = Object.hasOwn(expected, "at_most")
      ? `<= ${expected.at_most}`
      : Object.hasOwn(expected, "one_of")
        ? `one of ${JSON.stringify(expected.one_of)}`
        : Object.hasOwn(expected, "at_least")
          ? `>= ${expected.at_least}`
          : Object.hasOwn(expected, "greater_than")
            ? `> ${expected.greater_than}`
            : Object.hasOwn(expected, "empty")
              ? expected.empty
                ? "empty"
                : "non-empty"
              : `= ${JSON.stringify(expected.equals)}`;
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

let invocation: { confirmation?: string; command?: string[] } = {};
export function setPolicyInvocation(value: { confirmation?: string; command?: string[] }): void {
  invocation = {
    confirmation: value.confirmation,
    command: value.command ? [...value.command] : undefined,
  };
}
export function policyInvocation(): {
  confirmation?: string;
  command?: string[];
} {
  return {
    confirmation: invocation.confirmation,
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
    const key = typeof args.checkKey === "string" ? toPublicCheckKey(args.checkKey) : "";
    const candidate = `checks.${key}`;
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
    .map((key) => `${JSON.stringify(key)}:${stable((value as any)[key])}`)
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
    client.query(api.stages.getByVersion, { versionId }),
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
  const expected = Object.hasOwn(predicate, "equals")
    ? { equals: predicate.equals }
    : Object.hasOwn(predicate, "empty")
      ? { empty: predicate.empty }
      : Object.hasOwn(predicate, "at_least")
        ? { at_least: predicate.at_least }
        : { greater_than: predicate.greater_than };
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
  else
    pass =
      typeof selected.value === "number"
      && Number.isFinite(selected.value)
      && selected.value > (predicate.greater_than as number);
  return { pass, actual: selected.value, expected, reason: pass ? undefined : "predicate_failed" };
}

function checkResult(state: Pick<PolicyState, "checks">, key: string): any {
  const checks =
    state.checks && typeof state.checks === "object" && !Array.isArray(state.checks)
      ? (state.checks as Record<string, any>)
      : {};
  const publicKey = toPublicCheckKey(key);
  for (const candidate of [
    key,
    publicKey,
    ...(publicKey === "testQuality" ? ["verifyFairness"] : []),
  ]) {
    if (Object.hasOwn(checks, candidate)) return checks[candidate];
  }
  return undefined;
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
  if (!graph.start) return null;
  let action = graph.start;
  const visited = new Set<PolicyAction>();
  while (true) {
    if (visited.has(action))
      throw new Error("Active graph transitions form a cycle; no action can be recommended");
    visited.add(action);
    const node = graph.actions[action];
    const transition = node?.next.find((candidate) =>
      candidate.all.every((predicate) => evaluatePredicate(state, predicate).pass),
    );
    if (!transition) return action;
    if (transition.action === null) return null;
    action = transition.action;
  }
}

function graphContainsAction(graph: NonNullable<PolicyGraph>, target: PolicyAction): boolean {
  if (graph.start === target) return true;
  if (!graph.start) return false;
  const pending = [graph.start];
  const visited = new Set<PolicyAction>();
  while (pending.length > 0) {
    const action = pending.pop()!;
    if (visited.has(action)) continue;
    visited.add(action);
    for (const transition of graph.actions[action]?.next ?? []) {
      if (transition.action === target) return true;
      if (transition.action !== null) pending.push(transition.action);
    }
  }
  return false;
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

function matchingNotes(state: PolicyState, graph: NonNullable<PolicyGraph>) {
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
  if (failedRepairs.length > 0 && action !== "artifacts.update") {
    const requested = input.batchDecisions?.length
      ? input.batchDecisions.map((item) => item.action)
      : [action];
    const permitted = requested.every((candidate) => failedRepairs.includes(candidate));
    const next = failedRepairs[0];
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
  const recommended = policyRecommendedAction(state, graph);
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
  const outOfOrder = action !== recommended && graphContainsAction(graph, action);
  if (unmet.length === 0 && outOfOrder)
    unmet.push({
      profile: "graph",
      check: null,
      path: "action",
      expected: { equals: recommended },
      actual: action,
      reason: "action_not_recommended",
    });
  const notes = matchingNotes(state, graph);
  const fallback =
    batchBlocked[0]?.recommendedAction
    ?? (requirementsUnmet ? (node?.on_unmet ?? null) : recommended);
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
  if (
    !input.confirmation
    && unmet.length === 0
    && (action === recommended || !graphContainsAction(graph, action))
  )
    return {
      ...base,
      status: "allowed",
      recommendedAction: recommended,
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
