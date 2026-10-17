import { formatDynamicCheckLabel } from "./model.ts";
import { toPublicCheckKey } from "./expected.ts";

export type ConditionPredicate = {
  path: string;
  equals?: unknown;
  empty?: boolean;
  exists?: boolean;
  at_least?: number;
  less_than?: number;
  greater_than?: number;
};

const ARTIFACTS: Record<string, string> = {
  description: "task prompt",
  tests: "tests",
  solution: "solution",
  dockerfile: "Dockerfile",
};

const REVIEW_DIMENSIONS: Record<string, string> = {
  description: "task prompt",
  tests: "tests",
  solution: "solution",
};

function operation(predicate: ConditionPredicate): { op: string; value: unknown } {
  for (const op of ["equals", "empty", "exists", "at_least", "less_than", "greater_than"] as const)
    if (Object.hasOwn(predicate, op)) return { op, value: predicate[op] };
  return { op: "equals", value: undefined };
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (Array.isArray(value)) return value.map(text).join(", ") || "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function generic(path: string, op: string, value: unknown): string {
  if (op === "exists") return `${path} ${value ? "exists" : "is missing"}`;
  if (op === "empty") return `${path} ${value ? "is empty" : "is not empty"}`;
  if (op === "at_least") return `${path} ≥ ${text(value)}`;
  if (op === "less_than") return `${path} < ${text(value)}`;
  if (op === "greater_than") return `${path} > ${text(value)}`;
  return `${path} = ${text(value)}`;
}

function compare(subject: string, op: string, value: unknown, unit = ""): string | undefined {
  if (op === "at_least") return `${subject} ≥ ${text(value)}${unit}`;
  if (op === "greater_than") return `${subject} > ${text(value)}${unit}`;
  if (op === "less_than") return `${subject} < ${text(value)}${unit}`;
  if (op === "equals") return `${subject} is ${text(value)}${unit}`;
  return undefined;
}

function percent(value: unknown): string {
  return typeof value === "number" && value <= 1 ? `${Math.round(value * 100)}%` : text(value);
}

type CheckRule = {
  matches: (rest: string, op: string) => boolean;
  phrase: (label: string, value: unknown, op: string, rest: string) => string | undefined;
};

const CHECK_RULES: CheckRule[] = [
  {
    matches: (rest, op) => rest === "status" && op === "exists",
    phrase: (label, value) => (value ? `${label} has run` : `${label} has not run`),
  },
  {
    matches: (rest) => rest === "status",
    phrase: (label, value) => {
      if (value === "completed") return `${label} finished`;
      if (value === "running") return `${label} is running`;
      return `${label} is ${text(value)}`;
    },
  },
  {
    matches: (rest, op) => rest === "stale" && op === "equals",
    phrase: (label, value) => (value ? `${label} is out of date` : `${label} is current`),
  },
  {
    matches: (rest, op) => (rest === "output.verdict" || rest === "verdict") && op === "equals",
    phrase: (label, value) => {
      if (value === null) return `${label} has no verdict`;
      if (value === "PASS") return `${label} passed`;
      if (value === "FAIL") return `${label} failed`;
      return `${label} verdict is ${text(value)}`;
    },
  },
  {
    matches: (rest, op) => /^checkInputs\.\w+\.changedSinceCheck$/.test(rest) && op === "equals",
    phrase: (label, value, _op, rest) => {
      const artifact = rest.split(".")[1];
      return `${ARTIFACTS[artifact] ?? artifact} ${value ? "changed" : "unchanged"} since ${label}`;
    },
  },
  {
    matches: (rest) => rest === "output.coverageSummary.fullyCoveredRatio",
    phrase: (label, value, op) => compare(`${label} full coverage`, op, percent(value)),
  },
  {
    matches: (rest) => rest === "output.coverageSummary.untestedGapCount",
    phrase: (label, value, op) => compare(`${label} untested gaps`, op, value),
  },
  {
    matches: (rest) => /^output\.(description|tests|solution)\.band$/.test(rest),
    phrase: (label, value, op, rest) =>
      compare(`${label} ${REVIEW_DIMENSIONS[rest.split(".")[1]]} band`, op, value),
  },
  {
    matches: (rest, op) => rest === "output.outcome" && op === "equals",
    phrase: (label, value) => `${label} outcome is ${text(value)}`,
  },
  {
    matches: (rest, op) => rest === "output.effectiveScope.verdict" && op === "equals",
    phrase: (label, value) => `${label} effective scope is ${text(value).replaceAll("_", " ")}`,
  },
  {
    matches: (rest) => rest === "output.unfairTestCount",
    phrase: (label, value, op) => compare(`${label} unfair tests`, op, value),
  },
  {
    matches: (rest, op) => rest === "output.offlineUidPassed" && op === "equals",
    phrase: (label, value) => `${label} offline UID check ${value ? "passed" : "did not pass"}`,
  },
  {
    matches: (rest) => rest === "output.offlineUidDetail",
    phrase: (label, value, op) =>
      op === "exists"
        ? `${label} offline UID detail is ${value ? "present" : "missing"}`
        : `${label} offline UID detail is ${text(value)}`,
  },
  {
    matches: (rest, op) => rest === "output.evaluation.comments" && op === "empty",
    phrase: (label, value) =>
      value ? `${label} has no review comments` : `${label} has review comments`,
  },
  {
    matches: (rest, op) => rest === "output.coverageSuggestions" && op === "empty",
    phrase: (label, value) =>
      value ? `${label} has no coverage suggestions` : `${label} has coverage suggestions`,
  },
];

function checkCondition(
  label: string,
  rest: string,
  op: string,
  value: unknown,
): string | undefined {
  return CHECK_RULES.find((rule) => rule.matches(rest, op))?.phrase(label, value, op, rest);
}

function poolCondition(path: string, op: string, value: unknown): string | undefined {
  const match = /^rolloutCriteria\.olympusV2Pools\.(strong|nova)(?:\.(\d+))?\.(\w+)$/.exec(path);
  if (!match) return undefined;
  const pool =
    match[1] === "nova"
      ? "Nova rollouts"
      : `Orion/Vega rollouts${match[2] ? ` (${match[2]})` : ""}`;
  const metrics: Record<string, string> = {
    passes: "passes",
    measured: "measured runs",
    passRate: "pass rate",
    avgSequenceLength: "average sequence length",
    avgPassSequenceLength: "average passing sequence length",
  };
  const metric = metrics[match[3]] ?? match[3];
  return compare(`${pool} ${metric}`, op, match[3] === "passRate" ? percent(value) : value);
}

function stateCondition(path: string, op: string, value: unknown): string | undefined {
  const flags: Record<string, [string, string]> = {
    "scopeGate.fresh": ["Scope Gate is current", "Scope Gate is out of date"],
    "scopeGate.inFlight": ["Scope Gate is running", "Scope Gate is not running"],
    "fpCheck.hasMinimumRunCohort": ["FP check has enough runs", "FP check needs more runs"],
    "fpCheck.hasEligiblePasses": [
      "FP check has eligible passing runs",
      "FP check has no eligible passing runs",
    ],
    "fpCheck.passed": ["FP check passed", "FP check did not pass"],
    "fpCheck.passesChangedSinceCheck": [
      "passing runs changed since the FP check",
      "passing runs unchanged since the FP check",
    ],
    "prechecksSummary.neverRun": ["prechecks never ran", "prechecks have run"],
    "prechecksSummary.lastRunFailed": ["last precheck run failed", "last precheck run passed"],
    "reEvaluation.eligible": ["re-evaluation is available", "no re-evaluation available"],
  };
  if (flags[path] && op === "equals") return flags[path][value ? 0 : 1];
  if (path === "scopeGate.latestVerdict" && op === "equals") {
    if (value === null) return "Scope Gate has not run";
    return value === "pass" ? "Scope Gate passed" : `Scope Gate verdict is ${text(value)}`;
  }
  if (path === "fpCheck.completedAt" && op === "exists")
    return value ? "FP check finished" : "FP check has not finished";
  if (path === "fpCheck.state" && op === "equals")
    return `FP check is ${text(value).replaceAll("_", " ")}`;
  if (path === "image.harborStatus" && op === "equals")
    return `image harbor status is ${text(value)}`;
  return poolCondition(path, op, value);
}

export function describeCondition(predicate: ConditionPredicate, check?: string | null): string {
  const { op, value } = operation(predicate);
  const path = predicate.path;
  if (check) {
    const phrase = checkCondition(
      formatDynamicCheckLabel(toPublicCheckKey(check)),
      path,
      op,
      value,
    );
    if (phrase) return phrase;
  }
  if (check) {
    const label = formatDynamicCheckLabel(toPublicCheckKey(check));
    if (
      !/^(checks|scopeGate|fpCheck|prechecksSummary|reEvaluation|rolloutCriteria|readiness|image)\./.test(
        path,
      )
    )
      return generic(`${label} ${path}`, op, value);
  }
  const checkPath = /^checks\.(\w+)\.(.+)$/.exec(path);
  if (checkPath) {
    const phrase = checkCondition(
      formatDynamicCheckLabel(toPublicCheckKey(checkPath[1])),
      checkPath[2],
      op,
      value,
    );
    if (phrase) return phrase;
  }
  return stateCondition(path, op, value) ?? generic(path, op, value);
}

export function describeActual(actual: unknown): string {
  if (actual === undefined || actual === null) return "missing";
  if (typeof actual === "boolean") return actual ? "yes" : "no";
  return text(actual);
}

export function describeShortfall(
  predicate: ConditionPredicate,
  check: string | null | undefined,
  actual: unknown,
): string {
  const expected = describeCondition(predicate, check);
  if (actual === undefined || actual === null) return `${expected} (now: missing)`;
  const { op } = operation(predicate);
  if (op === "equals" && (typeof actual === "boolean" || typeof actual === "string")) {
    const now = describeCondition({ path: predicate.path, equals: actual }, check);
    const expectedWords = expected.split(" ");
    const nowWords = now.split(" ");
    let shared = 0;
    while (shared < nowWords.length - 1 && expectedWords[shared] === nowWords[shared]) shared++;
    const shortened = nowWords.slice(shared).join(" ");
    if (!shortened.includes(predicate.path)) return `${expected} (now: ${shortened})`;
  }
  const ratio = /fullyCoveredRatio|passRate/.test(predicate.path);
  return `${expected} (now: ${ratio ? percent(actual) : describeActual(actual)})`;
}
