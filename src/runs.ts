import { defineCommand } from "citty";
import { api, getClient, requireProblemVersion } from "./convex.ts";
import { printJson, printKeyValue, printTable, statusBadge, truncate } from "./format.ts";
import { omitEmpty, paginate, parsePositiveInteger, sliceText } from "./output.ts";
import { formatAgentType, formatRunLabel, groupRunsByBatch, normalizeAgentRuns, parseAgentTypeInput, resolveRunSelector, summarizeStatuses, } from "./model.ts";
import type { AgentRun } from "./model.ts";
const LEGACY_SINGLE_RUN_CONFIGS = {
    vegaVega: { taskAgentType: "claude_code", evalAgentType: "claude_code" },
    vegaOrion: { taskAgentType: "claude_code", evalAgentType: "codex_cli" },
    vegaVega2: { taskAgentType: "claude_code", evalAgentType: "claude_code" },
    vegaOrion2: { taskAgentType: "claude_code", evalAgentType: "codex_cli" },
    vegaOrion3: { taskAgentType: "claude_code", evalAgentType: "codex_cli" },
    orionVega: { taskAgentType: "codex_cli", evalAgentType: "claude_code" },
    orionOrion: { taskAgentType: "codex_cli", evalAgentType: "codex_cli" },
    novaVega1: { taskAgentType: "gemini_cli", evalAgentType: "claude_code" },
    novaVega2: { taskAgentType: "gemini_cli", evalAgentType: "claude_code" },
    novaVega3: { taskAgentType: "gemini_cli", evalAgentType: "claude_code" },
    novaOrion1: { taskAgentType: "gemini_cli", evalAgentType: "codex_cli" },
    novaOrion2: { taskAgentType: "gemini_cli", evalAgentType: "codex_cli" },
    castorVega1: { taskAgentType: "taiga", evalAgentType: "claude_code" },
    castorOrion1: { taskAgentType: "taiga", evalAgentType: "codex_cli" },
};
const COMMON_RUN_ARTIFACT_KEYS = [
    "trajectory",
    "workspaceDiff",
    "solutionPatch",
    "testLog",
    "evalResult",
    "buildLog",
    "agentLog",
    "evalLog",
    "setupLog",
];
const AGENT_INPUT_HELP = "vega, orion, nova, castor";
function parseCount(raw, fallback) {
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function formatPhase(phase) {
    switch (phase) {
        case "evaluation":
            return "evaluation";
        case "extended":
            return "extended";
        case "legacy":
            return "legacy";
        default:
            return phase ?? "unknown";
    }
}
function formatStatusSummary(statusCounts) {
    return [...statusCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([status, count]) => `${count} ${status}`)
        .join(", ");
}
function summarizeConfigMix(configs) {
    const counts = new Map();
    for (const config of configs) {
        const key = `${formatAgentType(config.taskAgentType)} -> ${formatAgentType(config.evalAgentType)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([label, count]) => `${count}x ${label}`);
}
function parseAgentTypeOrExit(value, flag) {
    const parsed = parseAgentTypeInput(value);
    if (!parsed) {
        console.error(`  Invalid --${flag} value: ${value ?? "(missing)"}`);
        console.error(`  Use one of: ${AGENT_INPUT_HELP}`);
        process.exit(1);
    }
    return parsed;
}
function printCriteria(criteria) {
    const criteriaList = criteria?.criteria;
    if (!criteriaList || criteriaList.length === 0)
        return;
    console.log("\n  Rollout Criteria:");
    for (const criterion of criteriaList) {
        const status = String(criterion.status ?? "pending");
        const icon = status === "pass"
            ? "\x1b[32m✓\x1b[0m"
            : status === "fail"
                ? "\x1b[31m✗\x1b[0m"
                : status === "warn"
                    ? "\x1b[33m!\x1b[0m"
                    : "\x1b[90m○\x1b[0m";
        const detail = criterion.detail ? `  ${criterion.detail}` : "";
        const preview = criterion.preview ? " \x1b[90m(preview)\x1b[0m" : "";
        console.log(`    ${icon} ${criterion.label}${detail}${preview}`);
        if (criterion.description) {
            console.log(`      \x1b[90mTarget: ${criterion.description}\x1b[0m`);
        }
        if (criterion.guidance) {
            console.log(`      \x1b[33m${truncate(String(criterion.guidance), 100)}\x1b[0m`);
        }
    }
}
function printRunGroups(runs) {
    if (runs.length === 0) {
        console.log("\n  No rollouts yet.");
        return;
    }
    for (const group of groupRunsByBatch(runs)) {
        const statusSummary = formatStatusSummary(summarizeStatuses(group.runs.map((run) => run.status)));
        const meta = [
            `${group.runs.length} run${group.runs.length === 1 ? "" : "s"}`,
            formatPhase(group.runPhase),
            group.hinted ? "hinted" : null,
            group.staleOnly ? "all stale" : null,
            statusSummary || null,
        ]
            .filter(Boolean)
            .join(" · ");
        console.log(`\n  Batch: ${group.name}`);
        console.log(`    \x1b[90m${meta}\x1b[0m`);
        printTable(group.runs.map((run) => ({
            id: String(run.id).slice(0, 12),
            label: formatRunLabel(run),
            status: `${statusBadge(run.status)}${run.stale ? " \x1b[33m(stale)\x1b[0m" : ""}${run.scratched ? " \x1b[90m(scratched)\x1b[0m" : ""}`,
            verdict: run.output?.verdict ? String(run.output.verdict) : "",
        })), [
            { key: "id", label: "Run ID", width: 12 },
            { key: "label", label: "Label", width: 28 },
            { key: "status", label: "Status", width: 30 },
            { key: "verdict", label: "Verdict", width: 24 },
        ]);
    }
}
type RunConfig = { taskAgentType: string; evalAgentType: string };
type PresetName = "quick" | "full";

function fallbackPresetConfigs(preset: PresetName, isDiamond: boolean): RunConfig[] {
    if (isDiamond) {
        if (preset === "quick") {
            return [{ taskAgentType: "claude_code", evalAgentType: "claude_code" }];
        }
        return Array.from({ length: 10 }, () => ({
            taskAgentType: "taiga",
            evalAgentType: "claude_code",
        }));
    }
    if (preset === "quick") {
        return [{ taskAgentType: "gemini_cli", evalAgentType: "claude_code" }];
    }
    return [
        ...Array.from({ length: 10 }, () => ({
            taskAgentType: "gemini_cli",
            evalAgentType: "claude_code",
        })),
        ...Array.from({ length: 2 }, () => ({
            taskAgentType: "codex_cli",
            evalAgentType: "claude_code",
        })),
    ];
}

function expandServerPreset(value: unknown): RunConfig[] {
    if (!Array.isArray(value)) return [];
    const configs: RunConfig[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.solver !== "string" || typeof item.evaluator !== "string") continue;
        const count = typeof item.count === "number" && item.count > 0 ? item.count : 1;
        for (let index = 0; index < count; index += 1) {
            configs.push({ taskAgentType: item.solver, evalAgentType: item.evaluator });
        }
    }
    return configs;
}

async function getPresetConfigs(
    client: Awaited<ReturnType<typeof getClient>>,
    preset: PresetName,
    isDiamond: boolean,
): Promise<RunConfig[]> {
    const mixes: any = await client.query(api.contributorTokens.getMyPresetMixes, {});
    const serverConfigs = expandServerPreset(mixes?.[preset]);
    return serverConfigs.length > 0 ? serverConfigs : fallbackPresetConfigs(preset, isDiamond);
}

function findAgentRunKey(config: RunConfig): string | undefined {
    return Object.entries(LEGACY_SINGLE_RUN_CONFIGS).find(([, candidate]) =>
        candidate.taskAgentType === config.taskAgentType &&
        candidate.evalAgentType === config.evalAgentType)?.[0];
}

function buildConfigs(args) {
    if (args.preset === "quick" || args.preset === "full") {
        throw new Error("preset configs require problem context");
    }
    if (args.target) {
        const config = LEGACY_SINGLE_RUN_CONFIGS[args.target];
        if (!config) {
            throw new Error(`Unknown rollout selector "${args.target}". Pass a legacy key or use --solver/--evaluator.`);
        }
        return [config];
    }
    if (!args.solver || !args.evaluator) {
        throw new Error("Provide --solver and --evaluator, or pass a legacy rollout key.");
    }
    const solver = parseAgentTypeOrExit(args.solver, "solver");
    const evaluator = parseAgentTypeOrExit(args.evaluator, "evaluator");
    const count = parseCount(args.count, 1);
    return Array.from({ length: count }, () => ({
        taskAgentType: solver,
        evalAgentType: evaluator,
    }));
}
async function assertRolloutsAllowed(client: Awaited<ReturnType<typeof getClient>>, problemId: string) {
    const readiness: any = await client.query(
        api.submissionReadiness.getSubmissionReadiness,
        { problemId },
    );
    const required = new Set(["prechecks", "scopeGate", "dynamicChecks"]);
    const blockers = (readiness?.criteria ?? [])
        .filter((criterion: any) => required.has(criterion.id) && criterion.status !== "pass" && criterion.status !== "warn")
        .map((criterion: any) => `${criterion.label}: ${criterion.detail ?? criterion.status}`);
    if (blockers.length > 0) {
        throw new Error(`Rollouts are blocked: ${blockers.join("; ")}`);
    }
}

async function triggerBatch(args) {
    const client = await getClient();
    const { problem, version } = await requireProblemVersion(client, args.problemId);
    await assertRolloutsAllowed(client, args.problemId);
    const isDiamond = problem.tierLock === "Diamond" || problem.submissionType === "diamond";
    const configs: RunConfig[] = args.preset === "quick" || args.preset === "full"
        ? await getPresetConfigs(client, args.preset, isDiamond)
        : buildConfigs(args);
    if (args.preset === "quick") {
        if (configs.length !== 1) {
            throw new Error(`Quick preset must resolve to exactly one run, got ${configs.length}.`);
        }
        const agentRunKey = findAgentRunKey(configs[0]);
        if (agentRunKey) {
            const result = await client.action(api.runAgentRuns.triggerAgentRun, {
                versionId: version._id,
                agentRunKey,
            });
            return { result, version, configs, isDiamond, endpoint: "triggerAgentRun" };
        }
        const result = await client.action(api.runAgentRuns.triggerRuns, {
            versionId: version._id,
            configs,
            hinted: args.hinted,
            batchName: args.batchName,
            useGeneralTokens: args.useGeneralTokens,
        });
        return { result, version, configs, isDiamond, endpoint: "triggerRuns" };
    }
    const result = await client.action(api.runAgentRuns.triggerRuns, {
        versionId: version._id,
        configs,
        hinted: args.hinted,
        batchName: args.batchName,
        useGeneralTokens: args.useGeneralTokens,
    });
    return { result, version, configs, isDiamond, endpoint: "triggerRuns" };
}
const presets = defineCommand({
    meta: {
        name: "runs presets",
        description: "Show the production rollout presets for a challenge",
    },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const { problem, version } = await requireProblemVersion(client, args.id);
        const isDiamond = problem.tierLock === "Diamond" || problem.submissionType === "diamond";
        const [quick, full] = await Promise.all([
            getPresetConfigs(client, "quick", isDiamond),
            getPresetConfigs(client, "full", isDiamond),
        ]);
        if (args.json) {
            printJson({
                version: version.version,
                isDiamond,
                presets: {
                    quick,
                    full,
                },
            });
            return;
        }
        console.log(`\n  Rollout presets for v${version.version}`);
        console.log(`  \x1b[90mAgent choices: ${AGENT_INPUT_HELP}\x1b[0m`);
        for (const [name, configs] of [
            ["quick", quick],
            ["full", full],
        ]) {
            console.log(`\n  ${name}`);
            console.log(`    \x1b[90m${configs.length} run${configs.length === 1 ? "" : "s"}\x1b[0m`);
            for (const summary of summarizeConfigMix(configs)) {
                console.log(`    ${summary}`);
            }
            console.log(`    \x1b[90mRun: olympus runs run ${args.id} --preset ${name}\x1b[0m`);
        }
        console.log(`\n  Custom runs:`);
        console.log(`    \x1b[90molympus runs run ${args.id} --solver nova --evaluator orion --count 3\x1b[0m`);
        console.log(`    \x1b[90molympus runs run-all ${args.id}  # alias for --preset full\x1b[0m\n`);
    },
});
const view = defineCommand({
    meta: { name: "runs view", description: "View rollout batches for a challenge" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        "include-stale": { type: "boolean", description: "Include stale rollout history" },
        batch: { type: "string", description: "Show runs from one exact batch tag or name" },
        only: { type: "string", description: "Filter runs: passing, failed, running, scratched" },
        limit: { type: "string", description: "Maximum batches or runs returned (default 10)" },
        offset: { type: "string", description: "Batch or run offset (default 0)" },
        full: { type: "boolean", description: "Include complete raw backend payloads" },
        json: { type: "boolean", description: "Output compact JSON" },
    },
    run: async ({ args }) => {
        if (args.only && !new Set(["passing", "failed", "running", "scratched"]).has(args.only)) {
            throw new Error("--only must be passing, failed, running, or scratched");
        }
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const [runs, criteria] = await Promise.all([
            client.query(api.runAgentRuns.getAgentRuns, { versionId: version._id }),
            client.query(api.runAgentRuns.getAgentRunCriteria, { versionId: version._id }),
        ]);
        let normalizedRuns = normalizeAgentRuns(runs).filter(
            (run) => args["include-stale"] || !run.stale,
        );
        if (args.batch) {
            normalizedRuns = normalizedRuns.filter(
                (run) => run.batchTag === args.batch || run.batchName === args.batch,
            );
        }
        if (args.only) {
            normalizedRuns = normalizedRuns.filter((run) => {
                const verdict = String(run.output?.verdict ?? "").toUpperCase();
                if (args.only === "passing") return run.status === "completed" && verdict.startsWith("PASS");
                if (args.only === "failed") return run.status === "failed" || verdict.startsWith("FAIL");
                if (args.only === "running") return isActiveRunStatus(run.status);
                return Boolean(run.scratched);
            });
        }
        if (args.json) {
            if (args.full) {
                printJson({ runs: normalizedRuns, criteria, version: version.version });
            }
            else {
                const limit = parsePositiveInteger(args.limit, 10, "--limit") ?? 10;
                const offset = args.offset === undefined ? 0 : Number(args.offset);
                if (!Number.isInteger(offset) || offset < 0) throw new Error("--offset must be a non-negative integer");
                const criteriaSummary = omitEmpty({
                    allPassing: criteria?.allPassing,
                    computedDifficulty: criteria?.computedDifficulty,
                    passRate: criteria?.observedPassRate,
                    criteria: criteria?.criteria?.map((item: any) => ({
                        id: item.id,
                        label: item.label,
                        status: item.status,
                        detail: item.detail,
                    })),
                });
                if (args.batch) {
                    const page = paginate(normalizedRuns.map(summarizeRun), limit, offset);
                    printJson(omitEmpty({
                        version: version.version,
                        batch: args.batch,
                        runs: page.items,
                        pagination: page.pagination,
                        criteria: criteriaSummary,
                        nextCommand: page.pagination.hasMore
                            ? `olympus runs view ${args.id} --json --batch=${args.batch} --limit=${limit} --offset=${page.pagination.nextOffset}${args["include-stale"] ? " --include-stale" : ""}`
                            : undefined,
                    }));
                }
                else {
                    const batches = groupRunsByBatch(normalizedRuns).map((group) => {
                        const statuses = Object.fromEntries(summarizeStatuses(group.runs.map((run) => run.status)));
                        const verdicts = Object.fromEntries(summarizeStatuses(group.runs.map((run) => String(run.output?.verdict ?? "unknown"))));
                        return omitEmpty({
                            batchTag: group.batchTag,
                            batchName: group.name,
                            runPhase: group.runPhase,
                            hinted: group.hinted,
                            stale: group.staleOnly,
                            runCount: group.runs.length,
                            statuses,
                            verdicts,
                            newestCreatedAt: Math.max(...group.runs.map((run) => run.createdAt ?? 0)),
                            nextCommand: `olympus runs view ${args.id} --json --batch=${group.batchTag ?? group.name}${group.staleOnly ? " --include-stale" : ""}`,
                        });
                    });
                    const page = paginate(batches, limit, offset);
                    printJson(omitEmpty({
                        version: version.version,
                        batches: page.items,
                        pagination: page.pagination,
                        criteria: criteriaSummary,
                        nextCommand: page.pagination.hasMore
                            ? `olympus runs view ${args.id} --json --limit=${limit} --offset=${page.pagination.nextOffset}${args["include-stale"] ? " --include-stale" : ""}`
                            : undefined,
                    }));
                }
            }
            return;
        }
        console.log(`\n  Rollouts for v${version.version}`);
        printRunGroups(normalizedRuns);
        printCriteria(criteria);
        console.log("\n  Commands:");
        console.log(`    olympus runs presets ${args.id}                 Show quick/full rollout mixes`);
        console.log(`    olympus runs run ${args.id} --solver nova --evaluator orion --count 3`);
        console.log(`    olympus runs run ${args.id} --preset full      Trigger the production full preset`);
        console.log(`    olympus runs show ${args.id} <run-id>          Show one rollout in detail`);
        console.log(`    olympus runs artifact ${args.id} <run-id> --key testLog`);
        console.log("");
    },
});
const show = defineCommand({
    meta: { name: "runs show", description: "Show detail for a single rollout" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        run: { type: "positional", description: "Run id, id prefix, or exact label", required: true },
        full: { type: "boolean", description: "Include the complete run and job payload" },
        json: { type: "boolean", description: "Output compact JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const runs = normalizeAgentRuns(await client.query(api.runAgentRuns.getAgentRuns, {
            versionId: version._id,
        }));
        const resolved = resolveRunSelector(runs, args.run);
        if ("matches" in resolved && resolved.matches) {
            throw new Error(
                `Rollout selector "${args.run}" is ambiguous: ${resolved.matches.map((item) => item.id).join(", ")}`,
            );
        }
        const run = resolved.run;
        if (!run) {
            throw new Error(`Rollout "${args.run}" was not found on v${version.version}`);
        }
        const job = args.json && !args.full
            ? null
            : run.jobId
                ? await client.query(api.jobs.get, { id: run.jobId })
                : null;
        const output = job?.output ?? run.output ?? {};
        const detail = { ...run, job };
        if (args.json) {
            if (args.full) return printJson(detail);
            return printJson(omitEmpty({
                version: version.version,
                run: summarizeRun(run),
                artifacts: {
                    testLog: `olympus runs artifact ${args.id} ${run.id} --key=testLog --json`,
                    workspaceDiff: `olympus runs artifact ${args.id} ${run.id} --key=workspaceDiff --json`,
                    solutionPatch: `olympus runs artifact ${args.id} ${run.id} --key=solutionPatch --json`,
                },
                fullCommand: `olympus runs show ${args.id} ${run.id} --json --full`,
            }));
        }
        console.log("");
        printKeyValue([
            ["Run ID", String(run.id)],
            ["Label", formatRunLabel(run)],
            ["Batch", run.batchName ?? run.batchTag ?? null],
            ["Phase", formatPhase(run.runPhase)],
            ["Hinted", run.hinted ? "yes" : "no"],
            ["Status", statusBadge(run.status)],
            ["Verdict", output.verdict ? String(output.verdict) : null],
            ["Solver", formatAgentType(run.taskAgentType)],
            ["Evaluator", formatAgentType(run.evalAgentType)],
            ["Solver Model", output.taskAgentModel ? String(output.taskAgentModel) : null],
            ["Evaluator Model", output.evalAgentModel ? String(output.evalAgentModel) : null],
            ["Trajectory", output.trajectoryLength != null ? String(output.trajectoryLength) : null],
            ["Time", output.executionTimeSeconds != null ? `${output.executionTimeSeconds}s` : null],
            ["Artifact Path", job?.input?.artifactPath ? String(job.input.artifactPath) : null],
        ]);
        if (output.summary) {
            console.log(`\n  Summary:\n    ${truncate(String(output.summary), 400)}`);
        }
        if (output.error || job?.error || run.error) {
            console.log(`\n  Error:\n    ${String(output.error ?? job?.error ?? run.error)}`);
        }
        console.log("\n  Commands:");
        console.log(`    olympus runs artifact ${args.id} ${run.id} --key testLog`);
        console.log(`    olympus runs artifact ${args.id} ${run.id} --key workspaceDiff`);
        console.log("");
    },
});
const run = defineCommand({
    meta: { name: "runs run", description: "Trigger a rollout batch for a challenge" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        target: {
            type: "positional",
            description: "Optional legacy rollout key (compatibility only)",
            required: false,
        },
        solver: { type: "string", description: `Solver agent (${AGENT_INPUT_HELP})` },
        evaluator: { type: "string", description: `Evaluator agent (${AGENT_INPUT_HELP})` },
        count: { type: "string", description: "How many identical runs to trigger" },
        preset: { type: "string", description: "Preset rollout mix: quick or full" },
        hinted: { type: "boolean", description: "Include the version hint text" },
        "batch-name": { type: "string", description: "Optional batch name" },
        "use-general-tokens": {
            type: "boolean",
            description: "Charge general tokens instead of revision tokens",
        },
        wait: { type: "boolean", description: "Wait for triggered rollouts to finish" },
        interval: { type: "string", description: "Poll interval in seconds (default 10)" },
        timeout: { type: "string", description: "Timeout in minutes (default 120)" },
        full: { type: "boolean", description: "Include raw results when waiting" },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const { result, version, configs } = await triggerBatch({
            problemId: args.id,
            target: args.target,
            solver: args.solver,
            evaluator: args.evaluator,
            count: args.count,
            preset: args.preset,
            hinted: args.hinted,
            batchName: args["batch-name"],
            useGeneralTokens: args["use-general-tokens"],
        });
        const batchTag = result?.batchTag;
        if (args.wait) {
            await waitForRuns({
                client: await getClient(),
                problemId: args.id,
                version,
                jobId: undefined,
                runSelector: undefined,
                batch: batchTag,
                includeStale: false,
                intervalMs: parseRunWaitNumber(args.interval, 10, "--interval") * 1000,
                timeoutMs: parseRunWaitNumber(args.timeout, 120, "--timeout") * 60 * 1000,
                json: Boolean(args.json),
                full: Boolean(args.full),
            });
            return;
        }
        const waitCommand = batchTag
            ? `olympus runs wait ${args.id} --batch=${batchTag} --json`
            : `olympus runs wait ${args.id} --json`;
        if (args.json) {
            printJson({ result, triggered: configs, waitCommand });
            return;
        }
        console.log(`\n  Triggered ${configs.length} rollout${configs.length === 1 ? "" : "s"} on v${version.version}`);
        for (const summary of summarizeConfigMix(configs)) {
            console.log(`    ${summary}`);
        }
        console.log(`  \x1b[90mWait: ${waitCommand}\x1b[0m\n`);
    },
});
const runAll = defineCommand({
    meta: { name: "runs run-all", description: "Alias for `olympus runs run <id> --preset full`" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        hinted: { type: "boolean", description: "Include the version hint text" },
        "batch-name": { type: "string", description: "Optional batch name" },
        "use-general-tokens": {
            type: "boolean",
            description: "Charge general tokens instead of revision tokens",
        },
        wait: { type: "boolean", description: "Wait for triggered rollouts to finish" },
        interval: { type: "string", description: "Poll interval in seconds (default 10)" },
        timeout: { type: "string", description: "Timeout in minutes (default 120)" },
        full: { type: "boolean", description: "Include raw results when waiting" },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const { result, version, configs } = await triggerBatch({
            problemId: args.id,
            preset: "full",
            hinted: args.hinted,
            batchName: args["batch-name"],
            useGeneralTokens: args["use-general-tokens"],
        });
        const batchTag = result?.batchTag;
        if (args.wait) {
            await waitForRuns({
                client: await getClient(),
                problemId: args.id,
                version,
                jobId: undefined,
                runSelector: undefined,
                batch: batchTag,
                includeStale: false,
                intervalMs: parseRunWaitNumber(args.interval, 10, "--interval") * 1000,
                timeoutMs: parseRunWaitNumber(args.timeout, 120, "--timeout") * 60 * 1000,
                json: Boolean(args.json),
                full: Boolean(args.full),
            });
            return;
        }
        const waitCommand = batchTag
            ? `olympus runs wait ${args.id} --batch=${batchTag} --json`
            : `olympus runs wait ${args.id} --json`;
        if (args.json) {
            printJson({ result, triggered: configs, preset: "full", waitCommand });
            return;
        }
        console.log(`\n  Triggered preset full (${configs.length} runs) on v${version.version}`);
        for (const summary of summarizeConfigMix(configs)) {
            console.log(`    ${summary}`);
        }
        console.log(`  \x1b[90mWait: ${waitCommand}\x1b[0m\n`);
    },
});
type RunWaitSummary = {
    id: string;
    jobId?: string;
    label: string;
    status: string;
    stale: boolean;
    scratched: boolean;
    batchTag?: string;
    batchName?: string;
    solver: string;
    evaluator: string;
    verdict?: unknown;
    summary?: unknown;
    error?: string;
    progress?: number;
    currentStep?: string;
    createdAt?: number;
    completedAt?: number;
};

function summarizeRun(run: AgentRun): RunWaitSummary {
    return {
        id: run.id,
        jobId: run.jobId,
        label: formatRunLabel(run),
        status: run.status,
        stale: Boolean(run.stale),
        scratched: Boolean(run.scratched),
        batchTag: run.batchTag,
        batchName: run.batchName,
        solver: formatAgentType(run.taskAgentType),
        evaluator: formatAgentType(run.evalAgentType),
        verdict: run.output?.verdict,
        summary: run.output?.summary,
        error: run.error,
        progress: run.progress,
        currentStep: run.currentStep,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
    };
}

function parseRunWaitNumber(raw: string | undefined, fallback: number, label: string): number {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be a positive number`);
    }
    return value;
}

async function queryRunsWithRetry(client, versionId: string): Promise<AgentRun[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            return normalizeAgentRuns(
                await client.query(api.runAgentRuns.getAgentRuns, { versionId }),
            );
        }
        catch (error) {
            lastError = error;
            if (attempt < 3) {
                process.stderr.write(`\n  Poll failed; retrying (${attempt}/3)...\n`);
                await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
            }
        }
    }
    throw lastError;
}

function isActiveRunStatus(status: unknown): boolean {
    return status === "pending" || status === "running";
}

async function waitForRuns({
    client,
    problemId,
    version,
    jobId,
    runSelector,
    batch,
    includeStale,
    intervalMs,
    timeoutMs,
    json,
    full,
}) {
    const startedAt = Date.now();
    let targetIds: string[] | null = null;

    while (true) {
        const allRuns = await queryRunsWithRetry(client, version._id);
        const selectable = includeStale ? allRuns : allRuns.filter((run) => !run.stale);

        if (targetIds === null) {
            if (jobId) {
                const match = selectable.find((run) => run.jobId === jobId);
                if (!match) throw new Error(`Run job ${jobId} was not found on current v${version.version}`);
                targetIds = [match.id];
            }
            else if (runSelector) {
                const resolved = resolveRunSelector(selectable, runSelector);
                if (resolved.matches) {
                    throw new Error(
                        `Run selector "${runSelector}" is ambiguous: ${resolved.matches.map((run) => run.id).join(", ")}`,
                    );
                }
                if (!resolved.run) throw new Error(`Run "${runSelector}" was not found on current v${version.version}`);
                targetIds = [resolved.run.id];
            }
            else if (batch) {
                targetIds = selectable
                    .filter((run) => run.batchTag === batch || run.batchName === batch)
                    .map((run) => run.id);
                if (targetIds.length === 0) {
                    throw new Error(`Batch "${batch}" was not found on current v${version.version}`);
                }
            }
            else {
                targetIds = selectable
                    .filter((run) => !run.scratched && isActiveRunStatus(run.status))
                    .map((run) => run.id);
                if (targetIds.length === 0) {
                    const result = { status: "idle", version: version.version, runs: [] };
                    if (json) printJson(result);
                    else console.log(`\n  No active current rollouts on v${version.version}.\n`);
                    return result;
                }
            }
        }

        const selected = targetIds.map((id) => {
            const run = allRuns.find((item) => item.id === id);
            if (!run) throw new Error(`Run ${id} disappeared while waiting`);
            return run;
        });
        const active = selected.filter((run) => isActiveRunStatus(run.status));
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

        if (active.length === 0) {
            const summaries = selected.map(summarizeRun);
            const executionFailed = selected.some((run) => run.status === "failed");
            const result: Record<string, unknown> = {
                status: executionFailed ? "failed" : "completed",
                version: version.version,
                elapsedSeconds,
                runs: summaries,
            };
            if (full) {
                result.raw = selected;
                result.criteria = await client.query(api.runAgentRuns.getAgentRunCriteria, {
                    versionId: version._id,
                });
            }
            if (json) printJson(result);
            else {
                process.stderr.write("\r\x1b[2K");
                for (const run of summaries) {
                    const detail = run.verdict ?? run.summary ?? run.error ?? "";
                    console.log(`${statusBadge(run.status)}  ${run.label}${detail ? ` — ${truncate(String(detail), 100)}` : ""}`);
                }
            }
            if (executionFailed) process.exitCode = 1;
            return result;
        }

        if (Date.now() - startedAt >= timeoutMs) {
            const result = {
                status: "timeout",
                version: version.version,
                elapsedSeconds,
                runs: selected.map(summarizeRun),
            };
            if (json) printJson(result);
            else console.error(`\n  Timed out waiting for ${active.length} rollout(s).`);
            process.exitCode = 2;
            return result;
        }

        if (!json) {
            const progress = active
                .map((run) => `${run.id.slice(0, 8)}:${run.progress ?? "?"}%`)
                .join(" ");
            process.stderr.write(`\r  waiting runs=${active.length} elapsed=${elapsedSeconds}s ${progress}`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

const wait = defineCommand({
    meta: { name: "runs wait", description: "Wait for selected current rollout jobs" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        job: { type: "string", description: "Wait for one exact job ID" },
        run: { type: "string", description: "Wait for one run ID, prefix, or exact label" },
        batch: { type: "string", description: "Wait for one exact batch tag or batch name" },
        "include-stale": { type: "boolean", description: "Allow stale runs in explicit selection" },
        interval: { type: "string", description: "Poll interval in seconds (default 10)" },
        timeout: { type: "string", description: "Timeout in minutes (default 120)" },
        full: { type: "boolean", description: "Include raw runs and rollout criteria" },
        json: { type: "boolean", description: "Output one compact JSON document to stdout" },
    },
    run: async ({ args }) => {
        const selectorCount = [args.job, args.run, args.batch].filter(Boolean).length;
        if (selectorCount > 1) {
            throw new Error("Use only one of --job, --run, or --batch");
        }
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        await waitForRuns({
            client,
            problemId: args.id,
            version,
            jobId: args.job,
            runSelector: args.run,
            batch: args.batch,
            includeStale: Boolean(args["include-stale"]),
            intervalMs: parseRunWaitNumber(args.interval, 10, "--interval") * 1000,
            timeoutMs: parseRunWaitNumber(args.timeout, 120, "--timeout") * 60 * 1000,
            json: Boolean(args.json),
            full: Boolean(args.full),
        });
    },
});
async function resolveSelectedRun(
    client: Awaited<ReturnType<typeof getClient>>,
    problemId: string,
    selector: string,
) {
    const { version } = await requireProblemVersion(client, problemId);
    const runs = normalizeAgentRuns(await client.query(api.runAgentRuns.getAgentRuns, {
        versionId: version._id,
    }));
    const resolved = resolveRunSelector(runs, selector);
    if (resolved.matches) {
        throw new Error(
            `Rollout selector "${selector}" is ambiguous: ${resolved.matches.map((item) => item.id).join(", ")}`,
        );
    }
    if (!resolved.run) throw new Error(`Rollout "${selector}" not found on v${version.version}`);
    return { run: resolved.run, version };
}

const cancel = defineCommand({
    meta: { name: "runs cancel", description: "Cancel a pending or running rollout" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        run: { type: "positional", description: "Run ID, prefix, or exact label", required: true },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const selected = await resolveSelectedRun(client, args.id, args.run);
        const result = await client.mutation(api.runAgentRuns.cancelRun, {
            runId: selected.run.id,
        });
        if (args.json) return printJson(result ?? { cancelled: selected.run.id });
        console.log(`\n  Cancelled rollout ${selected.run.id}.\n`);
    },
});

const scratch = defineCommand({
    meta: { name: "runs scratch", description: "Scratch, contest, or restore a rollout" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        run: { type: "positional", description: "Run ID, prefix, or exact label", required: true },
        reason: { type: "string", description: "Optional contest/scratch reason" },
        undo: { type: "boolean", description: "Remove the scratched state" },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const selected = await resolveSelectedRun(client, args.id, args.run);
        const scratched = !args.undo;
        const result = await client.mutation(api.runAgentRuns.scratchRun, {
            runId: selected.run.id,
            scratched,
            ...(scratched && args.reason?.trim() ? { reason: args.reason.trim() } : {}),
        });
        if (args.json) return printJson(result ?? { runId: selected.run.id, scratched });
        console.log(`\n  Rollout ${selected.run.id} ${scratched ? "scratched" : "restored"}.\n`);
    },
});

const reEvaluateView = defineCommand({
    meta: { name: "runs re-evaluate view", description: "View the rollout re-evaluation offer" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const offer = await client.query(api.reEvalRuns.getReEvalOffer, {
            versionId: version._id,
        });
        if (args.json) return printJson(offer);
        console.log(JSON.stringify(offer, null, 2));
    },
});

const reEvaluateRun = defineCommand({
    meta: { name: "runs re-evaluate run", description: "Re-evaluate existing rollout solutions" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        "use-general-tokens": {
            type: "boolean",
            description: "Charge general tokens instead of revision tokens",
        },
        wait: { type: "boolean", description: "Wait for triggered rollouts to finish" },
        interval: { type: "string", description: "Poll interval in seconds (default 10)" },
        timeout: { type: "string", description: "Timeout in minutes (default 120)" },
        full: { type: "boolean", description: "Include raw results when waiting" },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const offer: any = await client.query(api.reEvalRuns.getReEvalOffer, {
            versionId: version._id,
        });
        if (!offer?.eligible) throw new Error("This version is not eligible for rollout re-evaluation");
        const result: any = await client.action(api.reEvalRuns.triggerReEvalRuns, {
            versionId: version._id,
            useGeneralTokens: args["use-general-tokens"] || undefined,
        });
        const batchTag = result?.batchTag;
        if (args.wait) {
            await waitForRuns({
                client,
                problemId: args.id,
                version,
                jobId: undefined,
                runSelector: undefined,
                batch: batchTag,
                includeStale: false,
                intervalMs: parseRunWaitNumber(args.interval, 10, "--interval") * 1000,
                timeoutMs: parseRunWaitNumber(args.timeout, 120, "--timeout") * 60 * 1000,
                json: Boolean(args.json),
                full: Boolean(args.full),
            });
            return;
        }
        const waitCommand = batchTag
            ? `olympus runs wait ${args.id} --batch=${batchTag} --json`
            : `olympus runs wait ${args.id} --json`;
        if (args.json) return printJson({ ...result, waitCommand });
        console.log(`\n  Re-evaluating ${offer.runCount} rollout${offer.runCount === 1 ? "" : "s"}.`);
        console.log(`  \x1b[90mWait: ${waitCommand}\x1b[0m\n`);
    },
});

const reEvaluate = defineCommand({
    meta: { name: "runs re-evaluate", description: "Rollout re-evaluation operations" },
    subCommands: { view: reEvaluateView, run: reEvaluateRun },
});

const artifact = defineCommand({
    meta: { name: "runs artifact", description: "Fetch an artifact from a rollout" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        run: { type: "positional", description: "Run id, id prefix, or exact label", required: true },
        key: { type: "string", description: "Artifact key" },
        head: { type: "string", description: "Return the first N lines" },
        tail: { type: "string", description: "Return the last N lines" },
        contains: { type: "string", description: "Return lines containing text (case-insensitive)" },
        "max-chars": { type: "string", description: "Maximum returned characters (JSON default 12000)" },
        full: { type: "boolean", description: "Return the complete artifact" },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        if (!args.key) {
            console.log("\n  Common rollout artifact keys:");
            for (const key of COMMON_RUN_ARTIFACT_KEYS) {
                console.log(`    - ${key}`);
            }
            console.log("\n  Any artifact key accepted by artifact storage can be passed with `--key`.\n");
            return;
        }
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const runs = normalizeAgentRuns(await client.query(api.runAgentRuns.getAgentRuns, {
            versionId: version._id,
        }));
        const resolved = resolveRunSelector(runs, args.run);
        if ("matches" in resolved && resolved.matches) {
            throw new Error(
                `Rollout selector "${args.run}" is ambiguous: ${resolved.matches.map((item) => item.id).join(", ")}`,
            );
        }
        const run = resolved.run;
        if (!run?.jobId) {
            throw new Error(`Rollout "${args.run}" has no job or artifacts yet`);
        }
        const url = await client.action(api.artifactProxy.fetchArtifact, {
            jobId: run.jobId,
            artifactKey: args.key,
        });
        if (!url) {
            throw new Error(`Artifact "${args.key}" was not found for rollout "${args.run}"`);
        }
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Artifact fetch failed with HTTP ${response.status}`);
        }
        const content = await response.text();
        const sliced = sliceText(content, {
            head: parsePositiveInteger(args.head, undefined, "--head"),
            tail: parsePositiveInteger(args.tail, undefined, "--tail"),
            contains: args.contains,
            maxChars: args.full
                ? undefined
                : parsePositiveInteger(args["max-chars"], args.json ? 12000 : undefined, "--max-chars"),
        });
        const nextCommand = sliced.truncated
            ? `olympus runs artifact ${args.id} ${run.id} --key=${args.key} --full${args.json ? " --json" : ""}`
            : undefined;
        if (args.json) {
            printJson(omitEmpty({
                run: run.id,
                jobId: run.jobId,
                artifact: args.key,
                ...sliced,
                nextCommand,
            }));
            return;
        }
        process.stdout.write(sliced.content);
        if (!sliced.content.endsWith("\n")) process.stdout.write("\n");
        if (sliced.truncated) {
            process.stderr.write(`Artifact truncated: ${sliced.returnedChars}/${sliced.totalChars} chars. Full: ${nextCommand}\n`);
        }
    },
});
export default defineCommand({
    meta: { name: "runs", description: "View and trigger challenge rollouts" },
    subCommands: {
        view,
        show,
        presets,
        run,
        "run-all": runAll,
        wait,
        cancel,
        scratch,
        "re-evaluate": reEvaluate,
        artifact,
    },
});
