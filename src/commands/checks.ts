import { defineCommand } from "citty";
import { api, asId, getClient, requireProblemVersion } from "../convex.ts";
import {
    GATING_CHECK_KEYS,
    NON_GATING_CHECK_KEYS,
    PRECHECK_STAGE_IDS,
    TRIGGERABLE_CHECK_KEYS,
    toBackendCheckKey,
} from "../expected.ts";
import { printJson, statusBadge, truncate } from "../format.ts";
import { omitEmpty, paginate, parsePositiveInteger, sliceText } from "../output.ts";
import { formatDynamicCheckLabel, getDynamicCheckEntries, normalizeDynamicChecks, } from "../model.ts";
/**
 * The production quality-check set, ordered so execution checks run before the
 * review checks that depend on their artifacts.
 *
 * Excludes `autoReview` and `verifierIncompleteness` (later stage / opt-in).
 */
export const DEFAULT_RUN_ALL_CHECK_KEYS = [...GATING_CHECK_KEYS];
const CHECK_ARTIFACTS: Record<string, string[]> = {
    verifyTests: ["buildLog", "testLog"],
    verifySolution: ["buildLog", "testLog"],
    verifyFlakiness: ["buildLog", "testLog"],
};
export const PRECHECK_STAGES = [...PRECHECK_STAGE_IDS];

function includesKey<T extends string>(values: readonly T[], value: string): value is T {
    return values.includes(value as T);
}

function formatCheckVerdict(check) {
    const verdict = check.output?.verdict ??
        check.output?.evaluation?.verdict;
    return verdict ?? null;
}
function formatCheckMessage(check) {
    const message = check.output?.message ??
        check.output?.summary ??
        check.output?.evaluation?.summary;
    return message ?? null;
}
function printPrechecks(stages) {
    const stageList = Array.isArray(stages) ? stages : [];
    if (stageList.length === 0) {
        console.log("  Prechecks:\n    \x1b[90mNo prechecks yet.\x1b[0m");
        return;
    }
    console.log("  Prechecks:");
    for (const stage of stageList) {
        console.log(`    ${statusBadge(stage.status)}  ${stage.stageName ?? stage.stageId}`);
        const checks = Array.isArray(stage.checks) ? stage.checks : [];
        for (const check of checks) {
            const msg = check.message ? `  ${truncate(String(check.message), 70)}` : "";
            console.log(`      ${statusBadge(check.status)}  ${check.name ?? check.key}${msg}`);
        }
    }
}
function printQualityChecks(dynamicChecks) {
    const checks = getDynamicCheckEntries(dynamicChecks);
    if (checks.length === 0) {
        console.log("\n  Quality Checks:\n    \x1b[90mNo quality checks yet.\x1b[0m");
        return;
    }
    console.log("\n  Quality Checks:");
    for (const check of checks) {
        const stale = check.stale ? " \x1b[33m(stale)\x1b[0m" : "";
        const contested = check.contested ? " \x1b[33m(contested)\x1b[0m" : "";
        const verdict = formatCheckVerdict(check);
        const message = formatCheckMessage(check);
        const suffix = `${verdict ? ` [${verdict}]` : ""}${message ? `  ${truncate(message, 70)}` : ""}`;
        console.log(`    ${statusBadge(check.status)}  ${formatDynamicCheckLabel(check.key)} (${check.key})${suffix}${stale}${contested}`);
        if (check.contestNote) {
            console.log(`      \x1b[33mContest: ${truncate(check.contestNote, 90)}\x1b[0m`);
        }
        if (check.error) {
            console.log(`      \x1b[31mError: ${truncate(check.error, 90)}\x1b[0m`);
        }
    }
    const present = new Set(checks.map((check) => check.key));
    const missing = DEFAULT_RUN_ALL_CHECK_KEYS.filter((key) => !present.has(key));
    if (missing.length > 0) {
        console.log("\n    \x1b[90mNot started:\x1b[0m");
        for (const key of missing) {
            console.log(`      \x1b[90m- ${formatDynamicCheckLabel(key)} (${key})\x1b[0m`);
        }
    }
}
function printReadiness(readiness) {
    if (!readiness)
        return;
    console.log("\n  Submission Readiness:");
    for (const criterion of readiness.criteria) {
        const detail = criterion.detail ? `  ${criterion.detail}` : "";
        const stale = criterion.stale ? " \x1b[33m(stale)\x1b[0m" : "";
        console.log(`    ${statusBadge(criterion.status)}  ${criterion.label}${detail}${stale}`);
    }
    if (readiness.bypassNote) {
        console.log(`    \x1b[33mBypass: ${truncate(readiness.bypassNote, 90)}\x1b[0m`);
    }
}
function printNextCommands(problemId) {
    console.log("\n  Commands:");
    console.log(`    olympus problems view ${problemId}            Full challenge detail`);
    console.log(`    olympus problems download ${problemId}        Download the current version locally`);
    console.log(`    olympus checks run-all ${problemId}           Run the default quality-check set`);
    console.log(`    olympus runs view ${problemId}                Rollout batches + criteria`);
}
const view = defineCommand({
    meta: { name: "checks view", description: "View prechecks, quality checks, and readiness" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        check: { type: "string", description: "Return one check key" },
        only: { type: "string", description: "Filter checks: failed, passing, running, stale, actionable" },
        limit: { type: "string", description: "Maximum checks returned (default 20)" },
        offset: { type: "string", description: "Check offset (default 0)" },
        full: { type: "boolean", description: "Include complete raw backend payloads" },
        json: { type: "boolean", description: "Output compact JSON" },
    },
    run: async ({ args }) => {
        if (args.only && !new Set(["failed", "passing", "running", "stale", "actionable"]).has(args.only)) {
            throw new Error("--only must be failed, passing, running, stale, or actionable");
        }
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const [stages, dynamicChecks, readiness] = await Promise.all([
            client.query(api.stages.getByVersion, { versionId: version._id }),
            client.query(api.runDynamicChecks.getDynamicChecks, { versionId: version._id }),
            client.query(api.submissionReadiness.getSubmissionReadiness, {
                problemId: asId(args.id),
            }),
        ]);
        const result = { prechecks: stages, dynamicChecks, readiness, version: version.version };
        if (args.json) {
            if (args.full) {
                printJson(result);
                return;
            }
            const latestStages = new Map<string, any>();
            for (const stage of Array.isArray(stages) ? stages : []) {
                const id = stage.stageId ?? stage.id;
                if (!id) continue;
                const timestamp = stage.completedAt ?? stage.createdAt ?? stage._creationTime ?? 0;
                const previous = latestStages.get(id);
                const previousTimestamp = previous?.completedAt ?? previous?.createdAt ?? previous?._creationTime ?? 0;
                if (!previous || timestamp >= previousTimestamp) latestStages.set(id, stage);
            }
            const prechecks = [...latestStages.values()].map((stage: any) => ({
                id: stage.stageId ?? stage.id,
                name: stage.stageName ?? stage.name,
                status: stage.status,
                stale: Boolean(stage.stale),
                findings: (Array.isArray(stage.checks) ? stage.checks : [])
                    .filter((check: any) => !["PASS", "pass"].includes(check.status))
                    .map((check: any) => ({
                        id: check.key ?? check.id,
                        status: check.status,
                        message: check.message ? truncate(String(check.message), 240) : undefined,
                    })),
            }));
            let checkEntries = getDynamicCheckEntries(dynamicChecks);
            if (args.check) {
                checkEntries = checkEntries.filter((check) => check.key === args.check);
            }
            if (args.only) {
                checkEntries = checkEntries.filter((check) => {
                    const verdict = String(formatCheckVerdict(check) ?? "").toLowerCase();
                    const failed = check.status === "failed" || ["fail", "error", "request_changes"].includes(verdict);
                    const passing = check.status === "completed" && !failed && !check.stale;
                    const running = isActiveStatus(check.status);
                    if (args.only === "failed") return failed;
                    if (args.only === "passing") return passing;
                    if (args.only === "running") return running;
                    if (args.only === "stale") return Boolean(check.stale);
                    return failed || running || Boolean(check.stale);
                });
            }
            const limit = parsePositiveInteger(args.limit, 20, "--limit") ?? 20;
            const offset = args.offset === undefined ? 0 : Number(args.offset);
            if (!Number.isInteger(offset) || offset < 0) throw new Error("--offset must be a non-negative integer");
            const page = paginate(checkEntries.map(summarizeCheck), limit, offset);
            const nextCommand = page.pagination.hasMore
                ? `olympus checks view ${args.id} --json --limit=${limit} --offset=${page.pagination.nextOffset}${args.only ? ` --only=${args.only}` : ""}`
                : undefined;
            printJson(omitEmpty({
                version: version.version,
                prechecks,
                checks: page.items,
                pagination: page.pagination,
                readiness,
                nextCommand,
            }));
            return;
        }
        console.log(`\n  Checks for v${version.version}\n`);
        printPrechecks(stages);
        printQualityChecks(dynamicChecks);
        printReadiness(readiness);
        printNextCommands(args.id);
        console.log("\n  \x1b[90mUse --json for the full check payload.\x1b[0m\n");
    },
});
function isActiveStatus(status: unknown): boolean {
    return status === "pending" || status === "running";
}


const run = defineCommand({
    meta: { name: "checks run", description: "Run one quality check" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        check: {
            type: "string",
            description: `Check key (one of: ${TRIGGERABLE_CHECK_KEYS.join(", ")})`,
            required: false,
        },
        "use-general-tokens": {
            type: "boolean",
            description: "Charge general tokens instead of revision tokens",
        },
        interval: {
            type: "string",
            description: "Check poll interval in seconds (default 5)",
        },
        timeout: {
            type: "string",
            description: "Check wait timeout in minutes (default 30)",
        },
        wait: { type: "boolean", description: "Wait for this check to finish" },
        full: { type: "boolean", description: "Include raw result when waiting" },
        list: { type: "boolean", description: "List available check keys and exit" },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        if (args.list || !args.check) {
            if (!args.list) {
                console.error("\n  Missing --check.");
            }
            console.log("\n  Available check keys:");
            for (const key of TRIGGERABLE_CHECK_KEYS) {
                const inDefault = includesKey(DEFAULT_RUN_ALL_CHECK_KEYS, key);
                const tag = inDefault ? "" : "  \x1b[90m(not in run-all)\x1b[0m";
                console.log(`    ${key.padEnd(24)} ${formatDynamicCheckLabel(key)}${tag}`);
            }
            console.log("\n  \x1b[90mOptional/later-stage checks:\x1b[0m");
            for (const key of NON_GATING_CHECK_KEYS) {
                console.log(`    \x1b[90m${key.padEnd(24)} ${formatDynamicCheckLabel(key)}\x1b[0m`);
            }
            console.log("");
            if (!args.list)
                process.exit(1);
            return;
        }
        const checkKey = args.check;
        if (includesKey(NON_GATING_CHECK_KEYS, checkKey)) {
            const command = checkKey === "autoReview"
                ? "olympus auto-review run"
                : "olympus verifier-audit run";
            throw new Error(`${checkKey} must be run through: ${command} ${args.id}`);
        }
        if (!includesKey(TRIGGERABLE_CHECK_KEYS, checkKey)) {
            throw new Error(
                `Unknown check key: ${args.check}. Known keys: ${TRIGGERABLE_CHECK_KEYS.join(", ")}`,
            );
        }
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const result: any = await client.action(api.runDynamicChecks.triggerDynamicCheck, {
            versionId: version._id,
            checkKey: toBackendCheckKey(checkKey),
            useGeneralTokens: Boolean(args["use-general-tokens"]),
        });
        if (args.wait) {
            await waitForChecks({
                client,
                problemId: args.id,
                version,
                jobId: result?.jobId,
                requestedKeys: result?.jobId ? undefined : [checkKey],
                intervalMs: parseWaitNumber(args.interval, 5, "--interval") * 1000,
                timeoutMs: parseWaitNumber(args.timeout, 30, "--timeout") * 60 * 1000,
                json: Boolean(args.json),
                full: Boolean(args.full),
            });
            return;
        }
        const waitCommand = result?.jobId
            ? `olympus checks wait ${args.id} --job=${result.jobId} --json`
            : `olympus checks wait ${args.id} --check=${checkKey} --json`;
        if (args.json) {
            printJson({ ...result, waitCommand });
            return;
        }
        console.log(`\n  Triggered ${checkKey} on v${version.version}`);
        console.log(`  \x1b[90mWait: ${waitCommand}\x1b[0m\n`);
    },
});
const runAll = defineCommand({
    meta: { name: "checks run-all", description: "Run the default production quality-check set" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        checks: {
            type: "string",
            description: "Comma-separated check keys (default: the production set)",
        },
        "use-general-tokens": {
            type: "boolean",
            description: "Charge general tokens instead of revision tokens",
        },
        wait: { type: "boolean", description: "Wait for all triggered checks to finish" },
        interval: { type: "string", description: "Poll interval in seconds (default 5)" },
        timeout: { type: "string", description: "Timeout in minutes (default 30)" },
        full: { type: "boolean", description: "Include raw results when waiting" },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        let checkKeys: string[] = [...DEFAULT_RUN_ALL_CHECK_KEYS];
        if (args.checks) {
            const requested = args.checks
                .split(",")
                .map((key) => key.trim())
                .filter(Boolean);
            const unknown = requested.filter((key) =>
                !includesKey(TRIGGERABLE_CHECK_KEYS, key));
            if (unknown.length > 0) {
                throw new Error(
                    `Unknown check key(s): ${unknown.join(", ")}. Known keys: ${TRIGGERABLE_CHECK_KEYS.join(", ")}`,
                );
            }
            const special = requested.filter((key) => includesKey(NON_GATING_CHECK_KEYS, key));
            if (special.length > 0) {
                throw new Error(
                    `Later-stage checks require dedicated commands: ${special.join(", ")}`,
                );
            }
            if (requested.length === 0) {
                console.error("\n  --checks was empty.\n");
                process.exit(1);
            }
            checkKeys = requested;
        }
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const result: any = await client.action(api.runDynamicChecks.triggerAllDynamicChecks, {
            versionId: version._id,
            checkKeys: checkKeys.map(toBackendCheckKey),
            useGeneralTokens: args["use-general-tokens"],
        });
        if (args.wait) {
            await waitForChecks({
                client,
                problemId: args.id,
                version,
                jobId: undefined,
                requestedKeys: checkKeys,
                intervalMs: parseWaitNumber(args.interval, 5, "--interval") * 1000,
                timeoutMs: parseWaitNumber(args.timeout, 30, "--timeout") * 60 * 1000,
                json: Boolean(args.json),
                full: Boolean(args.full),
            });
            return;
        }
        const waitCommand = `olympus checks wait ${args.id} --checks=${checkKeys.join(",")} --json`;
        if (args.json) {
            printJson({ result, checkKeys, waitCommand });
            return;
        }
        console.log(`\n  Triggered ${checkKeys.length} quality checks on v${version.version}`);
        for (const key of checkKeys) {
            console.log(`    - ${formatDynamicCheckLabel(key)} (${key})`);
        }
        console.log(`  \x1b[90mWait: ${waitCommand}\x1b[0m\n`);
    },
});
type CheckWaitSummary = {
    key: string;
    label: string;
    jobId?: string;
    status: string;
    stale: boolean;
    progress?: number;
    currentStep?: string;
    verdict?: unknown;
    message?: unknown;
    error?: string;
    createdAt?: number;
    completedAt?: number;
};

function summarizeCheck(check): CheckWaitSummary {
    return {
        key: check.key,
        label: formatDynamicCheckLabel(check.key),
        jobId: check.jobId,
        status: check.status,
        stale: Boolean(check.stale),
        progress: check.progress,
        currentStep: check.currentStep,
        verdict: formatCheckVerdict(check) ?? undefined,
        message: formatCheckMessage(check) ?? undefined,
        error: check.error,
        createdAt: check.createdAt,
        completedAt: check.completedAt,
    };
}

export function parseWaitNumber(raw: string | undefined, fallback: number, label: string): number {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be a positive number`);
    }
    return value;
}

async function queryDynamicChecksWithRetry(client, versionId: string) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            return await client.query(api.runDynamicChecks.getDynamicChecks, { versionId });
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

export async function waitForChecks({
    client,
    problemId,
    version,
    jobId,
    requestedKeys,
    intervalMs,
    timeoutMs,
    json,
    full,
}) {
    const startedAt = Date.now();
    let targetKeys: string[] | null = requestedKeys?.length ? requestedKeys : null;
    let expectedJobId: string | undefined = jobId;

    while (true) {
        const dynamicChecks = await queryDynamicChecksWithRetry(client, version._id);
        const entries = getDynamicCheckEntries(dynamicChecks);

        if (targetKeys === null) {
            if (expectedJobId) {
                const match = entries.find((check) => check.jobId === expectedJobId);
                if (!match) throw new Error(`Check job ${expectedJobId} is not current on v${version.version}`);
                targetKeys = [match.key];
            }
            else {
                targetKeys = entries
                    .filter((check) => !check.stale && isActiveStatus(check.status))
                    .map((check) => check.key);
                if (targetKeys.length === 0) {
                    const result = { status: "idle", version: version.version, checks: [] };
                    if (json) printJson(result);
                    else console.log(`\n  No active current checks on v${version.version}.\n`);
                    return result;
                }
            }
        }

        const selected = targetKeys.map((key) => {
            const check = entries.find((entry) => entry.key === key);
            if (!check) throw new Error(`Check ${key} has not been started on v${version.version}`);
            if (expectedJobId && check.jobId !== expectedJobId) {
                throw new Error(`Check ${key} was replaced by job ${check.jobId ?? "unknown"}`);
            }
            return check;
        });
        const active = selected.filter((check) => isActiveStatus(check.status));
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

        if (active.length === 0) {
            const summaries = selected.map(summarizeCheck);
            const executionFailed = selected.some((check) => check.status === "failed");
            const result: Record<string, unknown> = {
                status: executionFailed ? "failed" : "completed",
                version: version.version,
                elapsedSeconds,
                checks: summaries,
            };
            if (full) {
                result.raw = Object.fromEntries(selected.map((check) => [check.key, check]));
                result.readiness = await client.query(
                    api.submissionReadiness.getSubmissionReadiness,
                    { problemId: asId(problemId) },
                );
            }
            if (json) printJson(result);
            else {
                process.stderr.write("\r\x1b[2K");
                for (const check of summaries) {
                    const detail = check.verdict ?? check.message ?? check.error ?? "";
                    console.log(`${statusBadge(check.status)}  ${check.label}${detail ? ` — ${truncate(String(detail), 100)}` : ""}`);
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
                checks: selected.map(summarizeCheck),
            };
            if (json) printJson(result);
            else console.error(`\n  Timed out waiting for ${active.length} check(s).`);
            process.exitCode = 2;
            return result;
        }

        if (!json) {
            const progress = active
                .map((check) => `${check.key}:${check.progress ?? "?"}%`)
                .join(" ");
            process.stderr.write(`\r  waiting checks=${active.length} elapsed=${elapsedSeconds}s ${progress}`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

const wait = defineCommand({
    meta: { name: "checks wait", description: "Wait for current quality-check jobs" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        job: { type: "string", description: "Wait for one exact job ID" },
        check: { type: "string", description: "Wait for the current result of one check key" },
        checks: { type: "string", description: "Comma-separated current check keys" },
        interval: { type: "string", description: "Poll interval in seconds (default 5)" },
        timeout: { type: "string", description: "Timeout in minutes (default 30)" },
        full: { type: "boolean", description: "Include raw payloads and readiness" },
        json: { type: "boolean", description: "Output one compact JSON document to stdout" },
    },
    run: async ({ args }) => {
        if (args.job && (args.check || args.checks)) {
            throw new Error("Use only one of --job, --check, or --checks");
        }
        if (args.check && args.checks) {
            throw new Error("Use only one of --check or --checks");
        }
        const requestedKeys = args.check
            ? [args.check]
            : args.checks
                ? args.checks.split(",").map((key) => key.trim()).filter(Boolean)
                : undefined;
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        await waitForChecks({
            client,
            problemId: args.id,
            version,
            jobId: args.job,
            requestedKeys,
            intervalMs: parseWaitNumber(args.interval, 5, "--interval") * 1000,
            timeoutMs: parseWaitNumber(args.timeout, 30, "--timeout") * 60 * 1000,
            json: Boolean(args.json),
            full: Boolean(args.full),
        });
    },
});
function extractCheckFindings(output: Record<string, any> | undefined) {
    if (!output) return [];
    const sources: Array<[string, unknown]> = [
        ["issues", output.issues],
        ["evaluation.issues", output.evaluation?.issues],
        ["comments", output.comments],
        ["evaluation.comments", output.evaluation?.comments],
        ["suggestions", output.suggestions],
        ["evaluation.suggestions", output.evaluation?.suggestions],
        ["gaps", output.gaps],
        ["evaluation.gaps", output.evaluation?.gaps],
    ];
    const findings: Array<{ index: number; source: string; value: any }> = [];
    for (const [source, value] of sources) {
        if (!Array.isArray(value)) continue;
        for (const item of value) findings.push({ index: findings.length + 1, source, value: item });
    }
    return findings;
}

function summarizeFinding(finding: { index: number; source: string; value: any }) {
    const value = finding.value ?? {};
    return omitEmpty({
        index: finding.index,
        source: finding.source,
        severity: value.severity ?? value.priority ?? value.level,
        title: value.title ?? value.claim ?? value.area ?? value.category,
        summary: truncate(String(
            value.summary ?? value.detail ?? value.description ?? value.suggestion ??
            value.comment ?? value.message ?? value.reasoning ?? "",
        ), 320),
    });
}

const show = defineCommand({
    meta: { name: "checks show", description: "Show one current quality check" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        check: { type: "positional", description: "Check key", required: true },
        full: { type: "boolean", description: "Include the complete raw check payload" },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const dynamic = await client.query(api.runDynamicChecks.getDynamicChecks, {
            versionId: version._id,
        });
        const checkKey = args.check;
        const check = getDynamicCheckEntries(dynamic).find((entry) => entry.key === checkKey);
        if (!check) throw new Error(`Check ${checkKey} has not been started on v${version.version}`);
        if (args.full) {
            if (args.json) return printJson(check);
            return console.log(JSON.stringify(check, null, 2));
        }
        const findings = extractCheckFindings(check.output);
        const result = omitEmpty({
            version: version.version,
            check: summarizeCheck(check),
            findingCount: findings.length,
            findings: findings.map(summarizeFinding),
            nextCommand: findings.length
                ? `olympus checks finding ${args.id} ${checkKey} 1 --json`
                : undefined,
            fullCommand: `olympus checks show ${args.id} ${checkKey} --full --json`,
        });
        if (args.json) return printJson(result);
        console.log(JSON.stringify(result, null, 2));
    },
});

const finding = defineCommand({
    meta: { name: "checks finding", description: "Show one finding from a current quality check" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        check: { type: "positional", description: "Check key", required: true },
        finding: { type: "positional", description: "One-based finding index", required: true },
        "max-chars": { type: "string", description: "Maximum serialized finding characters" },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const index = Number(args.finding);
        if (!Number.isInteger(index) || index < 1) throw new Error("Finding index must be a positive integer");
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const dynamic = await client.query(api.runDynamicChecks.getDynamicChecks, {
            versionId: version._id,
        });
        const checkKey = args.check;
        const check = getDynamicCheckEntries(dynamic).find((entry) => entry.key === checkKey);
        if (!check) throw new Error(`Check ${checkKey} has not been started on v${version.version}`);
        const findings = extractCheckFindings(check.output);
        const selected = findings[index - 1];
        if (!selected) throw new Error(`Finding ${index} does not exist; available: ${findings.length}`);
        const maxChars = parsePositiveInteger(args["max-chars"], undefined, "--max-chars");
        const serialized = JSON.stringify(selected.value, null, 2);
        const sliced = sliceText(serialized, { maxChars });
        const result = sliced.truncated
            ? {
                version: version.version,
                check: checkKey,
                finding: index,
                source: selected.source,
                preview: sliced.content,
                truncation: {
                    totalChars: sliced.totalChars,
                    returnedChars: sliced.returnedChars,
                    omittedChars: sliced.omittedChars,
                },
                fullCommand: `olympus checks finding ${args.id} ${checkKey} ${index} --json`,
            }
            : {
                version: version.version,
                check: checkKey,
                finding: index,
                source: selected.source,
                detail: omitEmpty(selected.value),
            };
        if (args.json) return printJson(result);
        console.log(sliced.content);
    },
});

const artifact = defineCommand({
    meta: { name: "checks artifact", description: "Fetch an artifact from a quality check" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        check: { type: "positional", description: "Check key", required: true },
        key: { type: "string", description: "Artifact key" },
        head: { type: "string", description: "Return the first N lines" },
        tail: { type: "string", description: "Return the last N lines" },
        contains: { type: "string", description: "Return lines containing text (case-insensitive)" },
        "max-chars": { type: "string", description: "Maximum returned characters (JSON default 12000)" },
        full: { type: "boolean", description: "Return the complete artifact" },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const checkKey = args.check;
        const backendCheckKey = toBackendCheckKey(checkKey);
        const artifactKey = args.key;
        if (!artifactKey) {
            const available = CHECK_ARTIFACTS[checkKey];
            if (!available) {
                console.log(`\n  No curated artifact list for ${checkKey}.`);
                console.log("  Pass `--key <artifact-key>` if you already know the artifact name.\n");
                return;
            }
            console.log(`\n  Available artifacts for ${checkKey}:`);
            for (const key of available) {
                console.log(`    - ${key}`);
            }
            console.log(`\n  Usage: olympus checks artifact ${args.id} ${checkKey} --key <artifact-key>\n`);
            return;
        }
        const available = CHECK_ARTIFACTS[checkKey];
        if (available && !available.includes(artifactKey)) {
            throw new Error(
                `Artifact "${artifactKey}" is not available for check "${checkKey}"; available: ${available.join(", ")}`,
            );
        }
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const dynamicChecks = normalizeDynamicChecks(await client.query(api.runDynamicChecks.getDynamicChecks, {
            versionId: version._id,
        }));
        const check = dynamicChecks[backendCheckKey];
        if (!check?.jobId) {
            throw new Error(`Check "${checkKey}" has no job or artifacts yet`);
        }
        const url = await client.action(api.artifactProxy.fetchArtifact, {
            jobId: check.jobId,
            artifactKey,
        });
        if (!url) {
            throw new Error(`Artifact "${artifactKey}" was not found for check "${checkKey}"`);
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
            ? `olympus checks artifact ${args.id} ${checkKey} --key=${artifactKey} --full${args.json ? " --json" : ""}`
            : undefined;
        if (args.json) {
            printJson(omitEmpty({
                check: checkKey,
                jobId: check.jobId,
                artifact: artifactKey,
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
function readStageInput(problem, version) {
    return {
        title: problem.title ?? version.title,
        description: version.description,
        githubRepoUrl: version.githubRepoUrl ?? problem.githubRepoUrl,
        githubCommitHash: version.githubCommitHash ?? problem.githubCommitHash,
        testPatch: version.testPatch,
        solutionPatch: version.solutionPatch,
        dockerfile: version.dockerfile,
        category: version.category ?? problem.category,
        language: version.language ?? problem.language,
        difficulty: version.difficulty ?? problem.difficulty,
    };
}
const runPrechecks = defineCommand({
    meta: { name: "checks run-prechecks", description: "Run all prechecks" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const { problem, version } = await requireProblemVersion(client, args.id);
        const result = await client.action(api.contributorTokens.runAllChecksWithToken, {
            problemId: asId(args.id),
            versionId: version._id,
            input: readStageInput(problem, version),
            stageIds: PRECHECK_STAGES,
        });
        if (args.json) {
            printJson(result);
            return;
        }
        console.log(`\n  Triggered ${PRECHECK_STAGES.length} precheck stages on v${version.version}`);
        console.log("  \x1b[90mUse `olympus checks view <id>` to inspect stage results.\x1b[0m\n");
    },
});
export default defineCommand({
    meta: { name: "checks", description: "Prechecks, quality checks, and readiness" },
    subCommands: { view, show, finding, run, "run-all": runAll, wait, artifact, "run-prechecks": runPrechecks },
});
