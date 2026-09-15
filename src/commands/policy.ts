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
  constants,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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
import { formatDynamicCheckLabel } from "../core/model.ts";
import { type Predicate, type PolicyNode } from "../core/policy-graph.ts";
import { printJson } from "../terminal/format.ts";

type Policy = ReturnType<typeof loadPolicy>;
type Inspection = Awaited<ReturnType<typeof inspectPolicy>>;
type Graph = NonNullable<Policy["graph"]>;
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

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "artifacts.update": "Update artifacts",
    "image.build": "Build image",
    "prechecks.run": "Prechecks",
    "scope_gate.run": "Scope Gate",
    "checks.run_all": "Selected checks",
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
  if (Object.hasOwn(predicate, "equals"))
    return `${predicate.path} = ${humanValue(predicate.equals)}`;
  if (Object.hasOwn(predicate, "empty"))
    return `${predicate.path} ${predicate.empty ? "is empty" : "is not empty"}`;
  if (Object.hasOwn(predicate, "at_least")) return `${predicate.path} ≥ ${predicate.at_least}`;
  return `${predicate.path} > ${predicate.greater_than}`;
}

function nodeLines(node: PolicyNode, full: boolean): string[] {
  const rows: string[] = [];
  if (node.requires.length > 0) rows.push(`Requires: ${node.requires.map(humanName).join(" + ")}`);
  if (node.requires_when?.length)
    rows.push(`Only when: ${node.requires_when.map(predicateLabel).join(" AND ")}`);
  if (node.unless?.length)
    rows.push(
      `Except when: ${node.unless.map((group) => `(${group.map(predicateLabel).join(" AND ")})`).join(" OR ")}`,
    );
  if (node.on_unmet) rows.push(`If unmet → ${actionLabel(node.on_unmet)}`);
  for (const transition of node.next) {
    const target = transition.action === null ? "End" : actionLabel(transition.action);
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
  line(
    graph.start
      ? `Start → ${actionLabel(graph.start)}`
      : "No start configured: requirements only, no inferred sequence.",
  );
  if (graph.repair_first?.length)
    line(
      `Repair priority for stale FAIL/error: ${graph.repair_first.map(formatDynamicCheckLabel).join(", ")}`,
    );
  line(
    "Branches are configured actions, not an execution order. Requires lists named gates.",
    "  ",
    "90",
  );
  nodes.forEach(([action, node], index) => {
    const last = index === nodes.length - 1;
    let mode = modes[graph.mode].toLowerCase();
    if (graph.mode !== "off" && node.enforce) mode = "enforced";
    const title = full ? `${actionLabel(action)} (${action})` : actionLabel(action);
    line(`${title} [${mode}]`, last ? "  └─ " : "  ├─ ", "1");
    for (const row of nodeLines(node, full)) line(row, last ? "     " : "  │  ");
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
  line: PolicyLine,
  full: boolean,
): void {
  line(actionLabel(decision.action), "    · ", "1");
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
    line(`Suggested → ${actionLabel(decision.recommendedAction)}`, "      ");
  if (decision.recommendationError)
    line(`Arguments needed: ${decision.recommendationError}`, "      ");
}

function renderCommand(arguments_: string[], line: PolicyLine): void {
  if (arguments_.some((argument) => /[\p{Cc}\p{Cf}]/u.test(argument))) {
    line("Command contains control characters; use --json for the exact arguments.");
    return;
  }
  const command = arguments_
    .map((argument) => {
      if (/^[A-Za-z0-9_./:=+-]+$/.test(argument)) return argument;
      const quoted = argument.replaceAll("'", "'\"'\"'");
      return `'${quoted}'`;
    })
    .join(" ");
  line("Command (copy as one line):");
  console.log(`    ${command}`);
}

function renderInspection(inspection: Inspection, line: PolicyLine, full: boolean): void {
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
      for (const decision of decisions) renderBlockers(decision, line, full);
    } else line(decisions.map((item) => actionLabel(item.action)).join(", "), "    ");
  }
  line();
  const next = inspection.decision?.recommendedCommand;
  if (next?.length) {
    if (inspection.decision?.recommendedAction)
      line(`Suggested action: ${actionLabel(inspection.decision.recommendedAction)}`, "  ", "1");
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

function renderPolicyView(
  result: { path: string; source: string; policy: Policy },
  inspection: Inspection | undefined,
  full: boolean,
): void {
  const line = policyPrinter();
  line("OLYMPUS POLICY", "", "1;36");
  line(result.path, "  ", "90");
  if (result.source === "missing") line("No policy file. Local policy is inactive.");
  if (inspection) renderInspection(inspection, line, full);
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

const edit = defineCommand({
  meta: { name: "policy edit", description: "Edit policy in your editor" },
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
  },
  run: ({ args }) => {
    const direct = args.key !== undefined;
    if (direct !== (args.value !== undefined))
      throw new Error("Provide both a policy key and a YAML value, or neither to open the editor");
    if (direct && !args.value!.trim())
      throw new Error("Provide an explicit YAML value; use null to disable an optional rule");
    if (!direct && args.json) throw new Error("JSON mode requires a policy key and a YAML value");
    const editor =
      process.env.VISUAL?.trim()
      || process.env.EDITOR?.trim()
      || (process.stdin.isTTY ? "vi" : undefined);
    if (!direct && !editor)
      throw new Error("Set VISUAL or EDITOR, or use policy edit <key> <value>");
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
        const result = spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "policy-editor", draft], {
          stdio: "inherit",
        });
        if (result.error || result.status !== 0)
          throw new Error("Editor failed or was interrupted; policy unchanged");
        text = readFileSync(draft, "utf8");
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
      if (changed) renameSync(draft, path);
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

export default defineCommand({
  meta: { name: "policy", description: "Configure policy rules and optional action graph" },
  subCommands: { show, init, edit },
});
