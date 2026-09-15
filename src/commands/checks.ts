import { CliError } from "../shared/errors.ts";
import { enrichCheckResults } from "../core/check-inputs.ts";
import { defineCommand } from "citty";
import {
  assertCheckCapacity,
  assertCheckSelection,
  assertPaidEndpoint,
  assertTokenPolicy,
} from "../core/policy.ts";
import {
  api,
  asId,
  getClient,
  parseVersionNumber,
  requireProblemVersion,
  resolveProblemVersion,
} from "../platform/convex.ts";
import {
  GATING_CHECK_KEYS,
  NON_GATING_CHECK_KEYS,
  PRECHECK_STAGE_IDS,
  TRIGGERABLE_CHECK_KEYS,
  toBackendCheckKey,
  toPublicCheckKey,
} from "../core/expected.ts";
import { printJson, statusBadge, truncate } from "../terminal/format.ts";
import { omitEmpty, paginate, parsePositiveInteger, sliceText } from "../terminal/output.ts";
import {
  formatDynamicCheckLabel,
  getDynamicCheckEntries,
  normalizeDynamicChecks,
} from "../core/model.ts";
import { type SubmissionReadiness } from "../core/model.ts";
import { type Client, type Problem, type ProblemVersion } from "../shared/types.ts";
import { parseWaitNumber, resolveWaitWindow, waitWindow } from "../shared/wait.ts";
import { printArtifact } from "../core/artifacts.ts";
import {
  CHECK_WAIT_DEFAULTS,
  formatCheckMessage,
  formatCheckVerdict,
  isActiveStatus,
  summarizeCheck,
  waitForChecks,
} from "../core/check-wait.ts";

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

function printPrechecks(stages: unknown): void {
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
function printQualityChecks(dynamicChecks: unknown): void {
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
    console.log(
      `    ${statusBadge(check.status)}  ${formatDynamicCheckLabel(check.key)} (${check.key})${suffix}${stale}${contested}`,
    );
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
function printReadiness(readiness: SubmissionReadiness | null | undefined): void {
  if (!readiness) return;
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
function printNextCommands(problemId: string): void {
  console.log("\n  Commands:");
  console.log(`    olympus problems view ${problemId}            Full challenge detail`);
  console.log(
    `    olympus problems download ${problemId}        Download the current version locally`,
  );
  console.log(
    `    olympus checks run-all ${problemId}           Run the default quality-check set`,
  );
  console.log(`    olympus runs view ${problemId}                Rollout batches + criteria`);
}
const view = defineCommand({
  meta: {
    name: "checks view",
    description: "View prechecks, quality checks, and readiness",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    check: { type: "string", description: "Return one check key" },
    only: {
      type: "string",
      description: "Filter checks: failed, passing, running, stale, actionable",
    },
    limit: {
      type: "string",
      description: "Maximum checks returned (default 20)",
    },
    offset: { type: "string", description: "Check offset (default 0)" },
    full: {
      type: "boolean",
      description: "Include complete raw backend payloads",
    },
    json: { type: "boolean", description: "Output compact JSON" },
  },
  run: async ({ args }) => {
    if (
      args.only
      && !new Set(["failed", "passing", "running", "stale", "actionable"]).has(args.only)
    ) {
      throw new Error("--only must be failed, passing, running, stale, or actionable");
    }
    const client = await getClient();
    const { version } = await requireProblemVersion(client, args.id);
    const [stages, rawDynamicChecks, readiness] = await Promise.all([
      client.query(api.stages.getByVersion, { versionId: version._id }),
      client.query(api.runDynamicChecks.getDynamicChecks, {
        versionId: version._id,
      }),
      client.query(api.submissionReadiness.getSubmissionReadiness, {
        problemId: asId(args.id),
      }),
    ]);
    const dynamicChecks = enrichCheckResults(rawDynamicChecks, version);
    const result = {
      prechecks: stages,
      dynamicChecks,
      readiness,
      version: version.version,
    };
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
        const previousTimestamp =
          previous?.completedAt ?? previous?.createdAt ?? previous?._creationTime ?? 0;
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
          const failed =
            check.status === "failed" || ["fail", "error", "request_changes"].includes(verdict);
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
      if (!Number.isInteger(offset) || offset < 0)
        throw new Error("--offset must be a non-negative integer");
      const page = paginate(checkEntries.map(summarizeCheck), limit, offset);
      const nextCommand = page.pagination.hasMore
        ? `olympus checks view ${args.id} --json --limit=${limit} --offset=${page.pagination.nextOffset}${args.only ? ` --only=${args.only}` : ""}`
        : undefined;
      printJson(
        omitEmpty({
          version: version.version,
          prechecks,
          checks: page.items,
          pagination: page.pagination,
          readiness,
          nextCommand,
        }),
      );
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
    list: {
      type: "boolean",
      description: "List available check keys and exit",
    },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const wait = resolveWaitWindow(args, CHECK_WAIT_DEFAULTS);
    if (args.list) {
      if (args.json) {
        printJson({
          checks: TRIGGERABLE_CHECK_KEYS.map((key) => ({
            key,
            label: formatDynamicCheckLabel(key),
            includedInRunAll: includesKey(DEFAULT_RUN_ALL_CHECK_KEYS, key),
          })),
          laterStageChecks: NON_GATING_CHECK_KEYS.map((key) => ({
            key,
            label: formatDynamicCheckLabel(key),
          })),
        });
        return;
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
      return;
    }
    if (!args.check) {
      throw new CliError("Missing --check.", {
        kind: "usage",
        code: "input.missing_check",
        retryable: false,
        hint: "Run olympus checks run <id> --list to see available keys, or olympus checks run --help.",
      });
    }
    const checkKey = toPublicCheckKey(args.check);
    if (includesKey(NON_GATING_CHECK_KEYS, checkKey)) {
      const command =
        checkKey === "autoReview" ? "olympus auto-review run" : "olympus verifier-audit run";
      throw new Error(`${checkKey} must be run through: ${command} ${args.id}`);
    }
    if (!includesKey(TRIGGERABLE_CHECK_KEYS, checkKey)) {
      throw new Error(
        `Unknown check key: ${args.check}. Known keys: ${TRIGGERABLE_CHECK_KEYS.join(", ")}`,
      );
    }
    const client = await getClient();
    const { version } = await requireProblemVersion(client, args.id);
    assertPaidEndpoint("runDynamicChecks:triggerDynamicCheck", {
      checkKey,
      useGeneralTokens: args["use-general-tokens"],
    });
    await assertCheckCapacity(client, args.id, version._id, [checkKey]);
    const result: any = await client.action(api.runDynamicChecks.triggerDynamicCheck, {
      versionId: version._id,
      checkKey: toBackendCheckKey(checkKey),
      useGeneralTokens: Boolean(args["use-general-tokens"]),
    });
    if (wait) {
      await waitForChecks({
        client,
        problemId: args.id,
        version,
        jobId: result?.jobId,
        requestedKeys: result?.jobId ? undefined : [checkKey],
        ...wait,
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
  meta: {
    name: "checks run-all",
    description: "Run the default production quality-check set",
  },
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
    wait: {
      type: "boolean",
      description: "Wait for all triggered checks to finish",
    },
    interval: {
      type: "string",
      description: "Poll interval in seconds (default 5)",
    },
    timeout: { type: "string", description: "Timeout in minutes (default 30)" },
    full: { type: "boolean", description: "Include raw results when waiting" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const wait = resolveWaitWindow(args, CHECK_WAIT_DEFAULTS);
    assertTokenPolicy({ useGeneralTokens: args["use-general-tokens"] });
    let checkKeys: string[] = [...DEFAULT_RUN_ALL_CHECK_KEYS];
    if (args.checks !== undefined) {
      const requested = args.checks
        .split(",")
        .map((key) => toPublicCheckKey(key.trim()))
        .filter(Boolean);
      const unknown = requested.filter((key) => !includesKey(TRIGGERABLE_CHECK_KEYS, key));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown check key(s): ${unknown.join(", ")}. Known keys: ${TRIGGERABLE_CHECK_KEYS.join(", ")}`,
        );
      }
      const special = requested.filter((key) => includesKey(NON_GATING_CHECK_KEYS, key));
      if (special.length > 0) {
        throw new Error(`Later-stage checks require dedicated commands: ${special.join(", ")}`);
      }
      if (requested.length === 0) {
        throw new CliError("--checks was empty.", {
          kind: "usage",
          code: "input.empty_checks",
          retryable: false,
          hint: "Provide comma-separated check keys; run olympus checks run <id> --list for options.",
        });
      }
      checkKeys = [...new Set(requested)];
    }
    assertCheckSelection(checkKeys, args.checks !== undefined);
    const client = await getClient();
    const { version } = await requireProblemVersion(client, args.id);
    await assertCheckCapacity(client, args.id, version._id, checkKeys);
    const result: any = await client.action(api.runDynamicChecks.triggerAllDynamicChecks, {
      versionId: version._id,
      checkKeys: checkKeys.map(toBackendCheckKey),
      useGeneralTokens: args["use-general-tokens"],
    });
    if (wait) {
      await waitForChecks({
        client,
        problemId: args.id,
        version,
        jobId: undefined,
        requestedKeys: checkKeys,
        ...wait,
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
const wait = defineCommand({
  meta: {
    name: "checks wait",
    description: "Wait for current quality-check jobs",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    job: { type: "string", description: "Wait for one exact job ID" },
    check: {
      type: "string",
      description: "Wait for the current result of one check key",
    },
    checks: {
      type: "string",
      description: "Comma-separated current check keys",
    },
    interval: {
      type: "string",
      description: "Poll interval in seconds (default 5)",
    },
    timeout: { type: "string", description: "Timeout in minutes (default 30)" },
    full: {
      type: "boolean",
      description: "Include raw payloads and readiness",
    },
    json: {
      type: "boolean",
      description: "Output one compact JSON document to stdout",
    },
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
        ? args.checks
            .split(",")
            .map((key) => key.trim())
            .filter(Boolean)
        : undefined;
    // Validate the wait flags before dispatching, so a bad --interval
    // fails locally instead of after a round trip.
    const window = waitWindow(args, CHECK_WAIT_DEFAULTS);
    const client = await getClient();
    const { version } = await requireProblemVersion(client, args.id);
    await waitForChecks({
      client,
      problemId: args.id,
      version,
      jobId: args.job,
      requestedKeys,
      ...window,
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
    summary: truncate(
      String(
        value.summary
          ?? value.detail
          ?? value.description
          ?? value.suggestion
          ?? value.comment
          ?? value.message
          ?? value.reasoning
          ?? "",
      ),
      320,
    ),
  });
}

const show = defineCommand({
  meta: { name: "checks show", description: "Show one current quality check" },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    check: { type: "positional", description: "Check key", required: true },
    full: {
      type: "boolean",
      description: "Include the complete raw check payload",
    },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const { version } = await requireProblemVersion(client, args.id);
    const dynamic = await client.query(api.runDynamicChecks.getDynamicChecks, {
      versionId: version._id,
    });
    const checkKey = args.check;
    const check = getDynamicCheckEntries(enrichCheckResults(dynamic, version)).find(
      (entry) => entry.key === checkKey,
    );
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
      nextCommand:
        findings.length > 0 ? `olympus checks finding ${args.id} ${checkKey} 1 --json` : undefined,
      fullCommand: `olympus checks show ${args.id} ${checkKey} --full --json`,
    });
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

const finding = defineCommand({
  meta: {
    name: "checks finding",
    description: "Show one finding from a current quality check",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    check: { type: "positional", description: "Check key", required: true },
    finding: {
      type: "positional",
      description: "One-based finding index",
      required: true,
    },
    "max-chars": {
      type: "string",
      description: "Maximum serialized finding characters",
    },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const index = Number(args.finding);
    if (!Number.isInteger(index) || index < 1)
      throw new Error("Finding index must be a positive integer");
    const client = await getClient();
    const { version } = await requireProblemVersion(client, args.id);
    const dynamic = await client.query(api.runDynamicChecks.getDynamicChecks, {
      versionId: version._id,
    });
    const checkKey = args.check;
    const check = getDynamicCheckEntries(enrichCheckResults(dynamic, version)).find(
      (entry) => entry.key === checkKey,
    );
    if (!check) throw new Error(`Check ${checkKey} has not been started on v${version.version}`);
    const findings = extractCheckFindings(check.output);
    const selected = findings[index - 1];
    if (!selected)
      throw new Error(`Finding ${index} does not exist; available: ${findings.length}`);
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
  meta: {
    name: "checks artifact",
    description: "Fetch an artifact from a quality check",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    check: { type: "positional", description: "Check key", required: true },
    key: { type: "string", description: "Artifact key" },
    head: { type: "string", description: "Return the first N lines" },
    tail: { type: "string", description: "Return the last N lines" },
    contains: {
      type: "string",
      description: "Return lines containing text (case-insensitive)",
    },
    "max-chars": {
      type: "string",
      description: "Maximum returned characters (JSON default 12000)",
    },
    full: { type: "boolean", description: "Return the complete artifact" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const checkKey = args.check;
    const backendCheckKey = toBackendCheckKey(checkKey);
    const artifactKey = args.key;
    if (!artifactKey) {
      const available = CHECK_ARTIFACTS[checkKey];
      if (args.json) {
        printJson((available ?? []).map((key) => ({ key })));
        return;
      }
      if (!available) {
        console.log(`\n  No curated artifact list for ${checkKey}.`);
        console.log("  Pass `--key <artifact-key>` if you already know the artifact name.\n");
        return;
      }
      console.log(`\n  Available artifacts for ${checkKey}:`);
      for (const key of available) {
        console.log(`    - ${key}`);
      }
      console.log(
        `\n  Usage: olympus checks artifact ${args.id} ${checkKey} --key <artifact-key>\n`,
      );
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
    const dynamicChecks = normalizeDynamicChecks(
      await client.query(api.runDynamicChecks.getDynamicChecks, {
        versionId: version._id,
      }),
    );
    const check = dynamicChecks[backendCheckKey];
    if (!check?.jobId) {
      throw new Error(`Check "${checkKey}" has no job or artifacts yet`);
    }
    await printArtifact({
      client,
      jobId: check.jobId,
      artifactKey,
      ownerDescription: `check "${checkKey}"`,
      jsonIdentity: { check: checkKey },
      fullCommand: `olympus checks artifact ${args.id} ${checkKey} --key=${artifactKey} --full${args.json ? " --json" : ""}`,
      args,
    });
  },
});
function readStageInput(problem: Problem, version: ProblemVersion) {
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
    wait: {
      type: "boolean",
      description: "Wait for the current-version prechecks to finish",
    },
    interval: {
      type: "string",
      description: "Poll interval in seconds (default 5)",
    },
    timeout: {
      type: "string",
      description: "Wait timeout in minutes (default 30)",
    },
    full: {
      type: "boolean",
      description: "Include raw stages and readiness when waiting",
    },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const { problem, version } = await requireProblemVersion(client, args.id);
    const window = resolveWaitWindow(args, CHECK_WAIT_DEFAULTS);
    const baseline = createPrecheckBaseline(
      await client.query(api.stages.getByVersion, { versionId: version._id }),
    );
    const result = await client.action(api.contributorTokens.runAllChecksWithToken, {
      problemId: asId(args.id),
      versionId: version._id,
      input: readStageInput(problem, version),
      stageIds: PRECHECK_STAGES,
    });
    if (window) {
      await waitForPrechecks({
        client,
        problemId: args.id,
        version,
        baseline,
        ...window,
        json: Boolean(args.json),
        full: Boolean(args.full),
      });
      return;
    }
    const waitCommand = `olympus checks wait-prechecks ${args.id} --version=${version.version} --baseline=${baseline} --json`;
    if (args.json) {
      printJson({ result, version: version.version, baseline, waitCommand });
      return;
    }
    console.log(`\n  Triggered ${PRECHECK_STAGES.length} precheck stages on v${version.version}`);
    console.log(`  \x1b[90mWait: ${waitCommand}\x1b[0m\n`);
  },
});

function precheckStageId(stage: any): string | undefined {
  const id = stage?.stageId ?? stage?.id;
  return PRECHECK_STAGES.includes(id) ? id : undefined;
}
function precheckStageTime(stage: any): number {
  const value = stage?.createdAt ?? stage?._creationTime ?? stage?.completedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function precheckStageIdentity(stage: any): string | undefined {
  const stageId = precheckStageId(stage);
  if (!stageId) return undefined;
  const identity = stage?.jobId ?? stage?._id ?? (stage?.id === stageId ? undefined : stage?.id);
  if (typeof identity === "string" && identity) return `${stageId}:id:${identity}`;
  const timestamp = precheckStageTime(stage);
  return timestamp ? `${stageId}:time:${timestamp}` : undefined;
}
function latestPrecheckStages(stages: unknown): Map<string, any> {
  const latest = new Map<string, any>();
  for (const stage of Array.isArray(stages) ? stages : []) {
    const id = precheckStageId(stage);
    if (!id) continue;
    if (!latest.has(id) || precheckStageTime(stage) >= precheckStageTime(latest.get(id)))
      latest.set(id, stage);
  }
  return latest;
}
export function createPrecheckBaseline(stages: unknown): string {
  const latest = latestPrecheckStages(stages);
  const value = Object.fromEntries(
    PRECHECK_STAGES.map((id) => [
      id,
      {
        identity: precheckStageIdentity(latest.get(id)) ?? null,
        time: precheckStageTime(latest.get(id)),
      },
    ]),
  );
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function parsePrecheckBaseline(
  value: string,
): Record<string, { identity: string | null; time: number }> {
  if (typeof value !== "string" || value.length > 16_384)
    throw new Error("Invalid precheck baseline handle");
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid precheck baseline handle");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.keys(parsed).length !== PRECHECK_STAGES.length
    || PRECHECK_STAGES.some(
      (id) =>
        !Object.hasOwn(parsed, id)
        || !parsed[id]
        || typeof parsed[id] !== "object"
        || (parsed[id].identity !== null
          && (typeof parsed[id].identity !== "string" || !parsed[id].identity))
        || typeof parsed[id].time !== "number"
        || !Number.isFinite(parsed[id].time)
        || parsed[id].time < 0,
    )
  )
    throw new Error("Invalid precheck baseline handle");
  return parsed;
}

export async function waitForPrechecks({
  client,
  problemId,
  version,
  baseline,
  intervalMs,
  timeoutMs,
  json,
  full,
}: {
  client: Client;
  problemId: string;
  version: ProblemVersion;
  baseline: string;
  intervalMs: number;
  timeoutMs: number;
  json?: boolean;
  full?: boolean;
}) {
  const startedAt = Date.now();
  const prior = parsePrecheckBaseline(baseline);
  const targets = new Map<string, string>();
  const terminal = new Set([
    "pass",
    "passed",
    "warn",
    "completed",
    "fail",
    "failed",
    "error",
    "cancelled",
    "canceled",
  ]);
  const failed = new Set(["fail", "failed", "error", "cancelled", "canceled"]);
  while (true) {
    const current = await requireProblemVersion(client, problemId);
    if (current.version._id !== version._id)
      throw new Error(
        `Current version changed from v${version.version} while waiting for prechecks`,
      );
    const [stages, readiness] = await Promise.all([
      client.query(api.stages.getByVersion, { versionId: version._id }),
      client.query(api.submissionReadiness.getSubmissionReadiness, {
        problemId,
      }),
    ]);
    const list = Array.isArray(stages) ? stages : [];
    for (const id of PRECHECK_STAGES) {
      if (targets.has(id)) continue;
      const candidates = list.filter((stage) => {
        const identity = precheckStageIdentity(stage),
          time = precheckStageTime(stage);
        return (
          precheckStageId(stage) === id
          && identity
          && identity !== prior[id].identity
          && (time >= prior[id].time || time === 0 || prior[id].time === 0)
        );
      });
      candidates.sort((a, b) => precheckStageTime(a) - precheckStageTime(b));
      const identity = precheckStageIdentity(candidates[0]);
      if (identity) targets.set(id, identity);
    }
    const selected = PRECHECK_STAGES.map((id) =>
      list.find((stage) => precheckStageIdentity(stage) === targets.get(id)),
    ).filter(Boolean);
    if (targets.size === PRECHECK_STAGES.length && selected.length !== PRECHECK_STAGES.length)
      throw new Error("A scoped precheck stage was replaced or disappeared while waiting");
    const statuses = selected.map((stage) =>
      typeof stage.status === "string" ? stage.status.toLowerCase() : "unknown",
    );
    const complete =
      selected.length === PRECHECK_STAGES.length
      && statuses.every((status) => terminal.has(status));
    const criterion = Array.isArray(readiness?.criteria)
      ? readiness.criteria.find((item: any) => item?.id === "prechecks")
      : undefined;
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (complete) {
      const executionFailed = statuses.some((status) => failed.has(status));
      const result: Record<string, unknown> = {
        status: executionFailed ? "failed" : "completed",
        version: version.version,
        baseline,
        elapsedSeconds,
        stages: selected.map((stage) => ({
          id: stage.stageId ?? stage.id,
          identity: precheckStageIdentity(stage),
          status: stage.status,
        })),
        criterion,
      };
      if (full) Object.assign(result, { stages, readiness });
      if (json) printJson(result);
      else
        console.log(
          `\n  Precheck execution ${executionFailed ? "failed" : "completed"} on v${version.version}.\n`,
        );
      if (executionFailed) process.exitCode = 1;
      return result;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const result = {
        status: "timeout",
        version: version.version,
        elapsedSeconds,
        criterion: criterion ?? null,
      };
      if (json) printJson(result);
      else console.error("\n  Timed out waiting for prechecks.");
      process.exitCode = 2;
      return result;
    }
    if (!json)
      process.stderr.write(
        `\r  waiting prechecks elapsed=${elapsedSeconds}s currentStages=${selected.length}/${PRECHECK_STAGES.length}`,
      );
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const waitPrechecks = defineCommand({
  meta: {
    name: "checks wait-prechecks",
    description: "Wait for prechecks on one exact challenge version",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    version: {
      type: "string",
      description: "Exact version number returned by run-prechecks",
      required: true,
    },
    baseline: {
      type: "string",
      description: "Exact stage baseline handle returned by run-prechecks",
      required: true,
    },
    interval: {
      type: "string",
      description: "Poll interval in seconds (default 5)",
    },
    timeout: {
      type: "string",
      description: "Wait timeout in minutes (default 30)",
    },
    full: { type: "boolean", description: "Include raw stages and readiness" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const { version } = await resolveProblemVersion(
      client,
      args.id,
      parseVersionNumber(args.version),
    );
    await waitForPrechecks({
      client,
      problemId: args.id,
      version,
      baseline: args.baseline,
      intervalMs: parseWaitNumber(args.interval, 5, "--interval") * 1000,
      timeoutMs: parseWaitNumber(args.timeout, 30, "--timeout") * 60 * 1000,
      json: Boolean(args.json),
      full: Boolean(args.full),
    });
  },
});
export default defineCommand({
  meta: {
    name: "checks",
    description: "Prechecks, quality checks, and readiness",
  },
  subCommands: {
    view,
    show,
    finding,
    run,
    "run-all": runAll,
    wait,
    artifact,
    "run-prechecks": runPrechecks,
    "wait-prechecks": waitPrechecks,
  },
});
