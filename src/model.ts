export type SubmissionReadiness = {
  criteria: Array<{
    id: string;
    label: string;
    status: string;
    detail?: string;
    stale?: boolean;
  }>;
  canSubmit: boolean;
  isBypassed: boolean;
  bypassNote?: string;
};

export type DynamicCheck = {
  jobId?: string;
  status: string;
  progress?: number;
  currentStep?: string;
  error?: string;
  output?: Record<string, any>;
  createdAt?: number;
  completedAt?: number;
  stale?: boolean;
};

export type DynamicCheckRecord = Record<string, DynamicCheck>;
export type DynamicCheckEntry = DynamicCheck & {
  key: string;
  contested?: boolean;
  contestNote?: string;
};

export type AgentRun = {
  id: string;
  label?: string;
  batchName?: string;
  batchTag?: string;
  runPhase?: string;
  status: string;
  jobId?: string;
  output?: Record<string, unknown>;
  stale?: boolean;
  scratched?: boolean;
  createdAt?: number;
  completedAt?: number;
  progress?: number;
  currentStep?: string;
  error?: string;
  hinted?: boolean;
  taskAgentType?: string;
  evalAgentType?: string;
};

export type AgentRunGroup = {
  key: string;
  name: string;
  batchName?: string;
  batchTag?: string;
  runPhase?: string;
  hinted: boolean;
  staleOnly: boolean;
  createdAt: number;
  runs: AgentRun[];
};

export const DYNAMIC_CHECK_ORDER = [
    // Execution checks, in the order the platform runs them
    "verifyBuild",
    "verifyTests",
    "verifySolution",
    "verifyFlakiness",
    // Review checks
    "verifyFairness",
    "taskQuality",
    "solutionQuality",
    "descriptionQuality",
    // Post-rollout / diagnostic checks
    "verifierIncompleteness",
    "autoReview",
    // Retired: still labelled so stored results on old versions do not render
    // as raw keys. Never triggerable — see expected.js RETIRED_CHECK_KEYS.
    "environmentQuality",
    "crossRunAnalysis",
];
const DYNAMIC_CHECK_LABELS: Record<string, string> = {
    verifyBuild: "Verify Build",
    verifyTests: "Verify Tests",
    verifySolution: "Verify Solution",
    verifyFlakiness: "Verify Flakiness",
    verifyFairness: "Verify Fairness",
    taskQuality: "Task Quality",
    solutionQuality: "Solution Quality",
    descriptionQuality: "Description Quality",
    verifierIncompleteness: "Verifier Incompleteness",
    autoReview: "Auto Review",
    environmentQuality: "Environment Quality (retired)",
    crossRunAnalysis: "Holistic AI Review (retired)",
};
/**
 * Checks whose verdict the backend can mark as contested by the author.
 * Each has a matching `_<key>Contested` flag in the dynamicChecks payload.
 */
export const CONTESTABLE_CHECK_KEYS = [
    "descriptionQuality",
    "solutionQuality",
    "verifyFairness",
];
export const AGENT_TYPE_LABELS: Record<string, string> = {
    claude_code: "Vega",
    codex_cli: "Orion",
    gemini_cli: "Nova",
    taiga: "Castor",
};
const AGENT_TYPE_ALIASES: Record<string, string> = {
    vega: "claude_code",
    orion: "codex_cli",
    nova: "gemini_cli",
    castor: "taiga",
};
const RUN_LABEL_REPLACEMENTS: Array<[RegExp, string]> = [
    [/\bclaude_code\b/gi, "Vega"],
    [/\bcodex_cli\b/gi, "Orion"],
    [/\bgemini_cli\b/gi, "Nova"],
    [/\btaiga\b/gi, "Castor"],
    [/\bClaude\b/g, "Vega"],
    [/\bCodex\b/g, "Orion"],
    [/\bGemini\b/g, "Nova"],
    [/\bTaiga\b/g, "Castor"],
];
export const AGENT_TYPE_CHOICES = Object.keys(AGENT_TYPE_ALIASES).filter((value, index, all) => all.indexOf(value) === index);
function orderIndex(order: readonly string[], value: string): number {
    const index = order.indexOf(value);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
export function parseAgentTypeInput(value: string | undefined): string | undefined {
    if (!value)
        return undefined;
    return AGENT_TYPE_ALIASES[value.trim().toLowerCase()];
}
export function canonicalizeRunLabel(label: string | undefined): string {
    if (!label)
        return "";
    let normalized = label.trim();
    for (const [pattern, replacement] of RUN_LABEL_REPLACEMENTS) {
        normalized = normalized.replace(pattern, replacement);
    }
    return normalized;
}
export function normalizeDynamicChecks(dynamicChecks: unknown): DynamicCheckRecord {
    if (!dynamicChecks || typeof dynamicChecks !== "object" || Array.isArray(dynamicChecks)) {
        return {};
    }
    return Object.fromEntries(Object.entries(dynamicChecks).filter(([key, value]) => {
        return (!key.startsWith("_") &&
            !!value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            "status" in value);
    })) as DynamicCheckRecord;
}
export function getDynamicCheckEntries(dynamicChecks: unknown): DynamicCheckEntry[] {
    const record = normalizeDynamicChecks(dynamicChecks);
    const payload: Record<string, unknown> = dynamicChecks && typeof dynamicChecks === "object" && !Array.isArray(dynamicChecks)
        ? dynamicChecks as Record<string, unknown>
        : {};
    const contestedFor = (key: string): boolean | undefined => {
        if (!CONTESTABLE_CHECK_KEYS.includes(key))
            return undefined;
        return payload[`_${key}Contested`] ? true : undefined;
    };
    const contestNoteFor = (key: string): string | undefined => {
        if (!CONTESTABLE_CHECK_KEYS.includes(key))
            return undefined;
        const note = payload[`_${key}ContestNote`];
        return typeof note === "string" && note.trim() ? note : undefined;
    };
    return Object.entries(record)
        .map(([key, value]) => ({
        key,
        ...value,
        contested: contestedFor(key),
        contestNote: contestNoteFor(key),
    }))
        .sort((a, b) => {
        const orderDelta = orderIndex(DYNAMIC_CHECK_ORDER, a.key) - orderIndex(DYNAMIC_CHECK_ORDER, b.key);
        if (orderDelta !== 0)
            return orderDelta;
        return a.key.localeCompare(b.key);
    });
}
export function formatDynamicCheckLabel(key: string): string {
    return DYNAMIC_CHECK_LABELS[key] ?? key;
}
export function normalizeAgentRuns(runs: unknown): AgentRun[] {
    const entries: unknown[] = Array.isArray(runs)
        ? runs
        : runs && typeof runs === "object"
            ? Object.values(runs)
            : [];
    return entries
        .filter((run): run is AgentRun => {
        return !!run && typeof run === "object" && "id" in run && typeof run.id === "string";
    })
        .sort((a, b) => {
        if (!!a.stale !== !!b.stale)
            return a.stale ? 1 : -1;
        const createdDelta = (b.createdAt ?? 0) - (a.createdAt ?? 0);
        if (createdDelta !== 0)
            return createdDelta;
        return String(a.id).localeCompare(String(b.id));
    });
}
export function formatAgentType(agentType: string | undefined): string {
    if (!agentType)
        return "Unknown";
    const codename = AGENT_TYPE_LABELS[agentType];
    if (codename)
        return codename;
    const normalized = canonicalizeRunLabel(agentType);
    return normalized || agentType;
}
export function formatRunLabel(run: Pick<AgentRun, "label" | "taskAgentType" | "evalAgentType" | "hinted">): string {
    const explicitLabel = canonicalizeRunLabel(run.label);
    if (explicitLabel)
        return explicitLabel;
    const base = `${formatAgentType(run.taskAgentType)} -> ${formatAgentType(run.evalAgentType)}`;
    return run.hinted ? `${base} [hinted]` : base;
}
export function summarizeStatuses(statuses: Array<string | undefined>): Map<string, number> {
    const counts = new Map<string, number>();
    for (const status of statuses) {
        const key = status ?? "unknown";
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}
export function groupRunsByBatch(runs: AgentRun[]): AgentRunGroup[] {
    const groups = new Map<string, AgentRun[]>();
    for (const run of runs) {
        const key = run.batchTag ?? run.batchName ?? `single-${run.id}`;
        const existing = groups.get(key) ?? [];
        existing.push(run);
        groups.set(key, existing);
    }
    return [...groups.entries()]
        .map(([key, groupRuns]) => {
        const sortedRuns = [...groupRuns].sort((a, b) => {
            if (!!a.stale !== !!b.stale)
                return a.stale ? 1 : -1;
            return (b.createdAt ?? 0) - (a.createdAt ?? 0);
        });
        const first = sortedRuns[0];
        const phaseSet = new Set(sortedRuns.map((run) => run.runPhase).filter(Boolean));
        return {
            key,
            name: first?.batchName ?? first?.batchTag ?? `Run ${String(first?.id ?? key).slice(0, 8)}`,
            batchName: first?.batchName,
            batchTag: first?.batchTag,
            runPhase: phaseSet.size === 1 ? first?.runPhase : "mixed",
            hinted: sortedRuns.some((run) => !!run.hinted),
            staleOnly: sortedRuns.every((run) => !!run.stale),
            createdAt: Math.max(...sortedRuns.map((run) => run.createdAt ?? 0)),
            runs: sortedRuns,
        };
    })
        .sort((a, b) => {
        if (a.staleOnly !== b.staleOnly)
            return a.staleOnly ? 1 : -1;
        return b.createdAt - a.createdAt;
    });
}
export function resolveRunSelector(runs: AgentRun[], selector: string): { run?: AgentRun; matches?: AgentRun[] } {
    const normalizedSelector = selector.trim().toLowerCase();
    if (!normalizedSelector)
        return { run: undefined };
    const exactId = runs.find((run) => String(run.id).toLowerCase() === normalizedSelector);
    if (exactId)
        return { run: exactId };
    const exactLabelMatches = runs.filter((run) => formatRunLabel(run).toLowerCase() === normalizedSelector);
    if (exactLabelMatches.length === 1)
        return { run: exactLabelMatches[0] };
    if (exactLabelMatches.length > 1)
        return { matches: exactLabelMatches };
    const prefixMatches = runs.filter((run) => String(run.id).toLowerCase().startsWith(normalizedSelector));
    if (prefixMatches.length === 1)
        return { run: prefixMatches[0] };
    if (prefixMatches.length > 1)
        return { matches: prefixMatches };
    return { run: undefined };
}
