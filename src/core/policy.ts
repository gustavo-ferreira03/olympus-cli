import { createHash } from "node:crypto";
import { anyApi } from "convex/server";
import { readFileSync } from "node:fs";
import { assertFileWithinLimit, MAX_LOCAL_STATE_BYTES } from "../shared/limits.ts";
import { PolicyError } from "../shared/error-types.ts";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { credentialsDir } from "../platform/auth.ts";
import {
  BudgetError,
  budgetScope,
  readBudget,
  reserveBudget,
  settleBudget,
  sumBudgetAmounts,
  type BudgetContext,
  type BudgetFeedback,
  type BudgetPart,
} from "./budget.ts";
import { reportBudget } from "../terminal/output.ts";
import { parseAgentTypeInput } from "./model.ts";
import { resolveCostCatalog, resolveRunPrices, resolveVersionOffer } from "./pricing.ts";
import { TRIGGERABLE_CHECK_KEYS, toPublicCheckKey, toBackendCheckKey } from "./expected.ts";
import {
  POLICY_ACTIONS,
  type Predicate,
  type PolicyAction,
  type PolicyGraph,
  type PolicyDecision,
  type PolicyState,
  evaluatePolicyGraph,
  policyActionForEndpoint,
  policyGovernsAction,
  policyInvocation,
  policyFingerprint,
  policyRecommendedAction,
  policyDecisionFeedback,
  readStablePolicyState,
  localPolicySecret,
} from "./policy-graph.ts";

// Re-exported so callers keep importing the error from the module that raises it.
export { PolicyError, POLICY_ACTIONS, policyDecisionFeedback };
export { setPolicyInvocation } from "./policy-graph.ts";
export type { PolicyDecision, PolicyState, PolicyAction };

export type Policy = {
  runs: {
    max_runs: Partial<Record<"nova" | "vega" | "orion" | "castor", number | null>>;
    allow_full_preset: boolean | null;
    allow_manual_batch_name: boolean | null;
    allow_cancellations: boolean | null;
    allow_contests: boolean | null;
    re_evaluation: { enabled: boolean | null; max_attempts: number | null };
  };
  tokens: {
    allow_general_tokens: boolean | null;
    min_remaining_balance: number | null;
    challenge_budget: number | null;
  };
  checks: {
    allowed: string[] | null;
    allow_rerun_passing: boolean | null;
    require_explicit_selection: boolean | null;
    max_checks_per_request: number | null;
    max_active: number | null;
    allow_contests: boolean | null;
  };
  auto_review: { allow_force_refresh: boolean | null };
  graph: PolicyGraph;
};

export const defaultPolicyYaml = `# yaml-language-server: $schema=./policy.schema.json
runs:
  max_runs: {nova: 10, vega: 0, orion: 0, castor: 0} # Maximum current original runs per model
  allow_full_preset: false # Allow the full rollout preset
  allow_manual_batch_name: false # Allow explicit batch names
  allow_cancellations: false # Allow run cancellations
  allow_contests: false # Allow run contests
  re_evaluation:
    enabled: true # Allow re-evaluating existing solutions
    max_attempts: 1 # Maximum attempts per solution set across challenge versions

tokens:
  allow_general_tokens: false # Allow explicit use of general tokens
  min_remaining_balance: null # Minimum reported balance after request cost
  challenge_budget: null # Local per-challenge quoted-token budget; null disables

checks:
  allowed: [verifyTests, verifySolution, verifyFlakiness, testQuality, taskQuality, solutionQuality, descriptionQuality, autoReview, verifierIncompleteness] # Allowed dynamic checks
  require_explicit_selection: true # Require explicit check selection
  max_checks_per_request: 3 # Maximum distinct checks submitted together
  max_active: 3 # Maximum active dynamic checks per challenge
  allow_rerun_passing: false # Prevent rerunning completed, current PASS checks
  allow_contests: false # Allow check contests

auto_review:
  allow_force_refresh: false # Allow forced reruns of all review dimensions

# Policy sequencing is opt-in. Set graph to a configured mapping to enable it.
graph: null
`;

export function policyPath(): string {
  return resolve(credentialsDir(), "policy.yml");
}

function object(value: unknown, keys: string[], name: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PolicyError("policy.invalid", `${name} must be a mapping`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new PolicyError("policy.invalid", `Unknown key: ${name}.${key}`);
  }
  return value as Record<string, any>;
}

function parsePolicyGraph(raw: unknown): PolicyGraph {
  if (raw === undefined || raw === null) return null;
  const source = object(
    raw,
    [
      "mode",
      "start",
      "confirmation",
      "gates",
      "result_profiles",
      "actions",
      "notes",
      "repair_first",
    ],
    "graph",
  );
  if (Object.hasOwn(source, "gates") && Object.hasOwn(source, "result_profiles"))
    throw new Error("Use graph.gates only; do not combine gates and legacy result_profiles");
  const graph: Record<string, any> = {
    ...source,
    gates: Object.hasOwn(source, "gates") ? source.gates : source.result_profiles,
  };
  if (!new Set(["off", "advise", "enforce"]).has(graph.mode))
    throw new Error("graph.mode must be off, advise, or enforce");
  if (
    graph.repair_first !== undefined
    && (!Array.isArray(graph.repair_first)
      || graph.repair_first.some(
        (key: unknown) => typeof key !== "string" || !TRIGGERABLE_CHECK_KEYS.includes(key as any),
      ))
  )
    throw new Error("graph.repair_first must contain public dynamic check keys");
  const action = (value: unknown, path: string): PolicyAction => {
    if (typeof value !== "string" || !POLICY_ACTIONS.includes(value as PolicyAction))
      throw new Error(`${path} must be one of: ${POLICY_ACTIONS.join(", ")}`);
    return value as PolicyAction;
  };
  const parsePredicates = (rawPredicates: unknown, path: string): Predicate[] => {
    if (!Array.isArray(rawPredicates)) throw new Error(`${path} must be an array`);
    return rawPredicates.map((rawPredicate, index) => {
      const name = `${path}[${index}]`;
      const predicate = object(
        rawPredicate,
        ["path", "equals", "empty", "greater_than", "at_least"],
        name,
      );
      if (
        typeof predicate.path !== "string"
        || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(predicate.path)
      )
        throw new Error(`${name}.path must be a safe dotted property path`);
      const operators = ["equals", "empty", "greater_than", "at_least"].filter((key) =>
        Object.hasOwn(predicate, key),
      );
      if (operators.length !== 1)
        throw new Error(
          `${name} must define exactly one of equals, empty, greater_than, or at_least`,
        );
      if (operators[0] === "empty" && typeof predicate.empty !== "boolean")
        throw new Error(`${name}.empty must be a boolean`);
      for (const operator of ["greater_than", "at_least"]) {
        if (
          operators[0] === operator
          && (typeof predicate[operator] !== "number" || !Number.isFinite(predicate[operator]))
        )
          throw new Error(`${name}.${operator} must be a finite number`);
      }
      if (
        operators[0] === "equals"
        && predicate.equals !== null
        && !["string", "number", "boolean"].includes(typeof predicate.equals)
      )
        throw new Error(`${name}.equals must be a scalar or null`);
      if (typeof predicate.equals === "number" && !Number.isFinite(predicate.equals))
        throw new Error(`${name}.equals must be finite`);
      return predicate as Predicate;
    });
  };
  const profilesRaw = object(graph.gates ?? {}, Object.keys(graph.gates ?? {}), "graph.gates");
  const gates: Record<string, any> = {};
  for (const [name, rawProfile] of Object.entries(profilesRaw)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))
      throw new Error(`Invalid graph result profile name: ${name}`);
    const profile = object(rawProfile, ["check", "all"], `graph.gates.${name}`);
    if (
      profile.check != null
      && (typeof profile.check !== "string"
        || !TRIGGERABLE_CHECK_KEYS.includes(profile.check as any))
    )
      throw new Error(`graph.gates.${name}.check must be a public dynamic check key`);
    gates[name] = {
      check: profile.check ?? null,
      all: parsePredicates(profile.all, `graph.gates.${name}.all`),
    };
  }
  const actionsRaw = object(graph.actions ?? {}, [...POLICY_ACTIONS], "graph.actions");
  const actions: Record<string, any> = {};
  for (const [name, rawNode] of Object.entries(actionsRaw)) {
    const node = object(
      rawNode,
      ["requires", "on_unmet", "next", "arguments", "unless", "enforce", "requires_when"],
      `graph.actions.${name}`,
    );
    if (
      node.requires !== undefined
      && (!Array.isArray(node.requires)
        || node.requires.some(
          (item: unknown) => typeof item !== "string" || !Object.hasOwn(gates, item),
        ))
    )
      throw new Error(`graph.actions.${name}.requires must contain defined result profile names`);
    if (node.next !== undefined && !Array.isArray(node.next))
      throw new Error(`graph.actions.${name}.next must be an array`);
    if (node.arguments !== undefined) {
      const values = object(
        node.arguments,
        Object.keys(node.arguments ?? {}),
        `graph.actions.${name}.arguments`,
      );
      for (const value of Object.values(values)) {
        if (
          !["string", "boolean"].includes(typeof value)
          && !(typeof value === "number" && Number.isFinite(value))
          && !(Array.isArray(value) && value.every((item) => typeof item === "string"))
        )
          throw new Error(
            `graph.actions.${name}.arguments must contain scalar values or string arrays`,
          );
      }
    }
    if (node.enforce !== undefined && typeof node.enforce !== "boolean")
      throw new Error(`graph.actions.${name}.enforce must be boolean`);
    if (
      node.unless !== undefined
      && (!Array.isArray(node.unless)
        || node.unless.some((group: unknown) => !Array.isArray(group) || group.length === 0))
    )
      throw new Error(`graph.actions.${name}.unless must contain non-empty predicate groups`);
    actions[name] = {
      ...(node.requires_when === undefined
        ? {}
        : {
            requires_when: parsePredicates(
              node.requires_when,
              `graph.actions.${name}.requires_when`,
            ),
          }),
      ...(node.enforce === undefined ? {} : { enforce: node.enforce }),
      ...(node.unless === undefined
        ? {}
        : {
            unless: node.unless.map((group: unknown, index: number) =>
              parsePredicates(group, `graph.actions.${name}.unless[${index}]`),
            ),
          }),
      arguments: node.arguments ?? {},
      requires: node.requires ?? [],
      on_unmet:
        node.on_unmet === undefined || node.on_unmet === null
          ? null
          : action(node.on_unmet, `graph.actions.${name}.on_unmet`),
      next: (node.next ?? []).map((rawTransition: unknown, index: number) => {
        const transition = object(
          rawTransition,
          ["action", "all"],
          `graph.actions.${name}.next[${index}]`,
        );
        return {
          action:
            transition.action === null
              ? null
              : action(transition.action, `graph.actions.${name}.next[${index}].action`),
          all: parsePredicates(transition.all, `graph.actions.${name}.next[${index}].all`),
        };
      }),
    };
  }
  let confirmation: { method: "token"; expires_after: string } | null = null;
  if (graph.confirmation !== undefined && graph.confirmation !== null) {
    const configured = object(
      graph.confirmation,
      ["method", "expires_after"],
      "graph.confirmation",
    );
    if (configured.method !== "token") throw new Error("graph.confirmation.method must be token");
    if (
      typeof configured.expires_after !== "string"
      || !/^([1-9]\d*)(s|m|h)$/.test(configured.expires_after)
    )
      throw new Error("graph.confirmation.expires_after must be a duration such as 5m");
    const durationMatch = /^([1-9]\d*)(s|m|h)$/.exec(configured.expires_after)!;
    const durationMs =
      Number(durationMatch[1])
      * ({ s: 1_000, m: 60_000, h: 3_600_000 }[durationMatch[2]] as number);
    if (!Number.isSafeInteger(durationMs))
      throw new Error("graph confirmation expiration is too large");
    confirmation = { method: "token", expires_after: configured.expires_after };
  } else if (graph.mode === "advise")
    throw new Error("graph.confirmation is required in advise mode");
  const notesRaw = graph.notes ?? [];
  if (!Array.isArray(notesRaw)) throw new Error("graph.notes must be an array");
  const notes = notesRaw.map((rawNote: unknown, index: number) => {
    const note = object(rawNote, ["id", "when", "severity", "message"], `graph.notes[${index}]`);
    const when = object(note.when, ["check", "all"], `graph.notes[${index}].when`);
    if (typeof note.id !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(note.id))
      throw new Error(`graph.notes[${index}].id is invalid`);
    if (!new Set(["info", "warning", "error"]).has(note.severity))
      throw new Error(`graph.notes[${index}].severity is invalid`);
    if (typeof note.message !== "string" || !note.message.trim())
      throw new Error(`graph.notes[${index}].message must be non-empty`);
    if (
      when.check !== undefined
      && when.check !== null
      && (typeof when.check !== "string" || !TRIGGERABLE_CHECK_KEYS.includes(when.check as any))
    )
      throw new Error(
        `graph.notes[${index}].when.check must be a public dynamic check key or null`,
      );
    return {
      id: note.id,
      when: {
        check: when.check ?? null,
        all: parsePredicates(when.all, `graph.notes[${index}].when.all`),
      },
      severity: note.severity,
      message: note.message,
    };
  });
  if (new Set(notes.map((note) => note.id)).size !== notes.length)
    throw new Error("graph note IDs must be unique");
  const start =
    graph.start === undefined || graph.start === null ? null : action(graph.start, "graph.start");
  if (start && !Object.hasOwn(actions, start))
    throw new Error("graph.start must identify a configured graph action");
  return {
    mode: graph.mode,
    start,
    confirmation,
    gates,
    actions,
    notes,
    ...(graph.repair_first === undefined
      ? {}
      : { repair_first: [...new Set(graph.repair_first)] as string[] }),
  } as PolicyGraph;
}

export function parsePolicy(text: string): Policy {
  try {
    const doc = parseDocument(text, { uniqueKeys: true, merge: false });
    if (doc.errors.length > 0 || doc.warnings.length > 0)
      throw new Error([...doc.errors, ...doc.warnings].map((item) => item.message).join("; "));
    const root = object(
      doc.toJS({ maxAliasCount: 0 }) ?? {},
      ["runs", "tokens", "checks", "auto_review", "graph", "workflow"],
      "policy",
    );
    if (Object.hasOwn(root, "graph") && Object.hasOwn(root, "workflow"))
      throw new Error("Use graph only; do not combine graph and legacy workflow");
    const group = (key: string, keys: string[]) => object(root[key] ?? {}, keys, key);
    const runs = group("runs", [
      "max_runs",
      "allow_full_preset",
      "allow_manual_batch_name",
      "allow_cancellations",
      "allow_contests",
      "re_evaluation",
    ]);
    const tokens = group("tokens", [
      "allow_general_tokens",
      "min_remaining_balance",
      "challenge_budget",
    ]);
    const checks = group("checks", [
      "allowed",
      "allow_rerun_passing",
      "require_explicit_selection",
      "max_checks_per_request",
      "max_active",
      "allow_contests",
    ]);
    const review = group("auto_review", ["allow_force_refresh"]);
    const reeval = object(
      runs.re_evaluation ?? {},
      ["enabled", "max_attempts"],
      "runs.re_evaluation",
    );
    const value = (group: Record<string, any>, key: string) => group[key] ?? null;
    const result: Policy = {
      runs: {
        max_runs: runs.max_runs ?? {},
        allow_full_preset: value(runs, "allow_full_preset"),
        allow_manual_batch_name: value(runs, "allow_manual_batch_name"),
        allow_cancellations: value(runs, "allow_cancellations"),
        allow_contests: value(runs, "allow_contests"),
        re_evaluation: {
          enabled: value(reeval, "enabled"),
          max_attempts: value(reeval, "max_attempts"),
        },
      },
      tokens: {
        allow_general_tokens: value(tokens, "allow_general_tokens"),
        min_remaining_balance: value(tokens, "min_remaining_balance"),
        challenge_budget: value(tokens, "challenge_budget"),
      },
      checks: {
        allowed: value(checks, "allowed"),
        allow_rerun_passing: value(checks, "allow_rerun_passing"),
        require_explicit_selection: value(checks, "require_explicit_selection"),
        max_checks_per_request: value(checks, "max_checks_per_request"),
        max_active: value(checks, "max_active"),
        allow_contests: value(checks, "allow_contests"),
      },
      auto_review: {
        allow_force_refresh: value(review, "allow_force_refresh"),
      },
      graph: parsePolicyGraph(Object.hasOwn(root, "graph") ? root.graph : root.workflow),
    };
    const caps = object(result.runs.max_runs, ["nova", "vega", "orion", "castor"], "runs.max_runs");
    for (const [model, cap] of Object.entries(caps)) {
      if (cap !== null && (!Number.isSafeInteger(cap) || cap < 0))
        throw new Error(`runs.max_runs.${model} must be null or a non-negative integer`);
    }
    if (
      result.checks.allowed !== null
      && (!Array.isArray(result.checks.allowed)
        || result.checks.allowed.some((key) => !TRIGGERABLE_CHECK_KEYS.includes(key as any)))
    ) {
      throw new Error(
        `checks.allowed must contain public dynamic check keys: ${TRIGGERABLE_CHECK_KEYS.join(", ")}`,
      );
    }
    const integers = {
      "checks.max_checks_per_request": result.checks.max_checks_per_request,
    };
    for (const [key, n] of Object.entries(integers))
      if (n !== null && (!Number.isSafeInteger(n) || n < 0))
        throw new Error(`${key} must be null or a non-negative integer`);
    const attempts = result.runs.re_evaluation.max_attempts;
    if (attempts !== null && (!Number.isSafeInteger(attempts) || attempts < 0))
      throw new Error("runs.re_evaluation.max_attempts must be null or a non-negative integer");
    const active = result.checks.max_active;
    if (active !== null && (!Number.isSafeInteger(active) || active < 0))
      throw new Error("checks.max_active must be null or a non-negative integer");

    const budget = result.tokens.challenge_budget;
    if (budget !== null && (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0))
      throw new Error("tokens.challenge_budget must be null or a non-negative number");
    const reserve = result.tokens.min_remaining_balance;
    if (
      reserve !== null
      && (typeof reserve !== "number" || !Number.isFinite(reserve) || reserve < 0)
    )
      throw new Error("tokens.min_remaining_balance must be null or a non-negative number");
    for (const [key, v] of Object.entries({
      "runs.allow_manual_batch_name": result.runs.allow_manual_batch_name,
      "runs.allow_cancellations": result.runs.allow_cancellations,
      "runs.allow_full_preset": result.runs.allow_full_preset,
      "tokens.allow_general_tokens": result.tokens.allow_general_tokens,
      "checks.require_explicit_selection": result.checks.require_explicit_selection,
      "auto_review.allow_force_refresh": result.auto_review.allow_force_refresh,
      "runs.re_evaluation.enabled": result.runs.re_evaluation.enabled,
      "checks.allow_contests": result.checks.allow_contests,
      "checks.allow_rerun_passing": result.checks.allow_rerun_passing,
      "runs.allow_contests": result.runs.allow_contests,
    }))
      if (v !== null && typeof v !== "boolean") throw new Error(`${key} must be null or a boolean`);
    return result;
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError("policy.invalid", error instanceof Error ? error.message : String(error));
  }
}

export function policySchema(): Record<string, unknown> {
  const defaults = parsePolicy(defaultPolicyYaml);
  const mapping = (properties: Record<string, any>) => ({
    type: ["object", "null"],
    additionalProperties: false,
    properties,
  });
  const integer = {
    type: ["integer", "null"],
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  };
  const predicateSchema = {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        pattern: "^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$",
      },
      equals: { type: ["string", "number", "boolean", "null"] },
      empty: { type: "boolean" },
      greater_than: { type: "number" },
      at_least: {
        type: "number",
        description:
          "Inclusive numeric minimum; actual must be a finite number greater than or equal to this value.",
      },
    },
    oneOf: ["equals", "empty", "greater_than", "at_least"].map((operator) => ({
      required: [operator],
    })),
  };
  const actionEnum = [...POLICY_ACTIONS];
  const graphSchema = {
    type: ["object", "null"],
    default: null,
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["off", "advise", "enforce"] },
      repair_first: {
        type: "array",
        uniqueItems: true,
        items: { enum: [...TRIGGERABLE_CHECK_KEYS] },
        description:
          "When a named check is stale with a last FAIL result, only those checks may execute first. Repairs bypass graph ordering, not technical guards or budgets.",
      },
      start: { type: ["string", "null"], enum: [...actionEnum, null] },
      confirmation: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["method", "expires_after"],
        properties: {
          method: { const: "token" },
          expires_after: { type: "string", pattern: "^[1-9][0-9]*(s|m|h)$" },
        },
      },
      gates: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["all"],
          properties: {
            check: {
              type: ["string", "null"],
              enum: [...TRIGGERABLE_CHECK_KEYS, null],
            },
            all: { type: "array", items: predicateSchema },
          },
        },
      },
      actions: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          actionEnum.map((name) => [
            name,
            {
              type: "object",
              additionalProperties: false,
              properties: {
                requires_when: {
                  type: "array",
                  items: predicateSchema,
                  description: "Apply requirements only when all state predicates match.",
                },
                enforce: {
                  type: "boolean",
                  description: "Disallow advise confirmation for this action.",
                },
                unless: {
                  type: "array",
                  items: { type: "array", minItems: 1, items: predicateSchema },
                  description:
                    "Skip this action requirements if any non-empty group of state predicates all match. Unknown values never match absent fields.",
                },
                arguments: {
                  type: "object",
                  additionalProperties: {
                    anyOf: [
                      { type: ["string", "number", "boolean"] },
                      { type: "array", items: { type: "string" } },
                    ],
                  },
                },
                requires: {
                  type: "array",
                  items: { type: "string" },
                  uniqueItems: true,
                },
                on_unmet: {
                  type: ["string", "null"],
                  enum: [...actionEnum, null],
                },
                next: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["action", "all"],
                    properties: {
                      action: { type: ["string", "null"], enum: [...actionEnum, null] },
                      all: { type: "array", items: predicateSchema },
                    },
                  },
                },
              },
            },
          ]),
        ),
      },
      notes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "when", "severity", "message"],
          properties: {
            id: { type: "string" },
            severity: { enum: ["info", "warning", "error"] },
            message: { type: "string", minLength: 1 },
            when: {
              type: "object",
              additionalProperties: false,
              required: ["all"],
              properties: {
                check: {
                  type: ["string", "null"],
                  enum: [...TRIGGERABLE_CHECK_KEYS, null],
                },
                all: { type: "array", items: predicateSchema },
              },
            },
          },
        },
      },
    },
    required: ["mode"],
    allOf: [
      {
        if: { properties: { mode: { const: "advise" } }, required: ["mode"] },
        // eslint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a thenable.
        then: { required: ["confirmation"] },
      },
    ],
  };
  const describe = (value: any, path: string): any => {
    if (path === "graph")
      return {
        ...graphSchema,
        not: { type: "object", required: ["gates", "result_profiles"] },
        properties: {
          ...graphSchema.properties,
          result_profiles: {
            ...graphSchema.properties.gates,
            deprecated: true,
            description: "Legacy alias for gates. Do not use both names.",
          },
        },
      };
    if (path === "runs.max_runs")
      return {
        ...mapping(
          Object.fromEntries(
            Object.entries(defaults.runs.max_runs).map(([model, cap]) => [
              model,
              {
                ...integer,
                default: cap,
                description:
                  "Maximum current original runs; zero blocks this model, null or omission disables its limit.",
              },
            ]),
          ),
        ),
        default: value,
      };
    if (path === "checks.allowed")
      return {
        type: ["array", "null"],
        items: { type: "string", enum: [...TRIGGERABLE_CHECK_KEYS] },
        default: value,
      };

    if (path === "tokens.min_remaining_balance" || path === "tokens.challenge_budget")
      return { type: ["number", "null"], minimum: 0, default: null };
    if (path === "checks.max_active" || path === "runs.re_evaluation.max_attempts")
      return { ...integer, default: value };
    if (typeof value === "boolean") return { type: ["boolean", "null"], default: value };
    if (typeof value === "number")
      return {
        type: ["integer", "null"],
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        default: value,
      };
    return mapping(
      Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          describe(child, path ? `${path}.${key}` : key),
        ]),
      ),
    );
  };
  const schema = describe(defaults, "");
  schema.properties.workflow = {
    ...schema.properties.graph,
    deprecated: true,
    description: "Legacy alias for graph; normalized on load. Do not use both names.",
  };
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Olympus policy",
    ...schema,
    not: { type: "object", required: ["graph", "workflow"] },
  };
}

export function loadPolicy(): Policy {
  let text: string;
  try {
    assertFileWithinLimit(policyPath(), MAX_LOCAL_STATE_BYTES, "Policy file");
    text = readFileSync(policyPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return parsePolicy("{}");
    }
    throw new PolicyError("policy.unreadable", `Cannot read ${policyPath()}`);
  }
  return parsePolicy(text);
}

export function assertTokenPolicy(
  args: { useGeneralTokens?: unknown },
  policy = loadPolicy(),
): void {
  if (args.useGeneralTokens && policy.tokens.allow_general_tokens === false)
    throw new PolicyError(
      "tokens.allow_general_tokens",
      "Explicit use of general tokens is disabled by policy",
    );
}

function solverName(value: unknown): "nova" | "vega" | "orion" | "castor" | undefined {
  if (typeof value !== "string") return undefined;
  const type = parseAgentTypeInput(value) ?? value;
  const names = {
    gemini_cli: "nova",
    claude_code: "vega",
    codex_cli: "orion",
    taiga: "castor",
  } as const;
  return Object.hasOwn(names, type) ? names[type as keyof typeof names] : undefined;
}

export function runLimit(model: string, policy = loadPolicy()): number | null {
  const name = solverName(model);
  if (!name) throw new PolicyError("runs.max_runs", "Unknown requested model");
  return policy.runs.max_runs[name] ?? null;
}

export function assertRunCount(model: string, count: number, policy = loadPolicy()): void {
  const limit = runLimit(model, policy);
  if (limit !== null && count > limit)
    throw new PolicyError("runs.max_runs", "Requested runs exceed the limit for current inputs", {
      limit,
      requested: count,
    });
}

type RunConfig = { taskAgentType: string; evalAgentType: string };
export function assertRunRequest(
  configs: RunConfig[],
  batchName: unknown,
  policy = loadPolicy(),
): void {
  if (batchName !== undefined && policy.runs.allow_manual_batch_name === false)
    throw new PolicyError(
      "runs.allow_manual_batch_name",
      "Manual batch names are disabled by policy",
    );
  if (configs.length === 0) throw new PolicyError("runs.max_runs", "At least one run is required");
  assertRunCapacity([], configs, policy);
}

/** Only strict stale:false originals consume the current input quota. */
export function assertRunCapacity(
  records: unknown,
  requested: RunConfig[],
  policy = loadPolicy(),
): void {
  const requests = new Map<string, number>();
  for (const config of requested) {
    const model = solverName(config.taskAgentType);
    if (!model) throw new PolicyError("runs.max_runs", "Unknown requested model");
    if (runLimit(model, policy) !== null) requests.set(model, (requests.get(model) ?? 0) + 1);
  }
  if (requests.size === 0) return;
  const unavailable: (message: string) => never = (message: string) => {
    throw new PolicyError("runs.state_unavailable", message);
  };
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
    const label =
      typeof run.label === "string"
        ? /^(Nova|Vega|Orion|Castor) #[1-9]\d*(?: · re-eval [1-9]\d*)?$/.exec(run.label)?.[1]
        : undefined;
    const codename = solverName(run.taskAgentCodename),
      labelModel = solverName(label);
    if (run.taskAgentCodename !== undefined && !codename)
      unavailable("Unknown public model codename");
    if (codename && labelModel && codename !== labelModel)
      unavailable("Conflicting public model names");
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
  for (const [model, count] of requests) {
    const limit = runLimit(model, policy),
      existing = counts.get(model) ?? 0;
    if (limit !== null && existing + count > limit)
      throw new PolicyError(
        "runs.max_runs",
        "Requested runs exceed the model limit for current inputs",
        { model, existing, requested: count, limit },
      );
  }
}

const contestEndpoints = new Set([
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
export function isPolicyEndpoint(name: string, args: Record<string, unknown>): boolean {
  return (
    name === "runAgentRuns:cancelRun"
    || name === "runAgentRuns:scratchRun"
    || paidEndpoints.has(name)
    || Object.hasOwn(args, "useGeneralTokens")
  );
}

export function assertRunPreset(preset: unknown, policy = loadPolicy()): void {
  if (preset === "full" && policy.runs.allow_full_preset === false)
    throw new PolicyError(
      "runs.allow_full_preset",
      "The full rollout preset is disabled by policy",
    );
}

function checkKeysForEndpoint(name: string, args: Record<string, unknown>): string[] {
  if (name === "runDynamicChecks:triggerDynamicCheck") {
    if (typeof args.checkKey !== "string")
      throw new PolicyError("checks.selection_invalid", "A check key is required");
    return [toPublicCheckKey(args.checkKey)];
  }
  if (name === "runDynamicChecks:triggerAllDynamicChecks") {
    if (!Array.isArray(args.checkKeys) || args.checkKeys.some((key) => typeof key !== "string"))
      throw new PolicyError("checks.selection_invalid", "An explicit check list is required");
    return [...new Set(args.checkKeys.map(toPublicCheckKey))];
  }
  if (name === "orchestratorReview:triggerOrchestratorReview") return ["autoReview"];
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
  if (keys.length === 0)
    throw new PolicyError("checks.selection_invalid", "Select at least one check");
  const unique = [...new Set(keys.map(toPublicCheckKey))];
  const allowed = policy.checks.allowed;
  if (allowed !== null && unique.some((key) => !allowed.includes(key)))
    throw new PolicyError("checks.allowed", "The request contains a disallowed check", {
      allowed: policy.checks.allowed,
      requested: unique,
    });
  if (
    policy.checks.max_checks_per_request !== null
    && unique.length > policy.checks.max_checks_per_request
  )
    throw new PolicyError("checks.max_checks_per_request", "Too many checks in one request", {
      requested: unique.length,
      limit: policy.checks.max_checks_per_request,
    });
}

export function assertPaidEndpoint(
  name: string,
  args: Record<string, unknown>,
  policy?: Policy,
): void {
  if (!isPolicyEndpoint(name, args)) return;
  const effective = policy ?? loadPolicy();
  assertTokenPolicy(args, effective);
  if (name === "runAgentRuns:cancelRun" && effective.runs.allow_cancellations === false)
    throw new PolicyError(
      "runs.allow_cancellations",
      "Run cancellations are disabled by guardrails",
    );
  if (
    name === "runAgentRuns:scratchRun"
    && args.scratched !== false
    && effective.runs.allow_contests === false
  )
    throw new PolicyError("runs.allow_contests", "Run contests are disabled by policy");
  if (contestEndpoints.has(name) && effective.checks.allow_contests === false)
    throw new PolicyError("checks.allow_contests", "Check contests are disabled by policy");
  if (name === "reEvalRuns:triggerReEvalRuns" && effective.runs.re_evaluation.enabled === false)
    throw new PolicyError("runs.re_evaluation.enabled", "Re-evaluation is disabled by policy");
  const keys = checkKeysForEndpoint(name, args);
  if (keys.length > 0) assertCheckSelection(keys, true, effective);
  if (
    name === "orchestratorReview:triggerOrchestratorReview"
    && args.forceFresh
    && effective.auto_review.allow_force_refresh === false
  )
    throw new PolicyError(
      "auto_review.allow_force_refresh",
      "Forced fresh Auto Review is disabled; resume without --force-fresh",
    );
}

// Live cost and capacity guards
// Read-only, live preflights; the dispatch wrapper separately reserves local budget.
const api = anyApi;
type Reader = { query: (reference: any, args: any) => Promise<any> };
const record = (value: any): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function currentCheckPassed(value: unknown, key: string): boolean {
  if (value == null) return false;
  if (!record(value) || typeof value.status !== "string")
    throw new Error(`Invalid result for ${key}`);
  const status = value.status.toLowerCase();
  if (!activeStatuses.has(status) && !inactiveStatuses.has(status))
    throw new Error(`Unknown status for ${key}: ${value.status}`);
  if (status !== "completed" || value.stale === true) return false;
  const output = value.output;
  if (output == null) return false;
  if (!record(output) || (output.evaluation != null && !record(output.evaluation)))
    throw new Error(`Invalid output for ${key}`);
  const verdict =
    output.verdict
    ?? output.evaluation?.verdict
    ?? (key === "autoReview" ? output.outcome : undefined);
  if (verdict == null) return false;
  if (typeof verdict !== "string") throw new Error(`Invalid verdict for ${key}`);
  const passed =
    verdict.toUpperCase() === "PASS"
    || (key === "autoReview" && verdict.toUpperCase() === "APPROVED");
  if (!passed) return false;
  if (value.stale !== false) throw new Error(`Freshness is unknown for ${key}`);
  return true;
}

function passingChecks(requested: string[], dynamic: unknown, review: unknown): string[] {
  if (!record(dynamic)) throw new Error("Dynamic check results are unavailable");
  const results = new Map<string, unknown>();
  for (const key of requested) {
    const matches = Object.entries(dynamic).filter(
      ([candidate]) => toPublicCheckKey(candidate) === key,
    );
    if (matches.length > 1) throw new Error(`Ambiguous results for ${key}`);
    results.set(key, matches[0]?.[1]);
  }
  if (requested.includes("autoReview")) {
    if (review !== null && (!record(review) || !record(review.slots)))
      throw new Error("Auto Review results are unavailable");
    if (record(review) && review.slots.synthesis != null)
      results.set("autoReview", review.slots.synthesis);
  }
  return requested.filter((key) => currentCheckPassed(results.get(key), key));
}

function currentPrechecksPassed(readiness: unknown): boolean {
  if (!record(readiness) || !Array.isArray(readiness.criteria))
    throw new Error("Submission readiness is unavailable");
  const criterion = readiness.criteria.find((item: any) => item?.id === "prechecks");
  if (!record(criterion) || typeof criterion.status !== "string")
    throw new Error("Readiness has no prechecks criterion");
  if (criterion.status.toLowerCase() !== "pass") return false;
  if (criterion.stale !== false) throw new Error("Precheck freshness is unknown");
  return true;
}

async function assertCheckRerunAllowed(
  client: Reader,
  name: string,
  args: Record<string, any>,
  policy: Policy,
): Promise<void> {
  if (policy.checks.allow_rerun_passing !== false) return;
  if (name === "contributorTokens:runAllChecksWithToken") {
    const details = {
      endpoint: name,
      problemId: args.problemId,
      versionId: args.versionId,
      dispatched: false,
    };
    let readiness: any;
    try {
      if (!id(args.problemId) || !id(args.versionId))
        throw new Error("A challenge ID and version ID are required to inspect prechecks");
      readiness = await client.query(api.submissionReadiness.getSubmissionReadiness, {
        problemId: args.problemId,
      });
      const passed = currentPrechecksPassed(readiness);
      if (passed)
        throw new PolicyError(
          "checks.allow_rerun_passing",
          "Not dispatched: current prechecks already passed. Rerunning passing prechecks is disabled by policy.",
          { ...details, alreadyPassed: ["prechecks"] },
        );
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throw new PolicyError(
        "checks.state_unavailable",
        `Cannot determine whether prechecks already passed: ${error instanceof Error ? error.message : String(error)}`,
        details,
      );
    }
    return;
  }
  const requested = checkKeysForEndpoint(name, args);
  if (requested.length === 0) return;
  const details = {
    endpoint: name,
    versionId: args.versionId,
    requested,
    dispatched: false,
  };
  let alreadyPassed: string[];
  try {
    if (!id(args.versionId)) throw new Error("A version ID is required to inspect check results");
    const dynamic = await client.query(api.runDynamicChecks.getDynamicChecks, {
      versionId: args.versionId,
    });
    const review = requested.includes("autoReview")
      ? await client.query(api.orchestratorReview.getOrchestratorReview, {
          versionId: args.versionId,
        })
      : null;
    alreadyPassed = passingChecks(requested, dynamic, review);
  } catch (error) {
    throw new PolicyError(
      "checks.state_unavailable",
      `Cannot determine whether requested checks already passed: ${error instanceof Error ? error.message : String(error)}`,
      details,
    );
  }
  if (alreadyPassed.length > 0) {
    throw new PolicyError(
      "checks.allow_rerun_passing",
      `Not dispatched: current checks already passed: ${alreadyPassed.join(", ")}. Remove them from the request.`,
      { ...details, alreadyPassed },
    );
  }
}

// These are the exact quick-run keys supported in runs.ts, not a tariff fallback.
const quickSolvers: Record<string, string> = {
  vegaVega: "claude_code",
  vegaOrion: "claude_code",
  orionVega: "codex_cli",
  orionOrion: "codex_cli",
  novaVega1: "gemini_cli",
  novaOrion1: "gemini_cli",
  castorVega1: "taiga",
  castorOrion1: "taiga",
};

async function quoteCost(
  client: Reader,
  name: string,
  args: Record<string, any>,
): Promise<{ cost: number; parts: BudgetPart[] } | undefined> {
  // Admin resume/force and contests have no proven author tariff.
  if (name === "orchestratorReview:triggerOrchestratorReview" || contestEndpoints.has(name))
    return undefined;
  if (name === "reEvalRuns:triggerReEvalRuns" || name === "fpReview:requestFpCheck") {
    const kind = name === "fpReview:requestFpCheck" ? "fp" : "reevaluation";
    const cost = (
      await resolveVersionOffer(
        client,
        kind,
        typeof args.versionId === "string" ? args.versionId : undefined,
      )
    ).tokens;
    return cost === null
      ? undefined
      : {
          cost,
          parts: [
            {
              operation: kind === "fp" ? "reviews:fpCheck" : "runs:reEvaluation",
              amount: cost,
            },
          ],
        };
  }
  const isRun = name === "runAgentRuns:triggerRuns" || name === "runAgentRuns:triggerAgentRun";
  let prices: unknown[];
  let identities: Array<{ operation: string; checkKey?: string }>;
  if (isRun) {
    const runs = await resolveRunPrices(client);
    const solvers =
      name === "runAgentRuns:triggerAgentRun"
        ? [
            Object.hasOwn(quickSolvers, args.agentRunKey)
              ? quickSolvers[args.agentRunKey]
              : undefined,
          ]
        : Array.isArray(args.configs) && args.configs.length > 0
          ? args.configs.map((item: any) =>
              typeof item?.taskAgentType === "string"
                ? (parseAgentTypeInput(item.taskAgentType) ?? item.taskAgentType)
                : undefined,
            )
          : [undefined];
    prices = solvers.map((solver) =>
      solver && Object.hasOwn(runs, solver) ? runs[solver].tokens : undefined,
    );
    identities = solvers.map((solver) => ({ operation: `runs:${solver}` }));
  } else {
    const catalog = await resolveCostCatalog(client);
    const special = {
      "scopeGate:triggerScopeGate": catalog.actions.scopeGate,
      "contributorTokens:runAllChecksWithToken": catalog.actions.bundledPrechecks,
      "dockerImage:buildVersionImage": catalog.actions.build,
    };
    if (Object.hasOwn(special, name)) {
      const cost = special[name as keyof typeof special].tokens;
      const operation =
        name === "scopeGate:triggerScopeGate"
          ? "scope:scopeGate"
          : name === "dockerImage:buildVersionImage"
            ? "builds:build"
            : "checks:bundledPrechecks";
      return cost === null ? undefined : { cost, parts: [{ operation, amount: cost }] };
    }
    const keys = checkKeysForEndpoint(name, args);
    if (keys.length === 0) return undefined;
    prices = keys.map((key) => {
      const backendKey = toBackendCheckKey(key);
      return Object.hasOwn(catalog.checks, backendKey)
        ? catalog.checks[backendKey].tokens
        : undefined;
    });
    identities = keys.map((key) => ({
      operation: `checks:${toPublicCheckKey(key)}`,
      checkKey: toPublicCheckKey(key),
    }));
  }
  if (!prices.every(amount)) return undefined;
  const total = sumBudgetAmounts(prices as number[]);
  return amount(total)
    ? {
        cost: total,
        parts: identities.map((identity, index) =>
          Object.assign(identity, { amount: prices[index] as number }),
        ),
      }
    : undefined;
}

// Align decimal API token values before sums/division (avoid binary 0.1 + 0.2).
function tokenUnits(values: number[]): { units: bigint[]; exponent: number } {
  const parts = values.map((value) => {
    const [mantissa, power = "0"] = String(value).split("e");
    const [whole, fraction = ""] = mantissa.split(".");
    return {
      digits: BigInt(whole + fraction),
      exponent: Number(power) - fraction.length,
    };
  });
  const exponent = Math.min(...parts.map((part) => part.exponent));
  return {
    exponent,
    units: parts.map((part) => part.digits * 10n ** BigInt(part.exponent - exponent)),
  };
}
function decimalTokenSum(values: number[]): number {
  if (!values.every(Number.isFinite)) return NaN;
  const { units, exponent } = tokenUnits(values);
  return Number(`${units.reduce((sum, value) => sum + value, 0n)}e${exponent}`);
}

type DripEstimate = {
  waitSeconds: number | null;
  retryAt: string | null;
  drip: {
    status: "estimated" | "unknown" | "unreachable" | "paused";
    reason: string;
    amount: number | null;
    intervalSeconds: number;
    nextDripAt: number | null;
    cap: number | null;
    source: string;
    estimated: boolean;
    dripsNeeded?: number;
  };
};

function estimateTokenDrip(
  snapshot: Record<string, any>,
  requiredBalance: number,
  now = Date.now(),
  tier?: Record<string, any>,
): DripEstimate {
  const rate = amount(snapshot.tierDripAmount)
    ? snapshot.tierDripAmount
    : tier?.name === snapshot.tierName && amount(tier?.dripAmount)
      ? tier.dripAmount
      : null;
  const cap = amount(snapshot.cap) ? snapshot.cap : null;
  const next =
    typeof snapshot.nextDripAt === "number"
    && Number.isSafeInteger(snapshot.nextDripAt)
    && snapshot.nextDripAt > 0
    && snapshot.nextDripAt <= 8.64e15
      ? snapshot.nextDripAt
      : null;
  const result: DripEstimate = {
    waitSeconds: null,
    retryAt: null,
    drip: {
      status: "unknown",
      reason: "The token drip schedule is unavailable",
      amount: rate,
      intervalSeconds: 3600,
      nextDripAt: next,
      cap,
      source: amount(snapshot.tierDripAmount)
        ? "contributorTokens:getBalance; official UI hourly drip contract"
        : "contributorTokens:getBalance + contributorTokens:getTierConfig; official UI hourly drip contract",
      estimated: false,
    },
  };
  const stop = (status: DripEstimate["drip"]["status"], reason: string) => {
    result.drip.status = status;
    result.drip.reason = reason;
    return result;
  };
  if (snapshot.dripUnlimited !== false)
    return stop("unknown", "The account's special or unknown drip mode cannot be estimated safely");
  if (cap !== null && requiredBalance > cap)
    return stop(
      "unreachable",
      "Required balance exceeds the current token cap; waiting for drip alone cannot satisfy it",
    );
  if (snapshot.dripPaused === true)
    return stop("paused", "Token drip is paused; replenishment time is unknown");
  if (rate === 0)
    return stop(
      "unreachable",
      "The current tier has no token drip; waiting alone cannot satisfy the threshold",
    );
  if (snapshot.needsRefresh === true)
    return stop(
      "unknown",
      "The server reports that the balance needs refresh; replenishment time is unknown until a fresh balance is available",
    );
  if (rate === null || cap === null || snapshot.dripPaused !== false || next === null)
    return result;
  if (next < now)
    return stop(
      "unknown",
      "The reported next drip is in the past; refresh the balance before estimating",
    );
  if (!amount(snapshot.balance) || !amount(requiredBalance) || !Number.isFinite(now)) return result;
  const {
    units: [required, balance, perDrip],
  } = tokenUnits([requiredBalance, snapshot.balance, rate]);
  const missing = required > balance ? required - balance : 0n;
  const count = Number((missing + perDrip - 1n) / perDrip);
  const retry = count === 0 ? now : next + (count - 1) * 3600_000;
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(retry) || retry > 8.64e15)
    return stop("unknown", "The estimated replenishment time is outside the supported range");
  result.waitSeconds = Math.ceil(Math.max(0, retry - now) / 1000);
  result.retryAt = new Date(retry).toISOString();
  result.drip = {
    ...result.drip,
    status: "estimated",
    estimated: true,
    dripsNeeded: count,
    reason:
      "Estimate only: assumes unchanged hourly drip, tier and cap, no other spending, and timely server replenishment; recheck before retrying",
  };
  return result;
}

export async function assertOperationCost(
  client: Reader,
  name: string,
  args: Record<string, any>,
  policy?: Policy,
  quotedCost?: number,
): Promise<void> {
  // Scratching/restoring a run changes metadata, not token spending.
  if (
    name === "runAgentRuns:cancelRun"
    || name === "runAgentRuns:scratchRun"
    || !isPolicyEndpoint(name, args)
  )
    return;
  const effective = policy ?? loadPolicy();
  const { min_remaining_balance: reserve } = effective.tokens;
  if (reserve === null) return;
  let cost: number | undefined;
  try {
    cost = quotedCost ?? (await quoteCost(client, name, args))?.cost;
  } catch {
    cost = undefined;
  }
  if (!amount(cost)) {
    throw new PolicyError(
      "tokens.cost_unavailable",
      "Cannot establish a prospective cost for this operation",
      { endpoint: name },
    );
  }
  let snapshot: Record<string, any> | undefined;
  try {
    snapshot = await client.query(api.contributorTokens.getBalance, {});
  } catch {
    /* A failed read is never a zero balance. */
  }
  const balance: unknown = snapshot?.balance;
  if (!amount(balance))
    throw new PolicyError(
      "tokens.balance_unavailable",
      "Cannot establish the reported token balance",
    );
  const requiredBalance = sumBudgetAmounts([cost, reserve]);
  if (balance >= requiredBalance) return;
  const shortfall = decimalTokenSum([requiredBalance, -balance]);
  let tier: Record<string, any> | undefined;
  if (!amount(snapshot?.tierDripAmount) && typeof snapshot?.tierName === "string") {
    try {
      const tiers = await client.query(api.contributorTokens.getTierConfig, {});
      if (Array.isArray(tiers)) tier = tiers.find((item) => item?.name === snapshot?.tierName);
    } catch {}
  }
  const estimate = estimateTokenDrip(snapshot!, requiredBalance, Date.now(), tier);
  const wait =
    estimate.waitSeconds === null
      ? estimate.drip.reason
      : `Estimated wait: ${estimate.waitSeconds} seconds (retry at ${estimate.retryAt}); not guaranteed, recheck the balance before retrying`;
  throw new PolicyError(
    "tokens.min_remaining_balance",
    `Operation would breach the minimum remaining balance. ${wait}`,
    { cost, balance, limit: reserve, requiredBalance, shortfall, ...estimate },
  );
}

export type PolicyDispatchScope = {
  directory: string;
  backend: string;
  account: string;
  resolveChallenge: (args: Record<string, any>) => Promise<string>;
};

export function assertChallengeBudget(state: BudgetFeedback): void {
  const total =
    state.spent !== null && state.reserved !== null && state.cost !== null
      ? sumBudgetAmounts([state.spent, state.reserved, state.cost])
      : NaN;
  if (!Number.isFinite(total) || total > state.limit)
    throw new PolicyError(
      "tokens.challenge_budget",
      "Operation exceeds the remaining local challenge budget",
      { budget: { ...state, status: "blocked" } },
    );
}

/** One policy decision from declared rules, graph and canonical facts. */
export function evaluatePolicy(
  input: Omit<
    Parameters<typeof evaluatePolicyGraph>[0],
    "graph" | "policyHash" | "batchDecisions"
  > & { policy: Policy },
): PolicyDecision {
  const { policy, state, action, args } = input;
  const keys =
    action === "checks.run_all"
      ? Array.isArray(args.checkKeys)
        ? args.checkKeys.map(String).map(toPublicCheckKey)
        : []
      : action.startsWith("checks.")
        ? [action.slice("checks.".length)]
        : action === "auto_review.orchestrate"
          ? ["autoReview"]
          : [];
  let failure: PolicyError | undefined;
  try {
    assertTokenPolicy(args, policy);
    if (action === "prechecks.run" && policy.checks.allow_rerun_passing === false) {
      let passed: boolean;
      try {
        passed = currentPrechecksPassed(state.readiness);
      } catch (error) {
        throw new PolicyError(
          "checks.state_unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (passed)
        throw new PolicyError("checks.allow_rerun_passing", "Current prechecks already passed", {
          alreadyPassed: ["prechecks"],
        });
    }
    if (keys.length > 0) {
      assertCheckSelection(keys, true, policy);
      if (policy.checks.allow_rerun_passing === false) {
        let passed: string[];
        try {
          passed = passingChecks(keys, state.checks, state.autoReview);
        } catch (error) {
          throw new PolicyError(
            "checks.state_unavailable",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (passed.length > 0)
          throw new PolicyError("checks.allow_rerun_passing", "Current checks already passed", {
            alreadyPassed: passed,
          });
      }
    }
    if (action === "re_evaluation.run" && policy.runs.re_evaluation.enabled === false)
      throw new PolicyError("runs.re_evaluation.enabled", "Re-evaluation is disabled by policy");
    if (
      action === "auto_review.orchestrate"
      && args.forceFresh
      && policy.auto_review.allow_force_refresh === false
    )
      throw new PolicyError(
        "auto_review.allow_force_refresh",
        "Forced fresh Auto Review is disabled by policy",
      );
    if (action === "rollouts.run" && Array.isArray(args.configs))
      assertRunCapacity(state.runs, args.configs, policy);
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    failure = error;
  }
  const batchDecisions =
    action === "checks.run_all"
      ? keys.map((key) =>
          evaluatePolicy({
            ...input,
            action: `checks.${key}` as PolicyAction,
            preview: true,
            confirmation: undefined,
          }),
        )
      : [];
  const decision = evaluatePolicyGraph({
    ...input,
    graph: policy.graph,
    policyHash: policyFingerprint(policy),
    confirmation: input.preview || failure ? undefined : input.confirmation,
    preview: input.preview || Boolean(failure),
    batchDecisions,
  });
  if (!failure) return decision;
  const details = failure.details;
  const expected = Object.hasOwn(details, "limit")
    ? { at_most: details.limit }
    : details.allowed
      ? { one_of: details.allowed }
      : {
          equals:
            failure.rule === "checks.allow_rerun_passing"
              ? "not already passed"
              : "permitted by policy",
        };
  return {
    ...decision,
    status: "blocked",
    mode: "enforce",
    rule: failure.rule,
    confirmation: undefined,
    cliContinuation: { command: input.cliCommand ?? null, append: [] },
    unmetRequirements: [
      {
        profile: failure.rule,
        check: null,
        path: failure.rule,
        expected,
        actual: failure.rule.endsWith("state_unavailable")
          ? null
          : (details.alreadyPassed ?? details.requested ?? "denied"),
        reason: failure.rule.endsWith("state_unavailable") ? "missing_field" : "predicate_failed",
      },
      ...decision.unmetRequirements,
    ],
  };
}

/** Read-only inspection. It never confirms, reserves tokens or dispatches. */
export async function inspectPolicy(
  client: Reader,
  challengeId: string,
  policy = loadPolicy(),
  full = false,
) {
  const state = await readStablePolicyState(client, challengeId);
  const recommended =
    policy.graph && policy.graph.mode !== "off"
      ? policyRecommendedAction(state, policy.graph)
      : null;
  const decisions = POLICY_ACTIONS.map((action) => {
    const configured = policy.graph?.actions[action]?.arguments ?? {};
    const args: Record<string, unknown> = {
      ...configured,
      ...(Array.isArray(configured.checks) ? { checkKeys: configured.checks } : {}),
      useGeneralTokens: configured["use-general-tokens"],
      forceFresh: configured["force-fresh"],
    };
    return evaluatePolicy({
      policy,
      state,
      action,
      args,
      secret: "",
      replayDirectory: "",
      preview: true,
    });
  });
  const decision = decisions.find((item) => item.action === recommended) ?? null;
  const readiness = record(state.readiness) ? state.readiness : {};
  return {
    status: "inspected",
    challengeId,
    versionId: state.versionId,
    actionCatalog: POLICY_ACTIONS,
    decision,
    decisions,
    // Policy permission is not platform readiness or a paid-dispatch preflight.
    executionPreflight: "required",
    platform: { canSubmit: typeof readiness.canSubmit === "boolean" ? readiness.canSubmit : null },
    ...(full ? { state } : {}),
  };
}

async function authorizePolicy(
  input: Pick<
    PolicyDispatch<unknown>,
    "client" | "name" | "args" | "scope" | "confirmationSecret"
  > & { policy: Policy },
): Promise<void> {
  const { client, name, args, scope, policy, confirmationSecret } = input;
  const action = policyActionForEndpoint(name, args);
  const batchActions =
    name === "runDynamicChecks:triggerAllDynamicChecks"
      ? checkKeysForEndpoint(name, args).map((key) => `checks.${key}` as PolicyAction)
      : [];
  if (
    !action
    || !policy.graph
    || policy.graph.mode === "off"
    || ![action, ...batchActions].some((candidate) => policyGovernsAction(policy.graph!, candidate))
  )
    return;
  let state: PolicyState;
  let decision: PolicyDecision;
  try {
    const challengeId = await scope.resolveChallenge(args);
    state = await readStablePolicyState(client, challengeId);
    if (args.versionId !== undefined && args.versionId !== state.versionId)
      throw new Error("Requested version is not the current policy state; refresh before dispatch");
    const current = policyInvocation();
    decision = evaluatePolicy({
      policy,
      state,
      action,
      args,
      confirmation: current.confirmation,
      secret: `${confirmationSecret ?? scope.account}\0${scope.backend}\0${scope.account}\0${localPolicySecret(credentialsDir())}`,
      replayDirectory: resolve(credentialsDir(), "workflow-confirmations"),
      cliCommand: current.command,
    });
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError(
      "policy.state_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (decision.status !== "allowed" && decision.status !== "off") {
    const { message, feedback } = policyDecisionFeedback(decision, state);
    throw new PolicyError(decision.rule ?? `policy.${decision.status}`, message, {
      decision,
      feedback,
    });
  }
}

/** One dispatch through policy, graph confirmation and atomic budget reservation. */
export type PolicyDispatch<T> = {
  /** Client used for cost quoting. */
  client: Reader;
  /** Fully-qualified Convex function name. */
  name: string;
  /** Arguments the endpoint was called with. */
  args: Record<string, any>;
  /** Performs the actual call once the budget allows it. */
  invoke: () => Promise<T>;
  /** Where the local budget ledger lives and how to resolve the challenge. */
  scope: PolicyDispatchScope;
  /** Pre-loaded policy; loaded on demand when omitted. */
  policy?: Policy;
  confirmationSecret?: string;
};

export async function dispatchWithPolicy<T>({
  client,
  name,
  args,
  invoke,
  scope,
  policy,
  confirmationSecret,
}: PolicyDispatch<T>): Promise<T> {
  const effective = policy ?? loadPolicy();
  const authorize = () =>
    authorizePolicy({ client, name, args, scope, policy: effective, confirmationSecret });
  if (!isPolicyEndpoint(name, args)) {
    await authorize();
    return invoke();
  }
  const limit = effective.tokens.challenge_budget;
  assertPaidEndpoint(name, args, effective);
  await assertCheckRerunAllowed(client, name, args, effective);
  if (limit === null || !paidEndpoints.has(name)) {
    await assertOperationCost(client, name, args, effective);
    await authorize();
    return invoke();
  }
  let context: BudgetContext | undefined;
  let reservation: string | undefined;
  let invoked = false;
  let state: BudgetFeedback = {
    scope: "local",
    scopeId: null,
    accounting: "prospective-quotes",
    cost: null,
    spent: null,
    reserved: null,
    limit,
    remaining: null,
    activatedAt: null,
    endpoint: name,
    status: "blocked",
  };
  try {
    const challenge = await scope.resolveChallenge(args);
    state.challengeId = challenge;
    context = {
      directory: scope.directory,
      scope: budgetScope(scope.backend, scope.account, challenge),
      limit,
    };
    state = { ...state, ...(await readBudget(context)) };
    let quote: Awaited<ReturnType<typeof quoteCost>>;
    try {
      quote = await quoteCost(client, name, args);
    } catch {
      quote = undefined;
    }
    if (quote === undefined)
      throw new PolicyError(
        "tokens.cost_unavailable",
        "Cannot establish a prospective cost for this operation",
        { endpoint: name },
      );
    const { cost, parts } = quote;
    state.cost = cost;
    await assertOperationCost(client, name, args, effective, cost);
    const held = await reserveBudget(context, cost, assertChallengeBudget, parts);
    reservation = held.id;
    state = { ...state, ...held.feedback };
    await authorize();
    invoked = true;
    const result = await invoke();
    state = {
      ...state,
      ...(await settleBudget(context, reservation, "spent")),
    };
    reportBudget(state);
    return result;
  } catch (error) {
    if (reservation && context && !invoked) {
      state = {
        ...state,
        ...(await settleBudget(context, reservation, "released")),
      };
    } else if (
      (error instanceof BudgetError || error instanceof PolicyError)
      && error.details.budget
    ) {
      state = { ...state, ...(error.details.budget as BudgetFeedback) };
    }
    reportBudget(state);
    throw error;
  }
}

const activeStatuses = new Set(["pending", "running", "queued", "processing"]);
const inactiveStatuses = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "not_started",
  "idle",
]);
function stateError(): never {
  throw new PolicyError(
    "checks.state_unavailable",
    "Cannot establish active checks across all challenge versions",
  );
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
  client: Reader,
  problemId: string,
  versionId: string,
  requestedKeys: string[],
  policy = loadPolicy(),
): Promise<void> {
  const limit = policy.checks.max_active;
  if (limit === null) return;
  if (
    !Array.isArray(requestedKeys)
    || requestedKeys.length === 0
    || requestedKeys.some(
      (key) =>
        typeof key !== "string" || !TRIGGERABLE_CHECK_KEYS.includes(toPublicCheckKey(key) as any),
    )
  )
    throw new PolicyError(
      "checks.selection_invalid",
      "Capacity requires explicit known check keys",
    );
  const requested = new Set(requestedKeys.map(toPublicCheckKey)).size;
  try {
    const versions = await client.query(api.problems.listVersions, {
      problemId,
    });
    if (
      !Array.isArray(versions)
      || versions.some((version) => !record(version) || !id(version._id))
      || !versions.some((version) => version._id === versionId)
    )
      return stateError();
    const jobs = new Set<string>();
    let reviews: Array<Set<string>> = [];
    for (const currentVersion of new Set<string>(versions.map((version) => version._id))) {
      const [dynamic, review] = await Promise.all([
        client.query(api.runDynamicChecks.getDynamicChecks, {
          versionId: currentVersion,
        }),
        client.query(api.orchestratorReview.getOrchestratorReview, {
          versionId: currentVersion,
        }),
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
        if (!["description", "tests", "solution", "agents", "gate", "synthesis"].includes(key))
          return stateError();
        if (slot === null) continue;
        const job = activeJob(slot);
        if (job) orchestration.add(job);
      }
      if (orchestration.size > 0) {
        // Merge overlapping current job snapshots, counting one logical review,
        // not each of its five slots (or a duplicate dynamic autoReview entry).
        const merged = orchestration;
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
      throw new PolicyError(
        "checks.max_active",
        "Requested checks would exceed challenge active capacity",
        { existing, requested, limit },
      );
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    return stateError();
  }
}

// Remote re-evaluation history and limits
type HistoryRun = {
  id: string;
  jobId: string;
  label: string;
  taskAgentType: string;
  batchTag?: string;
  createdAt: number;
};
export type CandidateSet = {
  fingerprint: string;
  candidateCount: number;
  originalBatches: string[];
  reevaluationBatches: string[];
  attempts: number;
  newestOriginalCreatedAt: number | null;
  newestReevaluationCreatedAt: number | null;
};
export type ReevaluationHistory = {
  candidateSets: CandidateSet[];
  unresolvedBatches: Array<{
    batchTag: string;
    reason: string;
    newestCreatedAt: number;
  }>;
};
const unavailable = (message: string) =>
  new PolicyError("runs.re_evaluation.state_unavailable", message);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Patch-content identity, not a solver-input or evaluator-input fingerprint. */
export async function groupReevaluationHistory(
  records: unknown,
  patchHash: (run: HistoryRun) => Promise<string>,
): Promise<ReevaluationHistory> {
  if (!Array.isArray(records)) throw unavailable("Run history is not an array");
  const batches = new Map<
    string,
    {
      reevaluation: boolean;
      round: number;
      runs: HistoryRun[];
      labels: Set<string>;
      newestCreatedAt: number;
    }
  >();
  const seen = new Map<string, string>();
  for (const r of records) {
    if (
      !r
      || typeof r.id !== "string"
      || !r.id
      || typeof r.jobId !== "string"
      || !r.jobId
      || typeof r.label !== "string"
    )
      throw unavailable("Run history lacks IDs, jobs or labels");
    if (!Number.isFinite(r.createdAt) || r.createdAt < 0)
      throw unavailable(`Run history lacks a valid creation time for ${r.id}`);
    const label = /^(Nova|Vega|Orion|Castor) #[1-9]\d*(?: · re-eval ([1-9]\d*))?$/.exec(r.label);
    // Historical runner types can differ from the public solver codename.
    // The backend's public codename/label identifies the candidate's solver.
    const solver = label ? parseAgentTypeInput(label[1]) : undefined;
    if (
      !label
      || !solver
      || (r.taskAgentCodename !== undefined && r.taskAgentCodename !== label[1])
    )
      throw unavailable(`Unrecognized solver or label for run ${r.id}`);
    if (r.batchTag !== undefined && (typeof r.batchTag !== "string" || !r.batchTag))
      throw unavailable(`Invalid batch tag for run ${r.id}`);
    const reevaluation = Boolean(label[2]);
    if (reevaluation !== Boolean(r.batchTag?.startsWith("reeval-")))
      throw unavailable(`Conflicting re-evaluation markers for run ${r.id}`);
    const round = Number(label[2] ?? 0);
    if (!Number.isSafeInteger(round))
      throw unavailable(`Invalid re-evaluation round for run ${r.id}`);
    const tag = r.batchTag ?? `original:${r.id}`;
    const identity = JSON.stringify([r.jobId, r.label, solver, tag, r.createdAt]);
    if (seen.has(r.id)) {
      if (seen.get(r.id) !== identity) throw unavailable(`Conflicting snapshots for run ${r.id}`);
      continue;
    }
    seen.set(r.id, identity);
    const group = batches.get(tag) ?? {
      reevaluation,
      round,
      runs: [] as HistoryRun[],
      labels: new Set<string>(),
      newestCreatedAt: r.createdAt,
    };
    if (group.reevaluation !== reevaluation || group.round !== round || group.labels.has(r.label))
      throw unavailable(`Inconsistent batch ${tag}`);
    group.labels.add(r.label);
    group.runs.push({
      id: r.id,
      jobId: r.jobId,
      label: r.label,
      taskAgentType: solver,
      batchTag: r.batchTag,
      createdAt: r.createdAt,
    });
    group.newestCreatedAt = Math.max(group.newestCreatedAt, r.createdAt);
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
        if (!/^[a-f0-9]{64}$/.test(hash))
          throw unavailable(`Invalid patch digest for run ${run.id}`);
        members.push(`${run.taskAgentType}:${hash}`);
      }
    } catch {
      unresolvedBatches.push({
        batchTag: tag,
        reason: "Solution patches are unavailable or incomplete",
        newestCreatedAt: batch.newestCreatedAt,
      });
      continue;
    }
    const fingerprint = digest(JSON.stringify(members.toSorted()));
    const set = sets.get(fingerprint) ?? {
      fingerprint,
      candidateCount: members.length,
      originalBatches: [],
      reevaluationBatches: [],
      attempts: 0,
      newestOriginalCreatedAt: null,
      newestReevaluationCreatedAt: null,
    };
    (batch.reevaluation ? set.reevaluationBatches : set.originalBatches).push(tag);
    if (batch.reevaluation) {
      set.attempts += 1;
      set.newestReevaluationCreatedAt = Math.max(
        set.newestReevaluationCreatedAt ?? 0,
        batch.newestCreatedAt,
      );
    } else {
      set.newestOriginalCreatedAt = Math.max(
        set.newestOriginalCreatedAt ?? 0,
        batch.newestCreatedAt,
      );
    }
    sets.set(fingerprint, set);
  }
  for (const set of sets.values()) {
    if (set.originalBatches.length === 0)
      for (const batchTag of set.reevaluationBatches)
        unresolvedBatches.push({
          batchTag,
          reason: "No matching original solution set",
          newestCreatedAt: set.newestReevaluationCreatedAt ?? 0,
        });
    set.originalBatches.sort();
    set.reevaluationBatches.sort();
  }
  return {
    candidateSets: [...sets.values()].toSorted((a, b) =>
      a.fingerprint.localeCompare(b.fingerprint),
    ),
    unresolvedBatches,
  };
}

async function readHistory(client: any, problemId: string, versionId: string): Promise<any[]> {
  try {
    const versions = await client.query(api.problems.listVersions, {
      problemId,
    });
    if (
      !Array.isArray(versions)
      || versions.some((v) => !v || typeof v._id !== "string")
      || !versions.some((v) => v._id === versionId)
    )
      throw unavailable("Cannot enumerate challenge versions");
    const records: any[] = [];
    for (const id of new Set(versions.map((v) => v._id))) {
      const rows = await client.query(api.runAgentRuns.getAgentRuns, {
        versionId: id,
      });
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
    const url = await client.action(api.artifactProxy.fetchArtifact, {
      jobId: run.jobId,
      artifactKey: "solutionPatch",
    });
    if (typeof url !== "string" || new URL(url).protocol !== "https:")
      throw new Error("Invalid artifact URL");
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
    } finally {
      await reader.cancel();
    }
    if (!bytes) throw new Error("Empty artifact cannot establish source identity");
    return hash.digest("hex");
  } catch {
    // Do not leak signed artifact URLs through network errors.
    throw unavailable(`Cannot fingerprint solutionPatch for run ${run.id}`);
  }
}

export async function inspectReevaluationHistory(
  client: any,
  problemId: string,
  versionId: string,
): Promise<ReevaluationHistory> {
  return groupReevaluationHistory(await readHistory(client, problemId, versionId), (run) =>
    remotePatchHash(client, run),
  );
}

export function assertReevaluationAttempts(
  sets: CandidateSet[],
  runCount: unknown,
  limit: number,
): void {
  if (!Number.isSafeInteger(runCount) || (runCount as number) < 1)
    throw unavailable("Re-evaluation offer lacks a valid candidate count");
  const possible = sets.filter((set) => set.candidateCount === runCount);
  if (possible.length === 0)
    throw unavailable("No complete original set matches the offered candidate count");
  const exhausted = possible.filter((set) => set.attempts >= limit);
  if (exhausted.length === 0) return; // Every possible source fits; choosing one is unnecessary.
  if (possible.length > 1)
    throw new PolicyError(
      "runs.re_evaluation.source_ambiguous",
      "The backend does not identify the source set, and a possible source has exhausted its limit",
      { limit, possibleSets: possible.length, exhaustedSets: exhausted.length },
    );
  throw new PolicyError(
    "runs.re_evaluation.max_attempts",
    "The solution set has exhausted its re-evaluation limit",
    {
      limit,
      existing: possible[0].attempts,
      fingerprint: possible[0].fingerprint,
    },
  );
}

export function assertLatestReevaluationAttempts(
  history: ReevaluationHistory,
  runCount: unknown,
  limit: number,
): void {
  if (!Number.isSafeInteger(runCount) || (runCount as number) < 1) {
    throw unavailable("Re-evaluation offer lacks a valid candidate count");
  }
  const possible = history.candidateSets.filter(
    (set) =>
      set.candidateCount === runCount
      && set.originalBatches.length > 0
      && set.newestOriginalCreatedAt !== null,
  );
  if (possible.length === 0) {
    throw unavailable("No complete original set matches the offered candidate count");
  }
  const latestCreatedAt = Math.max(...possible.map((set) => set.newestOriginalCreatedAt as number));
  const latest = possible.filter((set) => set.newestOriginalCreatedAt === latestCreatedAt);
  if (latest.length !== 1) {
    throw new PolicyError(
      "runs.re_evaluation.source_ambiguous",
      "The latest source set is ambiguous",
      { runCount, latestCreatedAt, matchingSets: latest.length },
    );
  }
  const unresolved = history.unresolvedBatches.filter(
    (batch) => batch.newestCreatedAt >= latestCreatedAt,
  );
  if (unresolved.length > 0) {
    throw new PolicyError(
      "runs.re_evaluation.state_unavailable",
      "Cannot enforce the limit with incomplete solution-patch history for the latest source",
      { unresolvedBatches: unresolved },
    );
  }
  if (latest[0].attempts >= limit) {
    throw new PolicyError(
      "runs.re_evaluation.max_attempts",
      "The latest solution set has exhausted its re-evaluation limit",
      {
        limit,
        existing: latest[0].attempts,
        fingerprint: latest[0].fingerprint,
      },
    );
  }
}

const historySignature = (records: any[]) =>
  digest(
    JSON.stringify(
      records
        .map((r) => [
          r?.id,
          r?.jobId,
          r?.label,
          r?.batchTag,
          r?.taskAgentType,
          r?.scratched,
          r?.createdAt,
        ])
        .map((r) => JSON.stringify(r))
        .toSorted(),
    ),
  );

export async function assertRemoteReevaluationAttempts(
  client: any,
  problemId: string,
  versionId: string,
  policy: Policy = loadPolicy(),
): Promise<void> {
  const limit = policy.runs.re_evaluation.max_attempts;
  if (limit === null) return;
  if (limit === 0)
    throw new PolicyError(
      "runs.re_evaluation.max_attempts",
      "Re-evaluation attempts are disabled by policy",
      { limit },
    );
  const before = await readHistory(client, problemId, versionId);
  const history = await groupReevaluationHistory(before, (run) => remotePatchHash(client, run));
  const [offer, after] = await Promise.all([
    client.query(api.reEvalRuns.getReEvalOffer, { versionId }),
    readHistory(client, problemId, versionId),
  ]);
  if (!offer?.eligible || historySignature(before) !== historySignature(after))
    throw unavailable(
      "Re-evaluation offer or history changed during preflight; inspect again before retrying",
    );
  assertLatestReevaluationAttempts(history, offer.runCount, limit);
}
