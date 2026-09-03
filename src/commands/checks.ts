import { defineCommand } from "citty";
import { api, asId, getClient, requireProblemVersion } from "../convex.ts";
import {
    GATING_CHECK_KEYS,
    NON_GATING_CHECK_KEYS,
    PRECHECK_STAGE_IDS,
    RETIRED_CHECK_KEYS,
    TRIGGERABLE_CHECK_KEYS,
} from "../expected.ts";
import { printJson, statusBadge, truncate } from "../format.ts";
import { formatDynamicCheckLabel, getDynamicCheckEntries, normalizeDynamicChecks, } from "../model.ts";
/**
 * The production quality-check set, ordered so execution checks run before the
 * review checks that depend on their artifacts.
 *
 * Excludes `autoReview` and `verifierIncompleteness` (later stage / opt-in) and
 * every retired key: the backend rejects a retired key and that aborts the batch.
 */
export const DEFAULT_RUN_ALL_CHECK_KEYS = [...GATING_CHECK_KEYS];
const CHECK_ARTIFACTS: Record<string, string[]> = {
    verifyBuild: ["buildLog"],
    verifyTests: ["buildLog", "testLog"],
    verifySolution: ["buildLog", "testLog"],
    verifyFlakiness: ["buildLog", "testLog"],
};
export const PRECHECK_STAGES = [...PRECHECK_STAGE_IDS];

function includesKey<T extends string>(values: readonly T[], value: string): value is T {
    return values.includes(value as T);
}

/** Reject retired keys before spending an RPC. */
function rejectUnavailable(keys: readonly string[]) {
    const retired = keys.filter((key) => includesKey(RETIRED_CHECK_KEYS, key));
    if (retired.length > 0) {
        console.error(`\n  Retired check key(s): ${retired.join(", ")}`);
        console.error("  These no longer exist on the platform; the backend rejects them.");
        console.error("  They are still labelled when reading stored results on old versions.\n");
        process.exit(1);
    }
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
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
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
            printJson(result);
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
const run = defineCommand({
    meta: { name: "checks run", description: "Run one quality check" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        check: {
            type: "string",
            description: `Check key (one of: ${TRIGGERABLE_CHECK_KEYS.join(", ")})`,
            required: false,
        },
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
            console.log("\n  \x1b[90mRetired (read-only, cannot be triggered):\x1b[0m");
            for (const key of RETIRED_CHECK_KEYS) {
                console.log(`    \x1b[90m${key.padEnd(24)} ${formatDynamicCheckLabel(key)}\x1b[0m`);
            }
            console.log("");
            if (!args.list)
                process.exit(1);
            return;
        }
        rejectUnavailable([args.check]);
        if (includesKey(NON_GATING_CHECK_KEYS, args.check)) {
            const command = args.check === "autoReview"
                ? "olympus auto-review run"
                : "olympus verifier-audit run";
            throw new Error(`${args.check} must be run through: ${command} ${args.id}`);
        }
        if (!includesKey(TRIGGERABLE_CHECK_KEYS, args.check)) {
            console.error(`\n  Unknown check key: ${args.check}`);
            console.error(`  Known keys: ${TRIGGERABLE_CHECK_KEYS.join(", ")}`);
            console.error("  Run `olympus checks run <id> --list` to see labels.\n");
            process.exit(1);
        }
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const result = await client.action(api.runDynamicChecks.triggerDynamicCheck, {
            versionId: version._id,
            checkKey: args.check,
        });
        if (args.json) {
            printJson(result);
            return;
        }
        console.log(`\n  Triggered ${args.check} on v${version.version}`);
        console.log("  \x1b[90mUse `olympus checks wait <id>` to watch active checks.\x1b[0m\n");
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
                !includesKey(TRIGGERABLE_CHECK_KEYS, key) &&
                !includesKey(RETIRED_CHECK_KEYS, key));
            if (unknown.length > 0) {
                console.error(`\n  Unknown check key(s): ${unknown.join(", ")}`);
                console.error(`  Known keys: ${TRIGGERABLE_CHECK_KEYS.join(", ")}\n`);
                process.exit(1);
            }
            rejectUnavailable(requested);
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
        const result = await client.action(api.runDynamicChecks.triggerAllDynamicChecks, {
            versionId: version._id,
            checkKeys,
            useGeneralTokens: args["use-general-tokens"],
        });
        if (args.json) {
            printJson({ result, checkKeys });
            return;
        }
        console.log(`\n  Triggered ${checkKeys.length} quality checks on v${version.version}`);
        for (const key of checkKeys) {
            console.log(`    - ${formatDynamicCheckLabel(key)} (${key})`);
        }
        console.log("  \x1b[90mUse `olympus checks wait <id>` to watch active checks.\x1b[0m\n");
    },
});
const wait = defineCommand({
    meta: { name: "checks wait", description: "Wait for active quality checks to finish" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        interval: { type: "string", description: "Poll interval in seconds (default 10)" },
        timeout: { type: "string", description: "Timeout in minutes (default 30)" },
        json: { type: "boolean", description: "Output final result as JSON" },
    },
    run: async ({ args }) => {
        const client = await getClient();
        const intervalMs = (Number.parseInt(args.interval ?? "", 10) || 10) * 1000;
        const timeoutMs = (Number.parseInt(args.timeout ?? "", 10) || 30) * 60 * 1000;
        const startedAt = Date.now();
        const { version } = await requireProblemVersion(client, args.id);
        console.log(`  Waiting for active checks on v${version.version}...`);
        while (Date.now() - startedAt < timeoutMs) {
            const dynamicChecks = await client.query(api.runDynamicChecks.getDynamicChecks, {
                versionId: version._id,
            });
            const checks = getDynamicCheckEntries(dynamicChecks);
            const active = checks.filter((check) => check.status === "pending" || check.status === "running");
            const terminal = checks.filter((check) => check.status === "completed" || check.status === "failed");
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            process.stdout.write(`\r  ${terminal.length} complete, ${active.length} active, ${checks.length} total (${elapsed}s)`);
            if (checks.length === 0) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
                continue;
            }
            if (active.length === 0) {
                console.log("");
                const readiness = await client.query(api.submissionReadiness.getSubmissionReadiness, {
                    problemId: asId(args.id),
                });
                if (args.json) {
                    printJson({ dynamicChecks, readiness, version: version.version });
                }
                else {
                    console.log("");
                    printQualityChecks(dynamicChecks);
                    printReadiness(readiness);
                    printNextCommands(args.id);
                    console.log("");
                }
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        console.log("\n  Timed out waiting for quality checks.\n");
        process.exit(1);
    },
});
const artifact = defineCommand({
    meta: { name: "checks artifact", description: "Fetch an artifact from a quality check" },
    args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        check: { type: "positional", description: "Check key", required: true },
        key: { type: "string", description: "Artifact key" },
        json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
        const checkKey = args.check;
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
            console.error(`  Artifact "${artifactKey}" not available for check "${checkKey}".`);
            console.error(`  Available: ${available.join(", ")}`);
            process.exit(1);
        }
        const client = await getClient();
        const { version } = await requireProblemVersion(client, args.id);
        const dynamicChecks = normalizeDynamicChecks(await client.query(api.runDynamicChecks.getDynamicChecks, {
            versionId: version._id,
        }));
        const check = dynamicChecks[checkKey];
        if (!check?.jobId) {
            console.error(`  Check "${checkKey}" has no job/artifacts yet.`);
            process.exit(1);
        }
        const url = await client.action(api.artifactProxy.fetchArtifact, {
            jobId: check.jobId,
            artifactKey,
        });
        if (!url) {
            console.error(`  Artifact "${artifactKey}" not found for check "${checkKey}".`);
            process.exit(1);
        }
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`  Failed to fetch artifact: ${response.status}`);
            process.exit(1);
        }
        const content = await response.text();
        if (args.json) {
            printJson({ check: checkKey, artifact: artifactKey, content });
            return;
        }
        process.stdout.write(content);
        if (!content.endsWith("\n"))
            process.stdout.write("\n");
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
    subCommands: { view, run, "run-all": runAll, wait, artifact, "run-prechecks": runPrechecks },
});
