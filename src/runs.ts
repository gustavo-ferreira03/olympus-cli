import { defineCommand } from "citty";
import { api, getClient, requireProblemVersion } from "./convex.ts";
import { printJson, printKeyValue, printTable, statusBadge, truncate } from "./format.ts";
import { formatAgentType, formatRunLabel, groupRunsByBatch, normalizeAgentRuns, parseAgentTypeInput, resolveRunSelector, summarizeStatuses, } from "./model.ts";
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
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const [runs, criteria] = await Promise.all([
            client.query(api.runAgentRuns.getAgentRuns, { versionId: version._id }),
            client.query(api.runAgentRuns.getAgentRunCriteria, { versionId: version._id }),
        ]);
        if (args.json) {
            printJson({ runs, criteria, version: version.version });
            return;
        }
        const normalizedRuns = normalizeAgentRuns(runs);
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
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const runs = normalizeAgentRuns(await client.query(api.runAgentRuns.getAgentRuns, {
            versionId: version._id,
        }));
        const resolved = resolveRunSelector(runs, args.run);
        if ("matches" in resolved && resolved.matches) {
            console.error(`  Rollout selector "${args.run}" is ambiguous.`);
            for (const run of resolved.matches) {
                console.error(`    ${run.id}  ${formatRunLabel(run)}`);
            }
            process.exit(1);
        }
        const run = resolved.run;
        if (!run) {
            console.error(`  Rollout "${args.run}" not found on v${version.version}`);
            process.exit(1);
        }
        const job = run.jobId ? await client.query(api.jobs.get, { id: run.jobId }) : null;
        const output = job?.output ?? run.output ?? {};
        const detail = { ...run, job };
        if (args.json) {
            printJson(detail);
            return;
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
        if (args.json) {
            printJson({ result, triggered: configs });
            return;
        }
        console.log(`\n  Triggered ${configs.length} rollout${configs.length === 1 ? "" : "s"} on v${version.version}`);
        for (const summary of summarizeConfigMix(configs)) {
            console.log(`    ${summary}`);
        }
        console.log("  \x1b[90mUse `olympus runs wait <id>` to watch active rollouts.\x1b[0m\n");
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
        if (args.json) {
            printJson({ result, triggered: configs, preset: "full" });
            return;
        }
        console.log(`\n  Triggered preset full (${configs.length} runs) on v${version.version}`);
        for (const summary of summarizeConfigMix(configs)) {
            console.log(`    ${summary}`);
        }
        console.log("  \x1b[90mThis is an alias for `olympus runs run <id> --preset full`.\x1b[0m\n");
    },
});
const wait = defineCommand({
    meta: { name: "runs wait", description: "Wait for active rollouts to finish" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        interval: { type: "string", description: "Poll interval in seconds (default 30)" },
        timeout: { type: "string", description: "Timeout in minutes (default 120)" },
        json: { type: "boolean", description: "Output final result as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const intervalMs = parseCount(args.interval, 30) * 1000;
        const timeoutMs = parseCount(args.timeout, 120) * 60 * 1000;
        const start = Date.now();
        const { version } = await requireProblemVersion(client, args.id);
        console.log(`  Waiting for active rollouts on v${version.version}...`);
        while (Date.now() - start < timeoutMs) {
            const runs = normalizeAgentRuns(await client.query(api.runAgentRuns.getAgentRuns, { versionId: version._id }));
            const activeRuns = runs.filter((run) => run.status === "pending" || run.status === "running");
            if (runs.length === 0) {
                console.log("\n  No rollouts have been triggered on this version.\n");
                process.exit(1);
            }
            const completed = runs.filter((run) => run.status === "completed").length;
            const failed = runs.filter((run) => run.status === "failed").length;
            const elapsed = Math.round((Date.now() - start) / 1000);
            const mins = Math.floor(elapsed / 60);
            const secs = elapsed % 60;
            process.stdout.write(`\r  ${completed} completed, ${failed} failed, ${activeRuns.length} active (${mins}m${secs}s)`);
            if (activeRuns.length === 0) {
                console.log("");
                const criteria = await client.query(api.runAgentRuns.getAgentRunCriteria, {
                    versionId: version._id,
                });
                if (args.json) {
                    printJson({ runs, criteria, version: version.version });
                }
                else {
                    printRunGroups(runs);
                    printCriteria(criteria);
                    console.log("");
                }
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        console.log("\n  Timed out waiting for rollouts.\n");
        process.exit(1);
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
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const offer: any = await client.query(api.reEvalRuns.getReEvalOffer, {
            versionId: version._id,
        });
        if (!offer?.eligible) throw new Error("This version is not eligible for rollout re-evaluation");
        const result = await client.action(api.reEvalRuns.triggerReEvalRuns, {
            versionId: version._id,
            useGeneralTokens: args["use-general-tokens"] || undefined,
        });
        if (args.json) return printJson(result);
        console.log(`\n  Re-evaluating ${offer.runCount} rollout${offer.runCount === 1 ? "" : "s"}.\n`);
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
            console.error(`  Rollout selector "${args.run}" is ambiguous.`);
            for (const run of resolved.matches) {
                console.error(`    ${run.id}  ${formatRunLabel(run)}`);
            }
            process.exit(1);
        }
        const run = resolved.run;
        if (!run?.jobId) {
            console.error(`  Rollout "${args.run}" has no job/artifacts yet.`);
            process.exit(1);
        }
        const url = await client.action(api.artifactProxy.fetchArtifact, {
            jobId: run.jobId,
            artifactKey: args.key,
        });
        if (!url) {
            console.error(`  Artifact "${args.key}" not found for rollout "${args.run}".`);
            process.exit(1);
        }
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`  Failed to fetch artifact: ${response.status}`);
            process.exit(1);
        }
        const content = await response.text();
        if (args.json) {
            printJson({ run: run.id, artifact: args.key, content });
            return;
        }
        process.stdout.write(content);
        if (!content.endsWith("\n"))
            process.stdout.write("\n");
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
