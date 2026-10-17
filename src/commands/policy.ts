import {
  describeActual,
  describeCondition,
  describeShortfall,
  type ConditionPredicate,
} from "../core/policy-language.ts";
import { defineCommand } from "citty";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
  openSync,
  closeSync,
  copyFileSync,
  constants,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { parseDocument } from "yaml";
import { dirname, resolve } from "node:path";
import {
  defaultPolicyYaml,
  inspectPolicy,
  policyDecisionFeedback,
  loadPolicy,
  parsePolicy,
  policyPath,
  policySchema,
} from "../core/policy.ts";
import { getClient } from "../platform/convex.ts";
import { readPolicyNote, acknowledgePolicyNote } from "../core/policy-notes.ts";
import { formatDynamicCheckLabel } from "../core/model.ts";
import { toPublicCheckKey } from "../core/expected.ts";
import {
  evaluatePredicate,
  type Predicate,
  type PolicyAction,
  type PolicyNode,
} from "../core/policy-graph.ts";
import { printJson } from "../terminal/format.ts";
import {
  policyFlowLines,
  type PolicyFlowState,
  runStructuredPolicyEditor,
} from "../core/policy-editor.ts";

type Policy = ReturnType<typeof loadPolicy>;
type Inspection = Awaited<ReturnType<typeof inspectPolicy>>;
type Graph = NonNullable<Policy["graph"]>;
type Guidance = Inspection["guidance"];
type PolicyLine = (text?: string, prefix?: string, color?: string) => void;

function policyPrinter(): PolicyLine {
  const columns = process.stdout.columns ?? Number(process.env.COLUMNS);
  const width = Number.isFinite(columns) && columns > 0 ? Math.min(100, columns) : 96;
  const colorEnabled =
    process.stdout.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";
  return (text = "", prefix = "  ", color = "") => {
    if (!text) {
      console.log();
      return;
    }
    const indent = prefix.slice(0, Math.max(0, width - 1));
    const available = Math.max(1, width - indent.length);
    let remaining = text.replaceAll(/[\p{Cc}\p{Cf}]/gu, " ").trim();
    const rows: string[] = [];
    while (remaining.length > available) {
      const space = remaining.lastIndexOf(" ", available);
      const end = space > 0 ? space : available;
      rows.push(indent + remaining.slice(0, end));
      remaining = remaining.slice(end).trimStart();
    }
    rows.push(indent + remaining);
    for (const row of rows) {
      if (colorEnabled && color) console.log(`\x1b[${color}m${row}\x1b[0m`);
      else console.log(row);
    }
  };
}

function humanValue(value: unknown): string {
  if (value === undefined) return "unknown";
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(humanValue).join(", ") || "none";
  if (typeof value === "object")
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${humanValue(item)}`)
      .join("; ");
  return String(value);
}

function humanName(value: string): string {
  const words = value.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/[._-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function configuredCheckKeys(
  arguments_: Record<string, unknown> | undefined,
  command: string[] | null | undefined,
): string[] {
  const flag = command?.find((argument) => argument.startsWith("--checks="));
  const commandKeys = flag?.slice("--checks=".length).split(",").filter(Boolean) ?? [];
  const argumentKeys = Array.isArray(arguments_?.checks)
    ? arguments_.checks.filter((key): key is string => typeof key === "string")
    : [];
  return [...new Set(commandKeys.length > 0 ? commandKeys : argumentKeys)];
}

function actionLabel(
  action: string,
  arguments_?: Record<string, unknown>,
  command?: string[] | null,
): string {
  if (action === "checks.run_all") {
    const checks = configuredCheckKeys(arguments_, command);
    return checks.length > 0
      ? checks.map(formatDynamicCheckLabel).join(" + ")
      : "Checks (names unavailable)";
  }
  const labels: Record<string, string> = {
    "artifacts.update": "Update artifacts",
    "image.build": "Build image",
    "prechecks.run": "Prechecks",
    "scope_gate.run": "Scope Gate",
    "rollouts.run": "Rollouts",
    "re_evaluation.run": "Re-evaluation",
    "fp_check.run": "FP Check",
    "verifier_audit.decide": "Verifier audit decision",
    "auto_review.orchestrate": "Auto Review orchestration",
    "submission.submit": "Submit",
  };
  if (labels[action]) return labels[action];
  if (action.startsWith("checks.")) return formatDynamicCheckLabel(action.slice(7));
  return humanName(action);
}

function permission(value: boolean | null): string {
  if (value === null) return "not configured";
  return value ? "allowed" : "blocked";
}

function localLimit(value: number | null): string {
  return value === null ? "not configured" : String(value);
}

function selectionRule(value: boolean | null): string {
  if (value === null) return "not configured";
  return value ? "required" : "optional";
}

function renderRules(policy: Policy, line: PolicyLine): void {
  const caps = Object.entries(policy.runs.max_runs).map(([model, cap]) => {
    if (cap == null) return `${humanName(model)}: not configured`;
    return cap === 0 ? `${humanName(model)} blocked` : `${humanName(model)} ≤ ${cap}`;
  });
  const groups: Array<[string, Array<[string, string]>]> = [
    [
      "Runs",
      [
        ["Model caps", caps.join(" · ") || "not configured"],
        ["Full preset", permission(policy.runs.allow_full_preset)],
        ["Manual batch names", permission(policy.runs.allow_manual_batch_name)],
        ["Cancellations", permission(policy.runs.allow_cancellations)],
        ["Contests", permission(policy.runs.allow_contests)],
        ["Re-evaluation", permission(policy.runs.re_evaluation.enabled)],
        [
          "Block new runs when available",
          permission(policy.runs.re_evaluation.block_new_runs_when_available),
        ],
        ["Re-evaluation attempts", localLimit(policy.runs.re_evaluation.max_attempts)],
      ],
    ],
    [
      "Tokens",
      [
        ["General tokens", permission(policy.tokens.allow_general_tokens)],
        ["Challenge budget", localLimit(policy.tokens.challenge_budget)],
        ["Minimum balance", localLimit(policy.tokens.min_remaining_balance)],
      ],
    ],
    [
      "Checks",
      [
        [
          "Allowed checks",
          policy.checks.allowed === null
            ? "not configured"
            : policy.checks.allowed.map(formatDynamicCheckLabel).join(", ") || "none (all blocked)",
        ],
        ["Explicit selection", selectionRule(policy.checks.require_explicit_selection)],
        ["Rerun current PASS", permission(policy.checks.allow_rerun_passing)],
        ["Per-request cap", localLimit(policy.checks.max_checks_per_request)],
        ["Active-check cap", localLimit(policy.checks.max_active)],
        ["Contests", permission(policy.checks.allow_contests)],
      ],
    ],
    ["Auto Review", [["Forced refresh", permission(policy.auto_review.allow_force_refresh)]]],
  ];
  line("RULES", "", "1;36");
  for (const [title, entries] of groups) {
    line(title, "  ", "1");
    for (const [label, value] of entries) line(`${label.padEnd(24)} ${value}`, "    ");
  }
  line(
    "Not configured = no local restriction. Zero is an active limit; platform limits still apply.",
    "  ",
    "90",
  );
}

function predicateLabel(predicate: Predicate): string {
  return describeCondition(predicate as ConditionPredicate);
}

function nodeLines(node: PolicyNode, graph: Graph, full: boolean): string[] {
  const rows: string[] = [];
  if (node.requires.length > 0) rows.push(`Requires: ${node.requires.map(humanName).join(" + ")}`);
  if (node.requires_when?.length)
    rows.push(`Only when: ${node.requires_when.map(predicateLabel).join(" AND ")}`);
  if (node.unless?.length)
    rows.push(
      `Except when: ${node.unless.map((group) => `(${group.map(predicateLabel).join(" AND ")})`).join(" OR ")}`,
    );
  if (node.on_unmet)
    rows.push(`If unmet → ${actionLabel(node.on_unmet, graph.actions[node.on_unmet]?.arguments)}`);
  for (const transition of node.next) {
    const target =
      transition.action === null
        ? "End"
        : actionLabel(transition.action, graph.actions[transition.action]?.arguments);
    rows.push(
      `Then → ${target} when ${transition.all.map(predicateLabel).join(" AND ") || "always"}`,
    );
  }

  if (full && node.arguments && Object.keys(node.arguments).length > 0)
    rows.push(`Arguments: ${humanValue(node.arguments)}`);
  return rows;
}

function renderGraph(graph: Graph | null, line: PolicyLine, full: boolean): void {
  line();
  line("ACTION GRAPH", "", "1;36");
  if (!graph) {
    line("Not configured. No sequence or dependencies are imposed.");
    return;
  }
  const modes = { off: "Inactive", advise: "Advisory", enforce: "Enforced" };
  const nodes = Object.entries(graph.actions);
  line(`${modes[graph.mode]} · ${nodes.length} actions · ${Object.keys(graph.gates).length} gates`);
  if (graph.mode === "advise" && graph.confirmation)
    line(
      `Advisory deviations need confirmation (expires after ${graph.confirmation.expires_after}); enforced rules cannot be overridden.`,
    );
  if (graph.mode === "off")
    line("The configuration below is inactive; it imposes no graph restrictions.");

  if (graph.repair_first?.length)
    line(
      `Repair priority for stale FAIL/error: ${graph.repair_first.map(formatDynamicCheckLabel).join(", ")}`,
    );
  if (graph.rules?.length) line(`Rules: ${graph.rules.join(", ")}`);
  line("Eligible paths are inferred from transition conditions and requirements.", "  ", "90");
  nodes.forEach(([action, node], index) => {
    const last = index === nodes.length - 1;
    let mode = modes[graph.mode].toLowerCase();
    if (graph.mode !== "off" && node.enforce) mode = "enforced";
    const label = actionLabel(action, node.arguments);
    const title = full ? `${label} (${action})` : label;
    line(`${title} [${mode}]`, last ? "  └─ " : "  ├─ ", "1");
    for (const row of nodeLines(node, graph, full)) line(row, last ? "     " : "  │  ");
  });
  if (full) renderGraphDetails(graph, line);
  else
    line(
      `${graph.notes.length} conditional notes. Use --full for gate definitions, arguments and notes.`,
      "  ",
      "90",
    );
}

function renderGraphDetails(graph: Graph, line: PolicyLine): void {
  line();
  line("GATE DEFINITIONS · all conditions must match", "", "1;36");
  for (const [name, gate] of Object.entries(graph.gates)) {
    line(
      `${humanName(name)} [${name}] · ${gate.check ? formatDynamicCheckLabel(gate.check) : "canonical state"}`,
      "  ",
      "1",
    );
    for (const condition of gate.all) line(predicateLabel(condition), "    · ");
  }
  if (graph.notes.length === 0) return;
  line();
  line("CONDITIONAL NOTES", "", "1;36");
  for (const note of graph.notes) {
    line(`${note.severity.toUpperCase()} · ${note.id}`, "  ", "1");
    line(
      `When ${note.when.check ?? "canonical state"}: ${note.when.all.map(predicateLabel).join(" AND ")}`,
      "    ",
    );
    line(note.message, "    ");
  }
}

function renderBlockers(
  decision: Inspection["decisions"][number],
  policy: Policy,
  line: PolicyLine,
  full: boolean,
): void {
  line(
    actionLabel(
      decision.action,
      policy.graph?.actions[decision.action]?.arguments,
      decision.recommendedCommand,
    ),
    "    · ",
    "1",
  );
  if (decision.rule === "checks.allow_rerun_passing" && !full) {
    line("Already PASS and current; reruns are disabled by policy.", "      ");
    if (decision.unmetRequirements.length > 1)
      line(
        `${decision.unmetRequirements.length - 1} additional unmet conditions; use --full.`,
        "      ",
      );
  } else {
    const { feedback } = policyDecisionFeedback(decision);
    const failures = full ? feedback.failures : feedback.failures.slice(0, 3);
    for (const failure of failures) {
      line(`${humanName(failure.profile)} / ${failure.path}`, "      ");
      line(
        `Expected ${humanValue(failure.expected)}; actual ${humanValue(failure.actual)}`,
        "        ",
      );
    }
    if (feedback.failures.length > failures.length)
      line(
        `${feedback.failures.length - failures.length} more unmet conditions; use --full.`,
        "      ",
      );
  }
  if (decision.recommendedAction)
    line(
      `Suggested → ${actionLabel(
        decision.recommendedAction,
        policy.graph?.actions[decision.recommendedAction]?.arguments,
        decision.recommendedCommand,
      )}`,
      "      ",
    );
  if (decision.recommendationError)
    line(`Arguments needed: ${decision.recommendationError}`, "      ");
}

function renderCommand(
  arguments_: string[],
  line: PolicyLine,
  label = "Command (copy as one line):",
  prefix = "",
): void {
  if (arguments_.some((argument) => /[\p{Cc}\p{Cf}]/u.test(argument))) {
    line("Command contains control characters; use --json for the exact arguments.", prefix);
    return;
  }
  const command = arguments_
    .map((argument) => {
      if (/^[A-Za-z0-9_./:=+-]+$/.test(argument)) return argument;
      const quoted = argument.replaceAll("'", "'\"'\"'");
      return `'${quoted}'`;
    })
    .join(" ");
  line(label, prefix);
  console.log(`${prefix}    ${command}`);
}

function renderInspection(
  inspection: Inspection,
  policy: Policy,
  line: PolicyLine,
  full: boolean,
): void {
  line(`Challenge ${inspection.challengeId}`);
  line(`Version   ${inspection.versionId}`);
  line();
  line("CURRENT DECISIONS", "", "1;36");
  const groups = [
    ["blocked", "× BLOCKED", "31"],
    ["confirmation_required", "! CONFIRMATION REQUIRED", "33"],
    ["allowed", "✓ NO POLICY BLOCKER", "32"],
    ["off", "○ NOT GOVERNED", "90"],
  ] as const;
  for (const [status, label, color] of groups) {
    const decisions = inspection.decisions.filter((item) => item.status === status);
    if (decisions.length === 0) continue;
    line(`${label} (${decisions.length})`, "  ", color);
    if (status === "blocked" || status === "confirmation_required") {
      for (const decision of decisions) renderBlockers(decision, policy, line, full);
    } else
      line(
        decisions
          .map((item) => actionLabel(item.action, policy.graph?.actions[item.action]?.arguments))
          .join(", "),
        "    ",
      );
  }
  line();
  const next = inspection.decision?.recommendedCommand;
  if (next?.length) {
    if (inspection.decision?.recommendedAction)
      line(
        `Suggested action: ${actionLabel(
          inspection.decision.recommendedAction,
          policy.graph?.actions[inspection.decision.recommendedAction]?.arguments,
          next,
        )}`,
        "  ",
        "1",
      );
    renderCommand(next, line);
  } else line("No executable next command is configured; no action is inferred.");
  if (inspection.decision?.recommendationError)
    line(`Arguments needed: ${inspection.decision.recommendationError}`);
  const notes = new Map(
    inspection.decisions.flatMap((item) => item.notes).map((note) => [note.id, note]),
  );
  for (const note of notes.values()) line(`${note.severity.toUpperCase()}: ${note.message}`);
  let readiness = "unknown";
  if (inspection.platform.canSubmit !== null)
    readiness = inspection.platform.canSubmit ? "yes" : "no";
  line(`Platform submission readiness: ${readiness}`);
  line(
    "Read-only snapshot, not execution permission. Arguments, capacity, cost, budget and platform prerequisites are rechecked on execution.",
    "  ",
    "90",
  );
}

function guidanceStatusColor(status: Guidance["status"]): string {
  if (status === "ready") return "1;32";
  if (status === "blocked" || status === "terminal" || status === "stuck") return "1;31";
  return "1;33";
}

function checkMeetsAcceptanceGate(
  check: Record<string, unknown>,
  key: string,
  policy: Policy,
): boolean {
  const gate = Object.values(policy.graph?.gates ?? {}).find(
    (candidate) =>
      typeof candidate?.check === "string"
      && toPublicCheckKey(candidate.check) === toPublicCheckKey(key),
  );
  if (!gate) return true;
  return gate.all.every((predicate) => {
    const result = evaluatePredicate(check, predicate);
    if (result.pass) return true;
    return (
      result.reason === "missing_field"
      && predicate.equals === false
      && /^checkInputs\.(description|tests|solution|dockerfile)\.changedSinceCheck$/.test(
        predicate.path,
      )
    );
  });
}

function challengeFlowState(inspection: Inspection, policy: Policy): PolicyFlowState {
  const state = inspection.state as any;
  const details: Record<string, string> = {};
  const statuses: NonNullable<PolicyFlowState["statuses"]> = {};
  const activeActions: string[] = [];
  const checks = state?.checks && typeof state.checks === "object" ? state.checks : {};
  const configuredActions = policy.graph?.actions ?? {};
  const checkActions: Record<string, string> = {};
  for (const [action, node] of Object.entries(configuredActions)) {
    if (action === "checks.run_all") {
      const selected = Array.isArray(node?.arguments?.checks) ? node.arguments.checks : [];
      if (selected.length === 1) checkActions[action] = String(selected[0]);
    } else if (action.startsWith("checks.")) checkActions[action] = action.slice("checks.".length);
  }
  for (const [action, key] of Object.entries(checkActions)) {
    const check = checks[key];
    if (!check || typeof check !== "object") {
      statuses[action] = "pending";
      continue;
    }
    const checkStatus = String(check.status).toLowerCase();
    const verdict = String(check.output?.verdict ?? "").toUpperCase();
    const accepted = checkMeetsAcceptanceGate(check, key, policy);
    if (check.stale === true) statuses[action] = "stale";
    else if (["pending", "queued", "running", "in_progress"].includes(checkStatus))
      statuses[action] = "running";
    else if (verdict === "PASS" || checkStatus === "pass")
      statuses[action] = accepted ? "pass" : "fail";
    else if (verdict === "FAIL" || ["fail", "failed", "error"].includes(checkStatus))
      statuses[action] = "fail";
    else statuses[action] = "pending";
    if (
      ["pending", "queued", "running", "in_progress"].includes(String(check.status).toLowerCase())
    )
      activeActions.push(action);
  }

  const criteria = Array.isArray(state?.readiness?.criteria) ? state.readiness.criteria : [];
  const prechecks = criteria.find((criterion: any) => criterion?.id === "prechecks");
  const latestPrechecks = new Map<string, any>();
  if (prechecks) {
    const parts: string[] = [];
    if (prechecks.detail) parts.push(String(prechecks.detail));
    const latest = latestPrechecks;
    for (const stage of Array.isArray(state?.prechecks) ? state.prechecks : []) {
      const key = String(stage?.stageId ?? stage?.id ?? "");
      const timestamp = stage?.completedAt ?? stage?.createdAt ?? stage?._creationTime ?? 0;
      const previous = latest.get(key);
      const previousTimestamp =
        previous?.completedAt ?? previous?.createdAt ?? previous?._creationTime ?? -1;
      if (key && timestamp >= previousTimestamp) latest.set(key, stage);
    }
    const failed = [...latest.values()]
      .filter((stage) => ["fail", "failed", "error"].includes(String(stage?.status).toLowerCase()))
      .map((stage) => String(stage.stageName ?? stage.name ?? stage.stageId));
    if (failed.length > 0) parts.push(`${failed.join(", ")} failed`);
    if (parts.length > 0) details["prechecks.run"] = parts.join(" · ");
    const precheckStatus = String(prechecks.status).toLowerCase();
    if (prechecks.stale === true) statuses["prechecks.run"] = "stale";
    else if (precheckStatus === "pass") statuses["prechecks.run"] = "pass";
    else if (["fail", "failed", "error"].includes(precheckStatus))
      statuses["prechecks.run"] = "fail";
    else if (["pending", "queued", "running", "in_progress"].includes(precheckStatus))
      statuses["prechecks.run"] = "running";
    else statuses["prechecks.run"] = "pending";
  }
  if (
    [...latestPrechecks.values()].some((stage: any) =>
      ["pending", "queued", "running", "in_progress"].includes(String(stage?.status).toLowerCase()),
    )
  )
    activeActions.push("prechecks.run");

  const scopeGate = state?.scopeGate;
  if (scopeGate) {
    if (scopeGate.inFlight === true) {
      statuses["scope_gate.run"] = "running";
      activeActions.push("scope_gate.run");
    } else if (scopeGate.latestVerdict) {
      if (scopeGate.fresh)
        statuses["scope_gate.run"] =
          String(scopeGate.latestVerdict).toLowerCase() === "pass" ? "pass" : "fail";
      else statuses["scope_gate.run"] = "stale";
    } else {
      statuses["scope_gate.run"] = "pending";
    }
  }

  const runs = (Array.isArray(state?.runs) ? state.runs : []).filter(
    (run: any) => run?.stale !== true,
  );
  if (runs.length === 0) {
    statuses["rollouts.run"] = "pending";
  } else {
    const running = runs.filter((run: any) =>
      ["pending", "queued", "running", "in_progress"].includes(String(run?.status).toLowerCase()),
    ).length;
    details["rollouts.run"] =
      running > 0 ? `${running} running · ${runs.length} total` : `${runs.length} total`;
    statuses["rollouts.run"] = running > 0 ? "running" : "pass";
    if (running > 0) activeActions.push("rollouts.run");
  }

  return {
    currentActions: inspection.guidance.nextActions,
    activeActions: [...new Set(activeActions)],
    status: inspection.guidance.status,
    details,
    statuses,
  };
}

const nodeArguments = (policy: Policy, action: string): Record<string, unknown> | undefined =>
  (policy.graph?.actions as Record<string, { arguments?: Record<string, unknown> }> | undefined)?.[
    action
  ]?.arguments;

const STEP_MARKS: Record<string, [string, string, string]> = {
  pass: ["✓", "passed", "32"],
  fail: ["✗", "failed", "31"],
  running: ["●", "running", "33"],
  stale: ["↻", "out of date", "33"],
  pending: ["○", "not done", "90"],
};

function guidanceSummary(inspection: Inspection, policy: Policy): string {
  const guidance = inspection.guidance;
  const label = (action: string | null | undefined) =>
    action ? actionLabel(action, nodeArguments(policy, action)) : "the next action";
  const actions = guidance.nextActions.length > 0 ? guidance.nextActions : [guidance.nextAction];
  const names = actions.filter(Boolean).map(label).join(", ");
  const fixed: Partial<Record<Guidance["status"], string>> = {
    waiting: "Waiting: an action is still running; refresh when it finishes",
    terminal: "Done: the graph reached its end for this challenge",
    complete: "No next action: the graph has nothing left to run",
    stuck: "Stuck: no allowed action can make progress",
    unguided: "No action graph is configured",
  };
  if (fixed[guidance.status]) return fixed[guidance.status]!;
  if (guidance.status === "blocked")
    return `Blocked at ${label(guidance.nextAction ?? guidance.expectedAction)}: see what is missing below`;
  if (guidance.status === "confirmation_required")
    return `Needs confirmation: ${names || label(guidance.expectedAction)} is off the graph's path`;
  if (guidance.status === "needs_arguments")
    return `Needs arguments: ${names || label(guidance.expectedAction)}`;
  const target =
    guidance.expectedAction && !actions.includes(guidance.expectedAction)
      ? ` — needed before ${label(guidance.expectedAction)}`
      : "";
  return actions.length > 1
    ? `Next: ${names} can start together${target}`
    : `Next: ${names} is ready to run${target}`;
}

const PIPELINE_ORDER = [
  "artifacts.update",
  "prechecks.run",
  "scope_gate.run",
  "image.build",
  "checks.verifyTests",
  "checks.verifySolution",
  "checks.testQuality",
  "checks.verifyFlakiness",
  "checks.taskQuality",
  "checks.solutionQuality",
  "checks.descriptionQuality",
  "checks.run_all",
  "rollouts.run",
  "re_evaluation.run",
  "fp_check.run",
  "checks.verifierIncompleteness",
  "verifier_audit.decide",
  "checks.rolloutCoach",
  "checks.autoReview",
  "auto_review.orchestrate",
  "submission.submit",
];

function renderGuidanceSteps(inspection: Inspection, policy: Policy, line: PolicyLine): void {
  const rank = (action: string) => {
    const index = PIPELINE_ORDER.indexOf(action);
    return index === -1 ? PIPELINE_ORDER.length : index;
  };
  const actions = Object.keys(policy.graph?.actions ?? {}).toSorted(
    (left, right) => rank(left) - rank(right),
  );
  if (actions.length === 0) return;
  const flow = challengeFlowState(inspection, policy);
  const next = new Set<string>(inspection.guidance.nextActions);
  const width = Math.max(
    ...actions.map((action) => actionLabel(action, nodeArguments(policy, action)).length),
  );
  line("STEPS", "", "1;36");
  for (const action of actions) {
    const status = flow.statuses?.[action] ?? "pending";
    const [mark, word, color] = STEP_MARKS[status];
    const isNext = next.has(action);
    const detail = flow.details?.[action];
    line(
      `${isNext ? "→" : mark} ${actionLabel(action, nodeArguments(policy, action)).padEnd(width)}  ${isNext ? "next" : word}${detail ? ` · ${detail}` : ""}`,
      "  ",
      isNext ? "1;36" : color,
    );
  }
}

function renderGuidanceMissing(steps: Guidance["steps"], line: PolicyLine, full: boolean): void {
  const missing = [
    ...new Map(
      steps
        .flatMap((step) => step.unmetRequirements)
        .map((failure) => {
          const expected =
            failure.expected && typeof failure.expected === "object"
              ? (failure.expected as Record<string, unknown>)
              : null;
          const predicate = expected ? { path: failure.path, ...expected } : null;
          const key = predicate
            ? describeCondition(predicate, failure.check)
            : `${humanName(failure.profile)}: ${humanValue(failure.expected)}`;
          return [
            key,
            predicate
              ? describeShortfall(predicate, failure.check, failure.actual)
              : `${key} (now: ${describeActual(failure.actual)})`,
          ];
        }),
    ).values(),
  ];
  if (missing.length === 0) return;
  line("WHAT IS MISSING", "", "1;36");
  const shown = full ? missing : missing.slice(0, 5);
  for (const item of shown) line(`• ${item}`, "  ");
  if (missing.length > shown.length)
    line(`${missing.length - shown.length} more; use --full.`, "  ", "90");
}

function renderGuidance(
  inspection: Inspection,
  policy: Policy,
  line: PolicyLine,
  full: boolean,
): void {
  const guidance = inspection.guidance;
  const state = (inspection as { state?: any }).state;
  const title = typeof state?.problem?.title === "string" ? state.problem.title : null;
  const version = typeof state?.version?.version === "number" ? `v${state.version.version}` : null;
  if (title) line(title, "  ", "1");
  line([version, inspection.challengeId].filter(Boolean).join("  ·  "), "  ", "90");
  line(guidanceSummary(inspection, policy), "  ", guidanceStatusColor(guidance.status));
  if (guidance.mode !== "enforce" && policy.graph)
    line(
      guidance.mode === "advise"
        ? "Advisory graph: other actions are allowed after confirmation."
        : "The graph is off: actions are not sequenced.",
      "  ",
      "90",
    );
  if (guidance.options.length > 1)
    guidance.options.forEach((option, index) => {
      line(
        `${index + 1}. ${actionLabel(option.action, nodeArguments(policy, option.action), option.command)}${option.status === "ready" ? "" : ` · ${option.status.replaceAll("_", " ")}`}`,
        "    ",
      );
      if (option.recommendationError) line(`Arguments: ${option.recommendationError}`, "      ");
    });
  if (guidance.nextCommand) renderCommand(guidance.nextCommand, line, "Run:");
  else if (guidance.proposedCommand) renderCommand(guidance.proposedCommand, line, "Proposed:");
  if (policy.graph && policy.graph.mode !== "off") renderGuidanceSteps(inspection, policy, line);
  renderGuidanceMissing(guidance.steps, line, full);
  if (full && policy.graph && policy.graph.mode !== "off") {
    line("FLOW", "", "1;36");
    const flowColors = Boolean(
      process.stdout.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb",
    );
    for (const row of policyFlowLines(policy, flowColors, challengeFlowState(inspection, policy)))
      console.log(row);
  }
  if (guidance.notes.length > 0) {
    line("NOTES", "", "1;36");
    line(
      `${guidance.notes.length} applicable; ${guidance.pendingNotes.length} awaiting acknowledgment.`,
      "  ",
    );
    line(`Read them: olympus policy notes list ${inspection.challengeId}`, "  ");
  }
  renderCommand(guidance.refreshCommand, line, "Refresh:");
  if (!full) line("Full flow and every decision: add --full.", "  ", "90");
}

function renderPolicyView(
  result: { path: string; source: string; policy: Policy },
  inspection: Inspection | undefined,
  full: boolean,
): void {
  const line = policyPrinter();
  line("OLYMPUS POLICY", "", "1;36");
  line(result.path, "  ", "90");
  if (result.source === "missing") line("No policy file. Local policy is inactive.");
  if (inspection) renderInspection(inspection, result.policy, line, full);
  if (!inspection || full) {
    line();
    renderRules(result.policy, line);
    renderGraph(result.policy.graph, line, full);
  }
  line();
  if (inspection)
    line(
      "Without an ID: rules and graph. --full: full details. --json: machine output.",
      "  ",
      "90",
    );
  else line("Inspect current decisions: olympus policy show <challenge-id>", "  ", "90");
}

const notesAcknowledge = defineCommand({
  meta: {
    name: "policy notes acknowledge",
    description: "Acknowledge a separately read current note",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    note: { type: "string", description: "Note ID", required: true },
    token: { type: "string", description: "Token returned by policy notes list", required: true },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const policy = loadPolicy();
    const inspection = await inspectPolicy(await getClient(), args.id, policy, true);
    if (
      !policy.graph
      || !inspection.state
      || !inspection.guidance.notes.some((n) => n.id === args.note)
    )
      throw new Error(`Note ${args.note} is not visible in the current policy guidance`);
    const result = acknowledgePolicyNote(inspection.state, policy.graph, args.note, args.token);
    if (args.json) return printJson(result);
    console.log(`Acknowledged ${result.id}; refresh policy guidance.`);
  },
});

const notesList = defineCommand({
  meta: {
    name: "policy notes list",
    description: "Show applicable notes and acknowledgment status",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const policy = loadPolicy();
    const inspection = await inspectPolicy(await getClient(), args.id, policy, true);
    const graph = policy.graph;
    const state = inspection.state;
    if (!graph || !state) throw new Error("No current policy state");
    const result = inspection.guidance.notes.map((note) => {
      const pending = inspection.guidance.pendingNotes.includes(note.id);
      return pending
        ? readPolicyNote(state, graph, note.id)
        : {
            id: note.id,
            severity: note.severity,
            message: note.message,
            requiresAck: false,
            token: null,
          };
    });
    if (args.json) return printJson({ challengeId: args.id, notes: result });
    if (result.length === 0) return console.log("No applicable notes.");
    for (const note of result) {
      console.log(`${note.id} [${note.severity}]\n${note.message}`);
      if (note.requiresAck)
        console.log(
          `Acknowledge: olympus policy notes acknowledge ${args.id} --note=${note.id} --token=${note.token}`,
        );
      console.log();
    }
  },
});

const notes = defineCommand({
  meta: { name: "policy notes", description: "Review and acknowledge policy notes" },
  subCommands: { list: notesList, acknowledge: notesAcknowledge },
});

const guide = defineCommand({
  meta: {
    name: "guide",
    alias: "next",
    description: "Show the state-aware action guidance and prerequisites",
  },
  args: {
    id: {
      type: "positional",
      description: "Challenge ID",
      required: true,
    },
    full: {
      type: "boolean",
      description: "Include all evaluated action decisions",
    },
    json: { type: "boolean", description: "Output compact JSON" },
  },
  run: async ({ args }) => {
    const policy = loadPolicy();
    const includeState = Boolean(args.full || !args.json);
    const inspection = await inspectPolicy(await getClient(), args.id, policy, includeState);
    const result: Record<string, unknown> = {
      status: "guided",
      challengeId: inspection.challengeId,
      versionId: inspection.versionId,
      guidance: {
        ...inspection.guidance,
        notes: inspection.guidance.notes.map((note) => ({
          id: note.id,
          severity: note.severity,
          requiresAcknowledgment: inspection.guidance.pendingNotes.includes(note.id),
        })),
        steps: inspection.guidance.steps.map(({ notes: _notes, ...step }) => step),
        options: inspection.guidance.options.map(({ notes: _notes, ...option }) => option),
      },
      workflowState: inspection.workflowState,
      audit: inspection.audit,
      platform: inspection.platform,
      executionPreflight: inspection.executionPreflight,
    };
    if (args.full) {
      result.decisions = inspection.decisions;
      if (inspection.state !== undefined) result.state = inspection.state;
    }
    if (args.json) return printJson(result);
    const line = policyPrinter();
    line("OLYMPUS POLICY GUIDE", "", "1;36");
    renderGuidance(inspection, policy, line, args.full ?? false);
  },
});

const show = defineCommand({
  meta: {
    name: "policy show",
    description: "Show the effective policy and optionally inspect a challenge",
  },
  args: {
    id: {
      type: "positional",
      description: "Optional challenge ID for state-aware policy inspection",
      required: false,
    },
    full: {
      type: "boolean",
      description: "Expand policy details; with --json and an ID, include canonical state",
    },
    json: { type: "boolean", description: "Output compact JSON" },
  },
  run: async ({ args }) => {
    const path = policyPath();
    const policy = loadPolicy();
    const inspection = args.id
      ? await inspectPolicy(await getClient(), args.id, policy, args.full)
      : undefined;
    const result = { path, source: existsSync(path) ? "file" : "missing", policy, ...inspection };
    if (args.json) return printJson(result);
    renderPolicyView(result, inspection, args.full ?? false);
  },
});

const init = defineCommand({
  meta: {
    name: "policy init",
    description: "Create a commented policy file without overwriting an existing one",
  },
  args: {
    json: { type: "boolean", description: "Output compact JSON" },
    "schema-only": {
      type: "boolean",
      description: "Refresh editor schema without changing policy values",
    },
  },
  run: ({ args }) => {
    const path = policyPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && !args["schema-only"])
      throw new Error(`Policy file already exists: ${path}`);
    writeFileSync(
      resolve(dirname(path), "policy.schema.json"),
      `${JSON.stringify(policySchema(), null, 2)}\n`,
      { mode: 0o600 },
    );
    if (args["schema-only"]) {
      const schemaPath = resolve(dirname(path), "policy.schema.json");
      if (args.json) return printJson({ status: "schema-updated", path: schemaPath });
      console.log(`Updated ${schemaPath}; policy values unchanged`);
      return;
    }
    writeFileSync(path, defaultPolicyYaml, { flag: "wx", mode: 0o600 });
    if (args.json) return printJson({ status: "created", path });
    console.log(`Created ${path}`);
  },
});

function editorAvailable(editor: string): boolean {
  const command = editor.trim().split(/\s+/, 1)[0];
  if (!command) return false;
  return (
    spawnSync("/bin/sh", ["-c", 'command -v -- "$1" >/dev/null 2>&1', "editor-check", command])
      .status === 0
  );
}

function resolvePolicyEditor(explicit?: string): string {
  const configured = explicit?.trim() || process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (configured) return configured;
  for (const candidate of ["micro", "nano", "vi"]) if (editorAvailable(candidate)) return candidate;
  throw new Error("No text editor found; install micro/nano or pass --editor=<command>");
}

const edit = defineCommand({
  meta: { name: "edit", description: "Edit policy in a structured terminal interface" },
  args: {
    key: {
      type: "positional",
      description: "Optional dotted key, such as tokens.challenge_budget",
      required: false,
    },
    value: {
      type: "positional",
      description: "New YAML value, such as 100, false, null or '[verifyTests]'",
      required: false,
    },
    json: {
      type: "boolean",
      description: "Output JSON; requires key and value (no interactive editor)",
    },
    raw: {
      type: "boolean",
      description: "Open the complete YAML in a text editor instead of the structured editor",
    },
    editor: {
      type: "string",
      description: "Text editor command for --raw or the TUI raw-editor shortcut",
    },
  },
  run: async ({ args }) => {
    const direct = args.key !== undefined;
    if (direct !== (args.value !== undefined))
      throw new Error("Provide both a policy key and a YAML value, or neither to open the editor");
    if (direct && !args.value!.trim())
      throw new Error("Provide an explicit YAML value; use null to disable an optional rule");
    if (!direct && args.json) throw new Error("JSON mode requires a policy key and a YAML value");
    const editor = direct ? undefined : resolvePolicyEditor(args.editor);
    const path = policyPath();
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockFd = openSync(
      resolve(directory, ".policy-edit.flock"),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const draft = resolve(directory, `.policy-edit-${randomUUID()}.yml`);
    try {
      const acquired = spawnSync("flock", ["-n", "3"], {
        stdio: ["ignore", "ignore", "pipe", lockFd],
      });
      if (acquired.error || (acquired.status !== 0 && acquired.status !== 1))
        throw new Error(
          "Cannot acquire the edit lock; policy edit requires working flock (util-linux)",
        );
      if (acquired.status === 1)
        throw new Error("Another policy edit is in progress; close that editor before retrying");
      if (existsSync(path) && !lstatSync(path).isFile())
        throw new Error("Policy path must be a regular file");
      const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      let text = original ?? "# yaml-language-server: $schema=./policy.schema.json\n{}\n";
      const canonical = parseDocument(text, { uniqueKeys: true, merge: false });
      if (canonical.has("workflow") && !canonical.has("graph")) {
        canonical.set("graph", canonical.get("workflow", true));
        canonical.delete("workflow");
        text = canonical.toString();
      }
      if (direct) {
        const keys = args.key!.split(".");
        if (keys[0] === "workflow") keys[0] = "graph";
        if (
          keys.some(
            (key) =>
              !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)
              || ["__proto__", "prototype", "constructor"].includes(key),
          )
        )
          throw new Error("Invalid dotted policy key");
        const doc = parseDocument(text, { uniqueKeys: true, merge: false });
        const value = parseDocument(args.value!, { uniqueKeys: true, merge: false });
        if (
          doc.errors.length > 0
          || doc.warnings.length > 0
          || value.errors.length > 0
          || value.warnings.length > 0
          || value.contents === null
        )
          throw new Error("Invalid or empty YAML value; policy unchanged");
        doc.toJS({ maxAliasCount: 0 });
        doc.setIn(keys, value.toJS({ maxAliasCount: 0 }));
        text = doc.toString();
      }
      writeFileSync(draft, text, { flag: "wx", mode: 0o600 });
      if (!direct) {
        writeFileSync(
          resolve(directory, "policy.schema.json"),
          `${JSON.stringify(policySchema(), null, 2)}\n`,
          { mode: 0o600 },
        );
        if (args.raw) {
          const result = spawnSync("/bin/sh", ["-c", `${editor!} "$1"`, "policy-editor", draft], {
            stdio: "inherit",
          });
          if (result.error || result.status !== 0)
            throw new Error("Editor failed or was interrupted; policy unchanged");
          text = readFileSync(draft, "utf8");
        } else {
          const outcome = await runStructuredPolicyEditor(text, { editor: editor!, path });
          if (outcome.status === "discard") {
            console.log(`Discarded changes to ${path}`);
            return;
          }
          if (outcome.status === "save") text = outcome.text;
          writeFileSync(draft, text, { mode: 0o600 });
        }
      }
      const policy = parsePolicy(text);
      const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      if (current !== original)
        throw new Error("Policy changed while editing; refusing to overwrite concurrent changes");
      writeFileSync(
        resolve(directory, "policy.schema.json"),
        `${JSON.stringify(policySchema(), null, 2)}\n`,
        { mode: 0o600 },
      );
      const changed = text !== original;
      if (changed) {
        if (original !== undefined) copyFileSync(path, `${path}.bak`);
        renameSync(draft, path);
      }
      const result = { status: changed ? "updated" : "unchanged", path, policy };
      if (args.json) return printJson(result);
      console.log(`${changed ? "Updated" : "Validated"} ${path}`);
    } finally {
      try {
        if (existsSync(draft)) unlinkSync(draft);
      } finally {
        closeSync(lockFd);
      }
    }
  },
});

function runNextCommand(command: string[]): Promise<{ exitCode: number; output: string }> {
  return new Promise((_resolve) => {
    const child = spawn(process.execPath, [process.argv[1], ...command.slice(1)], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length < 8192) output += chunk.toString("utf8").slice(0, 8192 - output.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => _resolve({ exitCode: 1, output: error.message }));
    child.on("close", (code) => _resolve({ exitCode: code ?? 1, output }));
  });
}

function remotePolicyActionStatus(
  inspection: Inspection | null,
  action: PolicyAction,
): "in_flight" | "ready" | "not_current" | "unknown" {
  if (!inspection) return "unknown";
  if (inspection.workflowState.actions.includes(action)) return "in_flight";
  if (inspection.guidance.nextActions.includes(action)) return "ready";
  return "not_current";
}

const runNext = defineCommand({
  meta: {
    name: "policy run-next",
    description: "Start every action in the current policy step",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    "dry-run": {
      type: "boolean",
      description: "Validate and print the next step without starting it",
    },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const policy = loadPolicy();
    const before = await inspectPolicy(client, args.id, policy, true);
    const guidance = before.guidance;
    const authorizations = guidance._authorizations ?? [];
    if (guidance.status !== "ready") {
      const waiting = {
        status: before.workflowState.status,
        challengeId: before.challengeId,
        versionId: before.versionId,
        guidanceStatus: guidance.status,
        nextActions: guidance.nextActions,
        pendingNotes: guidance.pendingNotes,
        explanation: guidance.explanation,
      };
      if (args.json) return printJson(waiting);
      console.log(
        `Remote workflow: ${waiting.status} (${waiting.guidanceStatus}); no action started.`,
      );
      return;
    }
    if (!guidance.stepId || authorizations.length === 0)
      throw new Error(`No runnable next step: ${guidance.status}`);

    if (args["dry-run"]) {
      const plan = {
        status: "ready",
        stepId: guidance.stepId,
        challengeId: before.challengeId,
        versionId: before.versionId,
        actions: authorizations.map((item) => item.action),
      };
      if (args.json) return printJson(plan);
      console.log(`Next step ${plan.stepId}: ${plan.actions.join(", ")}`);
      return;
    }

    const results = await Promise.all(
      authorizations.map(async (item) => ({
        item,
        result: await runNextCommand(item.command),
        retried: false,
      })),
    );
    const inspectAfter = async () => {
      let inspection: Inspection | null = null;
      let error: string | undefined;
      for (let attempt = 0; attempt < 2 && !inspection; attempt += 1) {
        try {
          inspection = await inspectPolicy(client, args.id, policy, true);
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
      }
      return { inspection, error };
    };
    let { inspection: after, error: postflightError } = await inspectAfter();
    // Sibling actions of one step dispatch concurrently, so one can observe the other's state change
    // before dispatching. That refusal happens before any charge: retry it once, sequentially, unless
    // the action is already running.
    const transient = /state changed|changed while it was being read/i;
    const retry = results.filter(
      ({ item, result }) =>
        result.exitCode !== 0
        && transient.test(result.output)
        && remotePolicyActionStatus(after, item.action) !== "in_flight",
    );
    for (const entry of retry) {
      entry.result = await runNextCommand(entry.item.command);
      entry.retried = true;
    }
    if (retry.length > 0) ({ inspection: after, error: postflightError } = await inspectAfter());
    // A command can exit nonzero after its job was created (for example a postflight read or a
    // balance check racing a sibling). The remote state decides whether the action started.
    const started = (item: (typeof results)[number]) =>
      item.result.exitCode === 0
      || remotePolicyActionStatus(after, item.item.action) === "in_flight";
    const failed = results.some((entry) => !started(entry));
    const report = {
      status: after?.workflowState.status ?? "unknown",
      stepId: guidance.stepId,
      challengeId: before.challengeId,
      versionId: before.versionId,
      started: results.filter(started).map(({ item }) => item.action),
      notStarted: results.filter((entry) => !started(entry)).map(({ item }) => item.action),
      actions: results.map((entry) => ({
        action: entry.item.action,
        started: started(entry),
        remoteStatus: remotePolicyActionStatus(after, entry.item.action),
        commandExitCode: entry.result.exitCode,
        ...(entry.retried ? { retried: true } : {}),
        ...(entry.result.exitCode !== 0 && entry.result.output
          ? { [started(entry) ? "warning" : "error"]: entry.result.output }
          : {}),
      })),
      remoteGuidance: {
        status: after?.guidance.status ?? "unknown",
        stepId: after?.guidance.stepId ?? null,
        nextActions: after?.guidance.nextActions ?? [],
        ...(postflightError ? { error: postflightError } : {}),
      },
    };
    if (args.json) {
      printJson(report);
      if (failed) process.exitCode = 1;
      return;
    }

    for (const entry of results) {
      const remoteStatus = remotePolicyActionStatus(after, entry.item.action);
      console.log(
        `${entry.item.action}: ${started(entry) ? "started" : "not started"}; remote ${remoteStatus}; command exit ${entry.result.exitCode}${entry.retried ? " (retried)" : ""}`,
      );
      if (entry.result.exitCode !== 0 && entry.result.output)
        console.error(entry.result.output.trim());
    }
    console.log(
      `Remote workflow: ${after?.workflowState.status ?? "unknown"}; next: ${after?.guidance.nextActions.join(", ") || "none"}`,
    );
    if (!after && postflightError)
      console.error(`Remote state could not be verified: ${postflightError}`);
    if (failed) process.exitCode = 1;
  },
});

export default defineCommand({
  meta: { name: "policy", description: "Configure policy rules and optional action graph" },
  subCommands: { guide, show, init, edit, notes, "run-next": runNext },
});
