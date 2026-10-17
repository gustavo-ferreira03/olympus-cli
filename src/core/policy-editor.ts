/* oxlint-disable eslint/max-lines */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { parseDocument, type Document } from "yaml";
import { parsePolicy } from "./policy.ts";
import { describeCondition } from "./policy-language.ts";
import { formatDynamicCheckLabel } from "./model.ts";
import { toPublicCheckKey } from "./expected.ts";

export type PolicyEditorResult =
  | { status: "save"; text: string }
  | { status: "discard" }
  | { status: "unchanged" };

type Row = {
  path: Array<string | number>;
  depth: number;
  label: string;
  value: unknown;
  container: boolean;
};

type Key = { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string };

const actionLabels: Record<string, string> = {
  "artifacts.update": "Update artifacts",
  "image.build": "Build image",
  "prechecks.run": "Prechecks",
  "scope_gate.run": "Scope Gate",
  "checks.run_all": "Run checks",
  "rollouts.run": "Rollouts",
  "re_evaluation.run": "Re-evaluation",
  "fp_check.run": "FP Check",
  "verifier_audit.decide": "Verifier Audit",
  "auto_review.orchestrate": "Auto Review",
  "submission.submit": "Submission",
};

function humanize(value: string): string {
  if (actionLabels[value]) return actionLabels[value];
  const raw = value.startsWith("checks.") ? value.slice("checks.".length) : value;
  const checkLabel = formatDynamicCheckLabel(toPublicCheckKey(raw));
  if (checkLabel !== raw) return checkLabel;
  return raw
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_.-]+/g, " ")
    .replaceAll(/\b\w/g, (character) => character.toUpperCase());
}

function scalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.map(scalar).join(", ")}]`;
  return "";
}

function styledScalar(value: unknown): string {
  const rendered = scalar(value);
  if (value === true) return `\x1b[1;32m${rendered}\x1b[0m`;
  if (value === false) return `\x1b[1;31m${rendered}\x1b[0m`;
  if (value === null || (Array.isArray(value) && value.length === 0))
    return `\x1b[90m${rendered}\x1b[0m`;
  return rendered;
}

function rowLabel(path: Array<string | number>): string {
  if (path.length === 0) return "Policy";
  const key = path.at(-1);
  return typeof key === "number" ? `Item ${key + 1}` : humanize(String(key));
}

function rowsFor(value: unknown): Row[] {
  const rows: Row[] = [];
  const visit = (candidate: unknown, path: Array<string | number>, depth: number): void => {
    if (Array.isArray(candidate)) {
      rows.push({
        path,
        depth,
        label: `${rowLabel(path)} (${candidate.length})`,
        value: candidate,
        container: true,
      });
      candidate.forEach((item, index) => visit(item, [...path, index], depth + 1));
      return;
    }
    if (candidate && typeof candidate === "object") {
      if (path.length > 0)
        rows.push({
          path,
          depth,
          label: rowLabel(path),
          value: candidate,
          container: true,
        });
      for (const [key, nested] of Object.entries(candidate as Record<string, unknown>))
        visit(nested, [...path, key], path.length === 0 ? 0 : depth + 1);
      return;
    }
    rows.push({
      path,
      depth,
      label: rowLabel(path),
      value: candidate,
      container: false,
    });
  };
  visit(value, [], 0);
  return rows;
}

function pathLabel(path: Array<string | number>): string {
  return path.map(String).join(".");
}

function safeKey(raw: string): string {
  const key = raw.trim();
  if (
    !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)
    || ["__proto__", "prototype", "constructor"].includes(key)
  )
    throw new Error("Use a safe policy key name");
  return key;
}

function valueAtPath(root: unknown, path: Array<string | number>): unknown {
  let value: any = root;
  for (const part of path) value = value?.[part];
  return value;
}

function cycleKnownValue(document: Document, row: Row, direction: number): boolean {
  const path = pathLabel(row.path);
  let values: unknown[] | undefined;
  if (path === "graph.mode") values = ["off", "advise", "enforce"];
  if (!values || values.length === 0) return false;
  const current = values.findIndex((value) => value === row.value);
  const next = (Math.max(0, current) + direction + values.length) % values.length;
  document.setIn(row.path, values[next]);
  return true;
}

function validate(text: string): string | undefined {
  try {
    parsePolicy(text);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export type PolicyFlowState = {
  currentActions: string[];
  activeActions?: string[];
  status: string;
  details?: Record<string, string>;
  statuses?: Record<string, "pass" | "fail" | "pending" | "running" | "stale">;
};

// oxlint-disable-next-line eslint/max-lines-per-function eslint/complexity
export function policyFlowLines(value: unknown, colors = true, state?: PolicyFlowState): string[] {
  const graph = (value as any)?.graph;
  if (!graph || typeof graph !== "object") return ["No active workflow."];
  const actions =
    graph.actions && typeof graph.actions === "object"
      ? (graph.actions as Record<string, any>)
      : {};
  if (Object.keys(actions).length === 0) return ["No workflow actions are configured."];
  const color = {
    reset: colors ? "\x1b[0m" : "",
    dim: colors ? "\x1b[90m" : "",
    cyan: colors ? "\x1b[1;36m" : "",
    yellow: colors ? "\x1b[1;33m" : "",
    purple: colors ? "\x1b[1;35m" : "",
    green: colors ? "\x1b[1;32m" : "",
    red: colors ? "\x1b[1;31m" : "",
  };
  const flowLabel = (action: string): string => {
    if (action !== "checks.run_all") return humanize(action);
    const checks = actions[action]?.arguments?.checks;
    if (!Array.isArray(checks) || checks.length === 0) return humanize(action);
    return `Run Checks: ${checks.map((check: unknown) => humanize(String(check))).join(" + ")}`;
  };
  const stageOrder = Object.keys(actions);
  const rank = (action: string) => {
    const index = stageOrder.indexOf(action);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const gates = graph.gates && typeof graph.gates === "object" ? graph.gates : {};
  const predicateDetail = (predicate: any, check?: string): string | undefined => {
    const rawPath = String(predicate?.path ?? "").replace(/^output\./, "");
    if (!rawPath || ["status", "stale", "verdict"].includes(rawPath)) return undefined;
    if (rawPath.startsWith("checkInputs.")) return undefined;
    return describeCondition(predicate, check);
  };
  const actionDetails = (action: string): string => {
    const check = action.startsWith("checks.") ? action.slice("checks.".length) : undefined;
    const gate = Object.values(gates).find((candidate: any) => candidate?.check === check) as
      | { all?: any[] }
      | undefined;
    const details = (gate?.all ?? [])
      .map((predicate: any) => predicateDetail(predicate, check))
      .filter((detail: string | undefined): detail is string => Boolean(detail));
    return details.length > 0 ? ` ${color.dim}[${details.join(" · ")}]${color.reset}` : "";
  };
  const requirementDescription = (action: string): string => {
    if (typeof actions[action]?.on_unmet !== "string") return "";
    const requirements = Array.isArray(actions[action]?.requires) ? actions[action].requires : [];
    if (requirements.length === 0) return "";
    return requirements
      .map((item: unknown) => {
        const id = String(item);
        for (const suffix of ["current", "ready", "clean"])
          if (id.endsWith(`_${suffix}`))
            return `${humanize(id.slice(0, -(suffix.length + 1)))} not ${suffix}`;
        return `${humanize(id)} unmet`;
      })
      .join(", ");
  };
  const children = (action: string): string[] => {
    const transitions = Array.isArray(actions[action]?.next) ? actions[action].next : [];
    const targets: string[] = transitions.flatMap((transition: any) =>
      typeof transition?.action === "string" && !!actions[transition.action]
        ? [transition.action]
        : [],
    );
    return [...new Set<string>(targets)].toSorted((left, right) => rank(left) - rank(right));
  };
  const reaches = (origin: string, target: string): boolean => {
    const seen = new Set<string>();
    const pending = [...children(origin)];
    while (pending.length > 0) {
      const action = pending.pop()!;
      if (action === target) return true;
      if (seen.has(action)) continue;
      seen.add(action);
      pending.push(...children(action));
    }
    return false;
  };
  const checkDistinguishesBranch = (source: string, check: string): boolean => {
    const prefix = `checks.${check}.`;
    let passed = false;
    let incomplete = false;
    for (const transition of actions[source]?.next ?? []) {
      const predicates = Array.isArray(transition?.all) ? transition.all : [];
      const related = predicates.filter((predicate: any) =>
        String(predicate?.path ?? "").startsWith(prefix),
      );
      const transitionPassed =
        related.some(
          (predicate: any) =>
            predicate.path === `${prefix}status` && predicate.equals === "completed",
        )
        && related.some(
          (predicate: any) => predicate.path === `${prefix}stale` && predicate.equals === false,
        )
        && related.some(
          (predicate: any) =>
            predicate.path === `${prefix}output.verdict` && predicate.equals === "PASS",
        );
      passed ||= transitionPassed;
      incomplete ||= related.some(
        (predicate: any) =>
          (predicate.path === `${prefix}status` && predicate.exists === false)
          || (predicate.path === `${prefix}stale` && predicate.equals === true)
          || (predicate.path === `${prefix}output.verdict` && predicate.equals !== "PASS"),
      );
    }
    return passed && incomplete;
  };
  const transitionKeys = (source: string, target: string): string[] =>
    (actions[source]?.next ?? [])
      .filter((transition: any) => transition?.action === target)
      .map((transition: any) =>
        JSON.stringify(
          (transition.all ?? [])
            .map((predicate: any) =>
              Object.fromEntries(
                Object.entries(predicate).toSorted(([left], [right]) => left.localeCompare(right)),
              ),
            )
            .toSorted((left: any, right: any) =>
              JSON.stringify(left).localeCompare(JSON.stringify(right)),
            ),
        ),
      )
      .toSorted();
  const shareParallelParent = (left: string, right: string): boolean =>
    Object.keys(actions).some((source) => {
      const leftKeys = transitionKeys(source, left);
      const rightKeys = transitionKeys(source, right);
      return leftKeys.length > 0 && JSON.stringify(leftKeys) === JSON.stringify(rightKeys);
    });
  // oxlint-disable-next-line eslint/max-lines-per-function
  const edgeCondition = (from: string, to: string): string => {
    let sourceChecks: string[] = [];
    if (from === "checks.run_all" && Array.isArray(actions[from]?.arguments?.checks))
      sourceChecks = actions[from].arguments.checks.map(String);
    else if (from.startsWith("checks.")) sourceChecks = [from.slice("checks.".length)];
    const sourceState = from
      .split(".")[0]
      .replaceAll(/_([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const sourcePrefixes = [
      ...sourceChecks.map((check: string) => `checks.${check}.`),
      ...(from.startsWith("checks.") ? [] : [`${sourceState}.`]),
    ];
    const predicatePathLabel = (path: string): string => {
      const matchingGate = Object.entries(gates).find(([, gate]: [string, any]) =>
        (gate?.all ?? []).some((predicate: any) => predicate?.path === path),
      );
      if (matchingGate) return humanize(matchingGate[0].replace(/_(current|ready|clean)$/, ""));
      return path
        .split(".")
        .map((part) => humanize(part))
        .join(" ");
    };
    const transitions = (Array.isArray(actions[from]?.next) ? actions[from].next : []).filter(
      (transition: any) => transition?.action === to,
    );
    // oxlint-disable-next-line eslint/complexity eslint/max-lines-per-function
    const alternatives: string[] = transitions.map((transition: any) => {
      const predicates = (Array.isArray(transition.all) ? transition.all : []).filter(
        (predicate: any) =>
          !sourcePrefixes.some((prefix: string) => {
            const path = String(predicate?.path ?? "");
            return path.startsWith(prefix) || path === prefix.slice(0, -1);
          }),
      );
      const details: string[] = [];
      const ignoredPaths = new Set<string>();
      const missingChecks = predicates.filter(
        (predicate: any) =>
          /^checks\.[^.]+\.status$/.test(String(predicate?.path ?? ""))
          && predicate?.exists === false,
      );
      if (missingChecks.length > 1) {
        details.push("no checks yet");
        missingChecks.forEach((predicate: any) => ignoredPaths.add(String(predicate.path)));
      }
      for (const predicate of predicates) {
        const match = /^readiness\.criteria\.(\d+)\.id$/.exec(String(predicate?.path ?? ""));
        if (!match || typeof predicate?.equals !== "string") continue;
        const prefix = `readiness.criteria.${match[1]}.`;
        const status = predicates.find((item: any) => item?.path === `${prefix}status`)?.equals;
        const stale = predicates.find((item: any) => item?.path === `${prefix}stale`)?.equals;
        const criterionAction = `${String(predicate.equals).replaceAll("_", "-")}.run`;
        const alreadyRepresented = criterionAction === from || reaches(criterionAction, from);
        if (!alreadyRepresented && status === "pass" && stale === false)
          details.push(`${humanize(predicate.equals)} ready`);
        else if (!alreadyRepresented && status)
          details.push(`${humanize(predicate.equals)} ${humanize(String(status))}`);
        ignoredPaths.add(`${prefix}id`);
        ignoredPaths.add(`${prefix}status`);
        ignoredPaths.add(`${prefix}stale`);
      }
      const groupedChecks = new Set(
        predicates
          .map((predicate: any) => String(predicate?.path ?? "").match(/^checks\.([^.]+)/)?.[1])
          .filter(Boolean),
      );
      for (const check of groupedChecks) {
        const prefix = `checks.${check}.`;
        const checkPredicates = predicates.filter((predicate: any) =>
          String(predicate?.path ?? "").startsWith(prefix),
        );
        const completed = predicates.some(
          (predicate: any) =>
            predicate.path === `${prefix}status` && predicate.equals === "completed",
        );
        const current = predicates.some(
          (predicate: any) => predicate.path === `${prefix}stale` && predicate.equals === false,
        );
        const passed = predicates.some(
          (predicate: any) =>
            predicate.path === `${prefix}output.verdict` && predicate.equals === "PASS",
        );
        const incomplete = checkPredicates.some(
          (predicate: any) =>
            (predicate.path === `${prefix}status` && predicate.exists === false)
            || (predicate.path === `${prefix}stale` && predicate.equals === true)
            || (predicate.path === `${prefix}output.verdict` && predicate.equals !== "PASS"),
        );
        const hasRecoveryCondition = checkPredicates.some((predicate: any) => {
          const path = String(predicate?.path ?? "");
          return (
            (path.endsWith("changedSinceCheck") && predicate.equals === true)
            || (path.endsWith("stale") && predicate.equals === true)
            || (path.endsWith("output.verdict") && predicate.equals !== "PASS")
            || (Object.hasOwn(predicate, "empty") && predicate.empty === false)
            || (Object.hasOwn(predicate, "exists") && predicate.exists === false)
          );
        });
        const checkAction = `checks.${String(check)}`;
        if (
          completed
          && current
          && passed
          && !hasRecoveryCondition
          && checkAction !== from
          && !shareParallelParent(checkAction, from)
          && (!reaches(checkAction, from) || checkDistinguishesBranch(from, String(check)))
        )
          details.push(`${humanize(String(check))} passed`);
        else if (incomplete && checkDistinguishesBranch(from, String(check)))
          details.push(`${humanize(String(check))} pending`);
      }
      for (const predicate of predicates) {
        const path = String(predicate?.path ?? "");
        if (ignoredPaths.has(path)) continue;
        const grouped = [...groupedChecks].some(
          (check) =>
            (path === `checks.${check}.status` && predicate.equals === "completed")
            || (path === `checks.${check}.stale` && predicate.equals === false)
            || (path === `checks.${check}.output.verdict` && predicate.equals === "PASS"),
        );
        if (grouped) continue;
        const checkMatch = /^checks\.([^.]+)\.(.+)$/.exec(path);
        const checkAction = checkMatch ? `checks.${checkMatch[1]}` : "";
        const checkSubject = checkMatch && checkAction !== to ? `${humanize(checkMatch[1])} ` : "";
        if (checkMatch?.[2] === "status" || checkMatch?.[2] === "stale") continue;
        if (
          (path.endsWith("changedSinceCheck") && predicate.equals === false)
          || (path.endsWith("stale") && predicate.equals === false)
          || (path.endsWith("neverRun") && predicate.equals === false)
          || (path.endsWith("lastRunFailed") && predicate.equals === false)
          || (path === "scopeGate.latestVerdict" && predicate.equals === "pass")
          || (checkMatch && Object.hasOwn(predicate, "empty") && predicate.empty === true)
        )
          continue;
        if (path.endsWith("neverRun") && predicate.equals === true)
          details.push(`${humanize(path.split(".").at(-2) ?? "action")} not run`);
        else if (path.endsWith("lastRunFailed") && predicate.equals === true)
          details.push(`${humanize(path.split(".").at(-2) ?? "action")} failed`);
        else if (path.endsWith("changedSinceCheck") && predicate.equals === true)
          details.push(`${humanize(path.split(".").at(-2) ?? "artifact")} changed`);
        else if (path.endsWith("changedSinceCheck") && predicate.exists === false)
          details.push(`${humanize(path.split(".").at(-2) ?? "artifact")} input unknown`);
        else if (path.endsWith("stale") && predicate.equals === true)
          details.push(`${checkSubject || `${predicatePathLabel(path)} `}stale`);
        else if (path.endsWith("fresh") && Object.hasOwn(predicate, "equals"))
          details.push(
            `${predicatePathLabel(path).replace(/ Fresh$/, "")} ${predicate.equals ? "current" : "not current"}`,
          );
        else if (path.endsWith("freshPass") && predicate.equals === true)
          details.push(`${predicatePathLabel(path).replace(/ Fresh Pass$/, "")} passed`);
        else if (path === "scopeGate" && predicate.equals === null)
          details.push("Scope Gate absent");
        else if (path === "scopeGate.latestVerdict" && predicate.equals === "drop")
          details.push("Scope Gate drop");
        else if (path === "scopeGate.latestVerdict" && predicate.equals === "fail")
          details.push("Scope Gate failed");
        else if (checkMatch?.[2] === "status" && predicate.exists === false)
          details.push(`${checkSubject}not run`);
        else if (checkMatch?.[2] === "output.verdict" && predicate.equals === "FAIL")
          details.push(`${checkSubject}failed`);
        else if (checkMatch?.[2] === "output.evaluation.comments" && predicate.empty === false)
          details.push(`${checkSubject}has comments`);
        else details.push(describeCondition(predicate));
      }
      return [...new Set(details)].join(" and ");
    });
    if (alternatives.includes("")) return "";
    const unique: string[] = [
      ...new Set<string>(
        alternatives.filter((item): item is string => typeof item === "string" && item.length > 0),
      ),
    ];
    if (unique.length < 2) return unique[0] ?? "";
    const clauses = unique.map((item) => item.split(" and "));
    const common = clauses[0].filter((item) => clauses.every((clause) => clause.includes(item)));
    if (common.length === 0) return unique.join(" or ");
    const remainder = clauses.map((clause) =>
      clause.filter((item) => !common.includes(item)).join(" and "),
    );
    if (remainder.includes("")) return common.join(" and ");
    return `${common.join(" and ")} and (${remainder.join(" or ")})`;
  };

  const currentActions = new Set(state?.currentActions ?? []);
  const activeActions = new Set(state?.activeActions ?? []);
  const stateMarker = (action: string): string => {
    if (activeActions.has(action)) return ` ${color.yellow}← RUNNING${color.reset}`;
    if (!currentActions.has(action)) return "";
    return ` ${color.cyan}← NEXT${color.reset}`;
  };
  const statusMark = (
    status: NonNullable<PolicyFlowState["statuses"]>[string] | undefined,
  ): string => {
    if (status === "pass") return `${color.green}✓${color.reset} `;
    if (status === "fail") return `${color.red}x${color.reset} `;
    if (status === "running") return `${color.yellow}●${color.reset} `;
    if (status === "stale") return `${color.yellow}↻${color.reset} `;
    if (status === "pending") return `${color.dim}○${color.reset} `;
    return "";
  };
  const styledAction = (action: string, includeStatus = true): string => {
    const challengeDetail = state?.details?.[action];
    const mark = includeStatus ? statusMark(state?.statuses?.[action]) : "";
    const details = challengeDetail
      ? ` ${color.dim}[${challengeDetail}]${color.reset}`
      : actionDetails(action);
    const label = `${mark}${flowLabel(action)}${details}`;
    return `${label}${stateMarker(action)}`;
  };
  const edge = (connector: string): string => `${color.dim}${connector}${color.reset}`;
  const compactCondition = (condition: string): string =>
    condition
      .replaceAll("requirements unmet: ", "needs ")
      .replaceAll(" Summary ", " ")
      .replaceAll(": ", " ")
      .replaceAll(" and ", " · ")
      .replaceAll(" or ", " / ");

  const lines: string[] = [];
  const incoming = new Map<string, number>(Object.keys(actions).map((action) => [action, 0]));
  for (const action of Object.keys(actions))
    for (const target of children(action)) incoming.set(target, (incoming.get(target) ?? 0) + 1);
  let focusActions: string[] = [];
  if (currentActions.size > 1) focusActions = [...currentActions];
  else if (activeActions.size > 1) focusActions = [...activeActions];
  const focusParents = new Set(
    Object.keys(actions).filter((source) => {
      if (
        focusActions.length < 2
        || !focusActions.every((action) => children(source).includes(action))
      )
        return false;
      const [first, ...rest] = focusActions;
      const firstKeys = transitionKeys(source, first);
      return (
        firstKeys.length > 0
        && rest.every(
          (action) => JSON.stringify(transitionKeys(source, action)) === JSON.stringify(firstKeys),
        )
      );
    }),
  );
  const actionPriority = (action: string): number => {
    if (focusParents.has(action)) return -1;
    if (currentActions.has(action)) return 0;
    if (activeActions.has(action)) return 1;
    return 2;
  };
  const reachCount = (origin: string): number => {
    const seen = new Set<string>();
    const pending = [origin];
    while (pending.length > 0) {
      const action = pending.pop()!;
      if (seen.has(action)) continue;
      seen.add(action);
      pending.push(...children(action));
    }
    return seen.size;
  };
  const ordered = Object.keys(actions).toSorted(
    (left, right) =>
      actionPriority(left) - actionPriority(right)
      || reachCount(right) - reachCount(left)
      || (incoming.get(right) ?? 0) - (incoming.get(left) ?? 0)
      || rank(left) - rank(right),
  );
  const expanded = new Set<string>();
  const branchesFor = (action: string): Array<{ condition: string; targets: string[] }> => {
    const transitions = Array.isArray(actions[action]?.next)
      ? actions[action].next.filter(
          (transition: any) => typeof transition?.action === "string" && actions[transition.action],
        )
      : [];
    const groups = new Map<string, string[]>();
    for (const transition of transitions) {
      const condition = edgeCondition(action, String(transition.action));
      const targets = groups.get(condition) ?? [];
      if (!targets.includes(transition.action)) targets.push(transition.action);
      groups.set(condition, targets);
    }
    if (typeof actions[action]?.on_unmet === "string")
      groups.set(requirementDescription(action) || "requirements unmet", [
        actions[action].on_unmet,
      ]);
    return [...groups.entries()].map(([condition, targets]) => ({ condition, targets }));
  };
  type FlowBranch = { condition: string; targets: string[] };
  const branchId = (branch: FlowBranch): string =>
    `${branch.condition}\u0000${branch.targets.toSorted().join("\u0000")}`;
  const transitionRequiresPassedAction = (transition: any, action: string): boolean => {
    if (!action.startsWith("checks.")) return false;
    const prefix = `${action}.`;
    const predicates = Array.isArray(transition?.all) ? transition.all : [];
    return (
      predicates.some(
        (predicate: any) =>
          predicate.path === `${prefix}status` && predicate.equals === "completed",
      )
      && predicates.some(
        (predicate: any) => predicate.path === `${prefix}stale` && predicate.equals === false,
      )
      && predicates.some(
        (predicate: any) =>
          predicate.path === `${prefix}output.verdict` && predicate.equals === "PASS",
      )
    );
  };
  const sharedContinuation = (
    siblings: string[],
  ): { owner: string; branch: FlowBranch } | undefined => {
    for (const owner of siblings) {
      const prerequisites = siblings.filter((sibling) => sibling !== owner);
      if (prerequisites.length === 0) continue;
      for (const branch of branchesFor(owner)) {
        if (branch.targets.some((target) => siblings.includes(target))) continue;
        const shared = branch.targets.every((target) => {
          const transitions = (actions[owner]?.next ?? []).filter(
            (transition: any) => transition?.action === target,
          );
          return (
            transitions.length > 0
            && transitions.every((transition: any) =>
              prerequisites.every((prerequisite) =>
                transitionRequiresPassedAction(transition, prerequisite),
              ),
            )
          );
        });
        if (shared) return { owner, branch };
      }
    }
    return undefined;
  };
  const draw = (
    action: string,
    prefix: string,
    connector: string,
    edgeLabel = "",
    omittedBranch?: FlowBranch,
  ): void => {
    const mark = statusMark(activeActions.has(action) ? "running" : state?.statuses?.[action]);
    const compactLabel = compactCondition(edgeLabel).replaceAll(`${flowLabel(action)} `, "");
    const condition = edgeLabel ? `${color.purple}[${compactLabel}]${color.reset} ` : "";
    if (expanded.has(action)) {
      lines.push(`${prefix}${edge(connector)}${mark}${condition}→ ${flowLabel(action)}`);
      return;
    }
    lines.push(`${prefix}${edge(connector)}${mark}${condition}${styledAction(action, false)}`);
    expanded.add(action);
    const omittedId = omittedBranch ? branchId(omittedBranch) : undefined;
    const branches = branchesFor(action).filter((branch) => branchId(branch) !== omittedId);
    branches.forEach((branch, branchIndex) => {
      const lastBranch = branchIndex === branches.length - 1;
      let continuation = "";
      if (connector === "└── ") continuation = "    ";
      else if (connector) continuation = `${edge("│")}   `;
      if (branch.targets.length === 1)
        draw(
          branch.targets[0],
          `${prefix}${continuation}`,
          lastBranch ? "└── " : "├── ",
          branch.condition,
        );
      else {
        const branchConnector = lastBranch ? "└── " : "├── ";
        const branchCondition = branch.condition
          ? `${color.purple}[${compactCondition(branch.condition)}]${color.reset} `
          : "";
        lines.push(
          `${prefix}${continuation}${edge(branchConnector)}${branchCondition}${color.cyan}parallel${color.reset}`,
        );
        const shared = sharedContinuation(branch.targets);
        const targetPrefix = `${prefix}${continuation}${lastBranch ? "    " : `${edge("│")}   `}`;
        branch.targets.forEach((target, targetIndex) => {
          const targetConnector = targetIndex === branch.targets.length - 1 ? "└── " : "├── ";
          draw(
            target,
            targetPrefix,
            targetConnector,
            "",
            shared?.owner === target ? shared.branch : undefined,
          );
        });
        if (shared) {
          const sharedPrefix = `${targetPrefix}    `;
          const sharedCondition = shared.branch.condition
            ? `${color.purple}[${compactCondition(shared.branch.condition)}]${color.reset} `
            : "";
          if (shared.branch.targets.length === 1)
            draw(shared.branch.targets[0], sharedPrefix, "└── ", shared.branch.condition);
          else {
            lines.push(
              `${sharedPrefix}${edge("└── ")}${sharedCondition}${color.cyan}parallel${color.reset}`,
            );
            shared.branch.targets.forEach((target, targetIndex) =>
              draw(
                target,
                `${sharedPrefix}    `,
                targetIndex === shared.branch.targets.length - 1 ? "└── " : "├── ",
              ),
            );
          }
        }
      }
    });
  };
  for (const action of ordered) {
    if (expanded.has(action)) continue;
    if (lines.length > 0) lines.push("");
    draw(action, "", "");
  }

  if (state && currentActions.size === 0 && activeActions.size === 0)
    lines.unshift(`${color.green}Current state: ${state.status.toUpperCase()}${color.reset}`, "");

  return lines;
}

function diffLines(original: string, current: string): string[] {
  if (original === current) return ["No changes."];
  const before = original.split("\n");
  const after = current.split("\n");
  const lines: string[] = [];
  const size = Math.max(before.length, after.length);
  for (let index = 0; index < size; index += 1) {
    if (before[index] === after[index]) continue;
    if (before[index] !== undefined) lines.push(`- ${before[index]}`);
    if (after[index] !== undefined) lines.push(`+ ${after[index]}`);
  }
  return lines;
}

function parseValue(raw: string): unknown {
  const value = parseDocument(raw, { uniqueKeys: true, merge: false });
  if (value.errors.length > 0 || value.warnings.length > 0 || value.contents === null)
    throw new Error("Enter a valid, non-empty YAML value");
  return value.toJS({ maxAliasCount: 0 });
}

function replaceDocument(text: string): Document {
  const document = parseDocument(text, { uniqueKeys: true, merge: false });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new Error("The editor returned invalid YAML");
  document.toJS({ maxAliasCount: 0 });
  return document;
}

function openRawEditor(text: string, editor: string, directory: string): string {
  const draft = resolve(directory, `.policy-tui-${randomUUID()}.yml`);
  writeFileSync(draft, text, { flag: "wx", mode: 0o600 });
  try {
    const result = spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "policy-editor", draft], {
      stdio: "inherit",
    });
    if (result.error || result.status !== 0) throw new Error("Editor failed or was interrupted");
    const updated = readFileSync(draft, "utf8");
    const error = validate(updated);
    if (error) throw new Error(error);
    return updated;
  } finally {
    if (existsSync(draft)) unlinkSync(draft);
  }
}

// oxlint-disable-next-line eslint/max-lines-per-function
export async function runStructuredPolicyEditor(
  initialText: string,
  options: { editor: string; path: string },
): Promise<PolicyEditorResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Structured policy editing requires an interactive terminal; use --raw or key/value mode",
    );
  let document = replaceDocument(initialText);
  const baselineText = document.toString();
  let selected = 0;
  let offset = 0;
  let previewOffset = 0;

  let view: "tree" | "flow" | "diff" | "help" = "tree";
  let message = "";
  let modal: { question: string; value: string; resolve: (value: string) => void } | undefined;
  let busy = false;
  let stopped = false;
  let result: PolicyEditorResult = { status: "unchanged" };
  let finish!: () => void;
  const done = new Promise<void>((_resolve) => {
    finish = _resolve;
  });
  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing === true;

  const currentText = () => document.toString();
  const currentValue = () => document.toJS({ maxAliasCount: 0 });
  const leaveScreen = () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.stdin.setRawMode(false);
  };
  const enterScreen = () => {
    process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1049h\x1b[?25l");
  };
  const prompt = (question: string, initial = ""): Promise<string> =>
    new Promise<string>((_resolve) => {
      modal = {
        question: question.replaceAll("\n", " ").trim(),
        value: initial,
        resolve: _resolve,
      };
      paint();
    });
  const stop = (outcome: PolicyEditorResult) => {
    if (stopped) return;
    stopped = true;
    result = outcome;
    finish();
  };
  // oxlint-disable-next-line eslint/complexity
  const paint = () => {
    if (stopped) return;
    const width = Math.max(60, process.stdout.columns || 80);
    const height = Math.max(18, process.stdout.rows || 24);
    const bodyHeight = height - 8;
    const title = "OLYMPUS POLICY EDITOR";
    const changed = currentText() !== baselineText;
    const validation = validate(currentText());
    const header = [
      `\x1b[1;36m${title}\x1b[0m  ${changed ? "\x1b[33munsaved\x1b[0m" : "saved"}`,
      `File: ${options.path}`,
      `Validation: ${validation ? `\x1b[31m${validation}\x1b[0m` : "\x1b[32mPASS\x1b[0m"}`,
      "",
    ];
    let body: string[];
    if (view === "tree") {
      const rows = rowsFor(currentValue());
      selected = Math.max(0, Math.min(selected, rows.length - 1));
      if (selected < offset) offset = selected;
      if (selected >= offset + bodyHeight) offset = selected - bodyHeight + 1;
      body = rows.slice(offset, offset + bodyHeight).map((row, index) => {
        const active = offset + index === selected;
        const pointer = active ? "›" : " ";
        const indentation = "  ".repeat(row.depth);
        const marker = row.container ? "▸ " : "";
        const rawValue = row.container ? "" : `  ${scalar(row.value)}`;
        const rawLine = `${pointer} ${indentation}${marker}${row.label}${rawValue}`;
        if (active) return `\x1b[7m${rawLine.slice(0, width)}\x1b[0m`;
        if (rawLine.length > width) return rawLine.slice(0, width);
        const label = row.container ? `\x1b[1;36m${row.label}\x1b[0m` : row.label;
        const value = row.container ? "" : `  ${styledScalar(row.value)}`;
        return `${pointer} ${indentation}${marker}${label}${value}`;
      });
    } else if (view === "flow") {
      const preview = ["\x1b[1mFLOW PREVIEW\x1b[0m", "", ...policyFlowLines(currentValue())];
      previewOffset = Math.max(0, Math.min(previewOffset, preview.length - bodyHeight));
      body = preview.slice(previewOffset, previewOffset + bodyHeight);
    } else if (view === "diff") {
      const preview = ["\x1b[1mCHANGES\x1b[0m", "", ...diffLines(baselineText, currentText())];
      previewOffset = Math.max(0, Math.min(previewOffset, preview.length - bodyHeight));
      body = preview.slice(previewOffset, previewOffset + bodyHeight);
    } else {
      body = [
        "\x1b[1mHELP\x1b[0m",
        "",
        "↑/↓ or j/k   Select a field",
        "←/→           Cycle known choices such as mode",
        "Enter         Edit the selected value as YAML",
        "Space         Toggle a boolean",
        "a             Add a key or array item to the selected container",
        "d             Delete the selected field",
        "f             Flow preview",
        "p             Diff preview",
        "r             Open the complete YAML in the configured editor",
        "s             Validate, review and save",
        "q/Esc         Discard or return to the tree",
        "?             This help",
      ];
    }
    while (body.length < bodyHeight) body.push("");
    let controls =
      "↑↓ navigate  Enter edit  a add  d delete  f flow  p diff  r raw  s save  q quit  ? help";
    if (view === "flow") controls = "↑↓ PgUp/PgDn scroll  f flow  q back";
    else if (view === "diff") controls = "↑↓ PgUp/PgDn scroll  f flow  p diff  q back";
    const footer = modal
      ? [
          "",
          `\x1b[1;36m${modal.question.slice(0, width)}\x1b[0m`,
          `> ${modal.value.slice(Math.max(0, modal.value.length - width + 3))}\x1b[7m \x1b[0m`,
        ]
      : ["", message ? `\x1b[33m${message.slice(0, width)}\x1b[0m` : "", controls];
    process.stdout.write(`\x1b[H\x1b[2J${[...header, ...body, ...footer].join("\n")}`);
  };

  /* oxlint-disable eslint/complexity eslint/max-depth eslint/max-lines-per-function */
  const keypress = async (input: string, key: Key) => {
    if (modal) {
      const activeModal = modal;
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        modal = undefined;
        activeModal.resolve("");
      } else if (key.name === "return") {
        modal = undefined;
        activeModal.resolve(activeModal.value);
      } else if (key.name === "backspace") {
        activeModal.value = activeModal.value.slice(0, -1);
      } else if (key.ctrl && key.name === "u") {
        activeModal.value = "";
      } else if (key.ctrl && key.name === "w") {
        activeModal.value = activeModal.value.replace(/\s*\S+\s*$/, "");
      } else if (!key.ctrl && input && [...input].every((character) => character >= " ")) {
        activeModal.value += input;
      }
      paint();
      return;
    }
    if (busy || stopped) return;
    busy = true;
    try {
      if ((key.ctrl && key.name === "c") || key.name === "q" || key.name === "escape") {
        if (view !== "tree") {
          view = "tree";
          message = "";
        } else if (currentText() === baselineText) stop({ status: "unchanged" });
        else {
          const answer = (await prompt("Discard unsaved changes? [y/N] ")).trim().toLowerCase();
          if (answer === "y" || answer === "yes") stop({ status: "discard" });
        }
        return;
      }
      if (key.name === "f") {
        view = view === "flow" ? "tree" : "flow";
        previewOffset = 0;
      } else if (key.name === "p") {
        view = view === "diff" ? "tree" : "diff";
        previewOffset = 0;
      } else if (
        ["flow", "diff"].includes(view)
        && ["up", "down", "pageup", "pagedown"].includes(key.name ?? "")
      ) {
        let delta = 10;
        if (key.name === "up") delta = -1;
        else if (key.name === "down") delta = 1;
        else if (key.name === "pageup") delta = -10;
        previewOffset = Math.max(0, previewOffset + delta);
      } else if (key.name === "?" || key.sequence === "?") view = "help";
      else if (key.name === "r") {
        leaveScreen();
        try {
          document = replaceDocument(
            openRawEditor(currentText(), options.editor, dirname(options.path)),
          );
          message = "Raw editor changes loaded and validated.";
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        } finally {
          enterScreen();
        }
      } else if (key.name === "s") {
        const error = validate(currentText());
        if (error) message = `Cannot save: ${error}`;
        else if (currentText() === baselineText) stop({ status: "unchanged" });
        else {
          view = "diff";
          paint();
          const answer = (await prompt("Save these changes? [y/N] ")).trim().toLowerCase();
          if (answer === "y" || answer === "yes") stop({ status: "save", text: currentText() });
          else view = "tree";
        }
      } else if (view === "tree") {
        const rows = rowsFor(currentValue());
        if (["down", "j"].includes(key.name ?? ""))
          selected = Math.min(rows.length - 1, selected + 1);
        else if (["up", "k"].includes(key.name ?? "")) selected = Math.max(0, selected - 1);
        else if (key.name === "pagedown") selected = Math.min(rows.length - 1, selected + 10);
        else if (key.name === "pageup") selected = Math.max(0, selected - 10);
        else if (["left", "right"].includes(key.name ?? "")) {
          const row = rows[selected];
          if (row && cycleKnownValue(document, row, key.name === "left" ? -1 : 1))
            message = `${pathLabel(row.path)} updated.`;
        } else if (key.name === "space") {
          const row = rows[selected];
          if (typeof row?.value === "boolean") {
            document.setIn(row.path, !row.value);
            message = `${pathLabel(row.path)} updated.`;
          }
        } else if (key.name === "return") {
          const row = rows[selected];
          if (row && !row.container) {
            const answer = await prompt(
              `${pathLabel(row.path)} (${scalar(row.value)})\nNew YAML value: `,
              scalar(row.value),
            );
            if (answer.trim()) {
              try {
                document.setIn(row.path, parseValue(answer));
                message = `${pathLabel(row.path)} updated.`;
              } catch (error) {
                message = error instanceof Error ? error.message : String(error);
              }
            }
          }
        } else if (key.name === "a") {
          const row = rows[selected];
          if (row) {
            const containerPath = row.container ? row.path : row.path.slice(0, -1);
            const container = row.container
              ? row.value
              : valueAtPath(currentValue(), containerPath);
            try {
              if (Array.isArray(container)) {
                const answer = await prompt(`Add item to ${pathLabel(containerPath)} (YAML)`);
                if (answer.trim()) {
                  document.setIn([...containerPath, container.length], parseValue(answer));
                  message = `Item added to ${pathLabel(containerPath)}.`;
                }
              } else if (container && typeof container === "object") {
                const rawKey = await prompt(`New key in ${pathLabel(containerPath) || "policy"}`);
                if (rawKey.trim()) {
                  const childKey = safeKey(rawKey);
                  const answer = await prompt(`${childKey} value (YAML)`);
                  if (answer.trim()) {
                    document.setIn([...containerPath, childKey], parseValue(answer));
                    message = `${[...containerPath, childKey].map(String).join(".")} added.`;
                  }
                }
              }
            } catch (error) {
              message = error instanceof Error ? error.message : String(error);
            }
          }
        } else if (key.name === "d" || key.name === "delete") {
          const row = rows[selected];
          if (row?.path.length) {
            const answer = (await prompt(`Delete ${pathLabel(row.path)}? [y/N] `))
              .trim()
              .toLowerCase();
            if (answer === "y" || answer === "yes") {
              document.deleteIn(row.path);
              selected = Math.max(0, selected - 1);
              message = `${pathLabel(row.path)} deleted.`;
            }
          }
        }
      }
    } finally {
      busy = false;
      paint();
    }
  };
  /* oxlint-enable eslint/complexity eslint/max-depth eslint/max-lines-per-function */

  try {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", keypress);
    process.stdout.on("resize", paint);
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    paint();
    await done;
  } finally {
    stopped = true;
    process.stdin.off("keypress", keypress);
    process.stdout.off("resize", paint);
    if (!wasRaw && process.stdin.isTTY) process.stdin.setRawMode(false);
    if (!wasFlowing) process.stdin.pause();
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }
  return result;
}
