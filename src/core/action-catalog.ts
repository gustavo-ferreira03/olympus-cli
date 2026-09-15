import { TRIGGERABLE_CHECK_KEYS } from "./expected.ts";

const CHECK_POLICY_ACTIONS = TRIGGERABLE_CHECK_KEYS.map(
  (key) => `checks.${key}` as `checks.${typeof key}`,
);
export const POLICY_ACTIONS = [
  "artifacts.update",
  "image.build",
  "prechecks.run",
  "scope_gate.run",
  "checks.run_all",
  ...CHECK_POLICY_ACTIONS,
  "rollouts.run",
  "re_evaluation.run",
  "fp_check.run",
  "verifier_audit.decide",
  "auto_review.orchestrate",
  "submission.submit",
] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

type Json = Record<string, unknown>;
const actionCommands: Record<PolicyAction, string[]> = {
  "artifacts.update": ["problems", "edit"],
  "image.build": ["image", "build"],
  "prechecks.run": ["checks", "run-prechecks"],
  "scope_gate.run": ["scope-gate", "run"],
  "checks.run_all": ["checks", "run-all"],
  "checks.verifyTests": ["checks", "run"],
  "checks.verifySolution": ["checks", "run"],
  "checks.verifyFlakiness": ["checks", "run"],
  "checks.testQuality": ["checks", "run"],
  "checks.taskQuality": ["checks", "run"],
  "checks.solutionQuality": ["checks", "run"],
  "checks.descriptionQuality": ["checks", "run"],
  "checks.verifierIncompleteness": ["verifier-audit", "run"],
  "checks.autoReview": ["auto-review", "run"],
  "rollouts.run": ["runs", "run"],
  "re_evaluation.run": ["runs", "re-evaluate", "run"],
  "fp_check.run": ["fp-check", "run"],
  "verifier_audit.decide": ["verifier-audit", "decide"],
  "auto_review.orchestrate": ["auto-review", "orchestrate"],
  "submission.submit": ["problems", "submit"],
};
const actionOptions: Record<PolicyAction, Set<string>> = {
  "artifacts.update": new Set([
    "title",
    "description",
    "description-file",
    "repo",
    "commit",
    "language",
    "category",
    "difficulty",
    "test-patch",
    "solution-patch",
    "solution-approach-file",
    "environment-description-file",
    "hint-file",
    "hint-justification-file",
    "dockerfile",
    "github-issue-url",
  ]),
  "image.build": new Set(["version", "wait", "interval", "timeout", "full"]),
  "prechecks.run": new Set(["wait", "interval", "timeout", "full"]),
  "scope_gate.run": new Set(["version", "use-general-tokens", "wait", "interval", "timeout"]),
  "checks.run_all": new Set([
    "checks",
    "use-general-tokens",
    "wait",
    "interval",
    "timeout",
    "full",
  ]),
  "checks.verifyTests": new Set(["use-general-tokens", "wait", "interval", "timeout", "full"]),
  "checks.verifySolution": new Set(["use-general-tokens", "wait", "interval", "timeout", "full"]),
  "checks.verifyFlakiness": new Set(["use-general-tokens", "wait", "interval", "timeout", "full"]),
  "checks.testQuality": new Set(["use-general-tokens", "wait", "interval", "timeout", "full"]),
  "checks.taskQuality": new Set(["use-general-tokens", "wait", "interval", "timeout", "full"]),
  "checks.solutionQuality": new Set(["use-general-tokens", "wait", "interval", "timeout", "full"]),
  "checks.descriptionQuality": new Set([
    "use-general-tokens",
    "wait",
    "interval",
    "timeout",
    "full",
  ]),
  "checks.verifierIncompleteness": new Set([
    "version",
    "use-general-tokens",
    "wait",
    "interval",
    "timeout",
    "full",
  ]),
  "checks.autoReview": new Set([
    "version",
    "use-general-tokens",
    "wait",
    "interval",
    "timeout",
    "full",
  ]),
  "rollouts.run": new Set([
    "solver",
    "evaluator",
    "count",
    "preset",
    "hinted",
    "batch-name",
    "use-general-tokens",
    "wait",
    "interval",
    "timeout",
    "full",
  ]),
  "re_evaluation.run": new Set(["use-general-tokens", "wait", "interval", "timeout", "full"]),
  "fp_check.run": new Set(["version", "use-general-tokens", "wait", "interval", "timeout", "full"]),
  "verifier_audit.decide": new Set(["version", "job", "decision", "patch-file", "comment"]),
  "auto_review.orchestrate": new Set(["version", "force-fresh"]),
  "submission.submit": new Set(),
};

const actionDescriptions: Record<PolicyAction, string> = {
  "artifacts.update": "Update challenge artifacts",
  "image.build": "Build the current version image",
  "prechecks.run": "Run the bundled prechecks",
  "scope_gate.run": "Run the scope gate",
  "checks.run_all": "Run an explicitly selected set of dynamic checks",
  "checks.verifyTests": "Run Verify Tests",
  "checks.verifySolution": "Run Verify Solution",
  "checks.verifyFlakiness": "Run Verify Flakiness",
  "checks.testQuality": "Run Test Quality",
  "checks.taskQuality": "Run Task Quality",
  "checks.solutionQuality": "Run Solution Quality",
  "checks.descriptionQuality": "Run Description Quality",
  "checks.verifierIncompleteness": "Run Verifier Incompleteness",
  "checks.autoReview": "Run Auto Review",
  "rollouts.run": "Start rollout runs",
  "re_evaluation.run": "Start re-evaluation runs",
  "fp_check.run": "Start an FP Check",
  "verifier_audit.decide": "Submit a verifier audit decision",
  "auto_review.orchestrate": "Start Auto Review orchestration",
  "submission.submit": "Submit the current draft",
};

export function policyActionCatalog(): Array<{
  action: PolicyAction;
  description: string;
  command: string[];
  configurableArguments: string[];
}> {
  return POLICY_ACTIONS.map((action) => ({
    action,
    description: actionDescriptions[action],
    command: actionCommands[action],
    configurableArguments: [...actionOptions[action]].toSorted(),
  }));
}
const challengeId = (value: unknown): value is string =>
  typeof value === "string"
  && !!value.trim()
  && !value.startsWith("-")
  // eslint-disable-next-line no-control-regex -- Reject control characters in IDs.
  && !/[\0-\x1f\x7f]/.test(value);

function flags(values: Json, allowed: Set<string>): string[] {
  const result: string[] = [];
  for (const name of Object.keys(values).toSorted()) {
    if (!allowed.has(name)) throw new Error(`Unsupported argument for this operation: ${name}`);
    const value = values[name];
    if (value === undefined || value === false || value === null) continue;
    if (value === true) result.push(`--${name}`);
    else if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      result.push(`--${name}=${value.join(",")}`);
    else if (["string", "number"].includes(typeof value)) result.push(`--${name}=${String(value)}`);
    else throw new Error(`Argument ${name} must be a string, number, boolean, or string array`);
  }
  return result;
}

export function actionCliArguments(input: {
  action: PolicyAction;
  challengeId: string;
  arguments?: Json;
}): string[] {
  if (!POLICY_ACTIONS.includes(input.action))
    throw new Error(`Unknown policy action: ${input.action}`);
  if (!challengeId(input.challengeId))
    throw new Error("challengeId must be a non-option string without control characters");
  const values = { ...input.arguments };
  const command = actionCommands[input.action];
  const fixedCheck =
    input.action.startsWith("checks.")
    && !["checks.run_all", "checks.verifierIncompleteness", "checks.autoReview"].includes(
      input.action,
    )
      ? input.action.slice("checks.".length)
      : undefined;
  if (input.action === "checks.run_all" && !Array.isArray(values.checks)) {
    throw new Error("checks.run_all requires an explicit checks array; no default set is inferred");
  }
  if (input.action === "verifier_audit.decide" && typeof values.decision !== "string")
    throw new Error("verifier_audit.decide requires decision");
  if (input.action === "artifacts.update" && Object.keys(values).length === 0)
    throw new Error("artifacts.update requires at least one update argument");
  if (
    input.action === "rollouts.run"
    && values.preset === undefined
    && (values.solver === undefined || values.evaluator === undefined)
  )
    throw new Error("rollouts.run requires preset or solver and evaluator");
  const result = [
    ...command,
    input.challengeId,
    ...(fixedCheck ? [`--check=${fixedCheck}`] : []),
    ...flags(values, actionOptions[input.action]),
    "--json",
  ];
  return result;
}
