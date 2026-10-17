import { defineCommand } from "citty";
import { CliError } from "../shared/errors.ts";
import { api } from "../platform/convex.ts";
import { resolveWaitWindow, waitWindow } from "../shared/wait.ts";

import { printJson } from "../terminal/format.ts";
import { commonArgs, printResult, resolveCommandContext } from "./command-utils.ts";

/** FP checks run longer than ordinary quality checks. */
const FP_CHECK_WAIT_DEFAULTS = {
  intervalSeconds: 5,
  timeoutMinutes: 45,
} as const;

type FpReviewStatus = "running" | "idle" | "stale" | "completed" | "failed" | "error";

// getFpCheckForVersion reports `state` as not_run | stale | running | passed |
// passed_with_warnings | failed. `failed` is the review verdict (a false positive was
// found), not a job failure; a job that crashed carries `error` instead.
function fpReviewStatus(state: any): FpReviewStatus {
  const status = String(
    state?.state ?? state?.status ?? state?.job?.status ?? state?.jobStatus ?? "",
  ).toLowerCase();
  if (state?.inFlight || ["pending", "running", "queued", "processing"].includes(status)) {
    return "running";
  }
  if (status === "not_run") return "idle";
  if (status === "stale") return "stale";
  if (status === "failed")
    return state?.error && !state?.resultSummary?.length ? "error" : "failed";
  if (["error", "cancelled", "canceled"].includes(status)) return "error";
  return "completed";
}

const FP_VERDICTS: Partial<Record<FpReviewStatus, string>> = {
  completed: "passed",
  failed: "false_positive",
};

function activeState(state: any): boolean {
  return fpReviewStatus(state) === "running";
}

async function queryFpStateWithRetry(
  client: any,
  versionId: string,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await client.query(api.fpReview.getFpCheckForVersion, {
        versionId,
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        process.stderr.write(`\n  Poll failed; retrying (${attempt}/3)...\n`);
        await sleep(attempt * 1000);
      }
    }
  }
  throw lastError;
}

async function waitForFpCheck({
  client,
  versionId,
  versionNumber,
  jobId,
  intervalMs,
  timeoutMs,
  json,
  full,
}: any) {
  const startedAt = Date.now();
  while (true) {
    const state: any = await queryFpStateWithRetry(client, versionId);
    if (state == null) {
      const result = { status: "idle", version: versionNumber };
      if (json) printJson(result);
      else console.log("\n  No FP check exists for this version.\n");
      return result;
    }
    const currentJobId = state?.jobId ?? state?.job?.id;
    if (jobId && currentJobId && currentJobId !== jobId) {
      throw new Error(`FP check ${jobId} was replaced by ${currentJobId}`);
    }
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (!activeState(state)) {
      const status = fpReviewStatus(state);
      const result = {
        status,
        version: versionNumber,
        elapsedSeconds,
        ...(full
          ? { state }
          : {
              jobId: currentJobId,
              state: state?.state,
              verdict: state?.verdict ?? state?.output?.verdict ?? FP_VERDICTS[status],
              canContest: state?.canContest,
              error: state?.error,
            }),
      };
      if (json) printJson(result);
      else printResult(result, false);
      if (status === "failed" || status === "error") process.exitCode = 1;
      return result;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const result = {
        status: "timeout",
        version: versionNumber,
        elapsedSeconds,
        jobId: currentJobId,
      };
      if (json) printJson(result);
      else console.error(`\n  Timed out waiting for FP check ${currentJobId ?? ""}.\n`);
      process.exitCode = 2;
      return result;
    }
    if (!json) process.stderr.write(`\r  waiting FP check elapsed=${elapsedSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const view = defineCommand({
  meta: {
    name: "fp-check view",
    description: "View false-positive review state",
  },
  args: commonArgs,
  run: async ({ args }) => {
    const { client, versionId } = await resolveCommandContext(args);
    const result: any = await client.query(api.fpReview.getFpCheckForVersion, {
      versionId,
    });
    printResult(result == null ? result : { status: fpReviewStatus(result), ...result }, args.json);
  },
});

const MAX_KEEP_PATHS = 10;
const MAX_KEEP_PATH_LENGTH = 200;

/** Mirrors the web normalization: repo-relative folders with a trailing slash. */
export function normalizeKeepPaths(raw: string[]): string[] {
  const paths = new Set<string>();
  for (const entry of raw) {
    const value = entry.trim().replaceAll("\\", "/");
    if (!value) continue;
    if (value.startsWith("/"))
      throw new CliError(`Keep path must be repo-relative: ${entry}`, {
        kind: "usage",
        code: "input.invalid_keep_path",
        retryable: false,
      });
    if (value.split("/").includes(".."))
      throw new CliError(`Keep path must not contain "..": ${entry}`, {
        kind: "usage",
        code: "input.invalid_keep_path",
        retryable: false,
      });
    const folder = value.endsWith("/") ? value : `${value}/`;
    if (folder.length > MAX_KEEP_PATH_LENGTH)
      throw new CliError(`Keep path exceeds ${MAX_KEEP_PATH_LENGTH} characters: ${entry}`, {
        kind: "usage",
        code: "input.invalid_keep_path",
        retryable: false,
      });
    paths.add(folder);
  }
  if (paths.size > MAX_KEEP_PATHS)
    throw new CliError(`At most ${MAX_KEEP_PATHS} keep paths are allowed (got ${paths.size})`, {
      kind: "usage",
      code: "input.too_many_keep_paths",
      retryable: false,
    });
  return [...paths];
}

const contest = defineCommand({
  meta: {
    name: "fp-check contest",
    description: "Contest a failed FP check verdict (becomes a non-blocking reviewer note)",
  },
  args: {
    ...commonArgs,
    note: {
      type: "string",
      description: "Why the flagged runs are not false positives",
      required: true,
    },
  },
  run: async ({ args }) => {
    const note = args.note.trim();
    if (!note) throw new Error("--note must not be empty");
    if (note.length > 2000) throw new Error("--note must be at most 2000 characters");
    const { client, versionId } = await resolveCommandContext(args);
    const state: any = await client.query(api.fpReview.getFpCheckForVersion, { versionId });
    if (state && state.canContest === false)
      throw new CliError("This FP check cannot be contested", {
        kind: "usage",
        code: "fp_check.not_contestable",
        retryable: false,
        hint: `Inspect: olympus fp-check view ${args.id} --json`,
      });
    const result = await client.mutation(api.fpReview.contestFpCheck, { versionId, note });
    printResult(result ?? { contested: true }, args.json);
  },
});

const keepPaths = defineCommand({
  meta: {
    name: "fp-check keep-paths",
    description: "View or set protected source folders for the next FP check",
  },
  args: {
    ...commonArgs,
    set: {
      type: "string",
      description: "Comma-separated repo-relative folders (e.g. src/,lib/)",
    },
    clear: { type: "boolean", description: "Remove all protected folders" },
  },
  run: async ({ args }) => {
    if (args.set !== undefined && args.clear)
      throw new CliError("Use either --set or --clear", {
        kind: "usage",
        code: "input.conflicting_flags",
        retryable: false,
      });
    const { client, versionId } = await resolveCommandContext(args);
    if (args.set === undefined && !args.clear) {
      const state: any = await client.query(api.fpReview.getFpCheckForVersion, { versionId });
      printResult(
        { fpKeepPaths: state?.fpKeepPaths ?? [], canEditKeepPaths: state?.canEditKeepPaths },
        args.json,
      );
      return;
    }
    const paths = args.clear ? null : normalizeKeepPaths(args.set!.split(","));
    const result = await client.mutation(api.fpReview.setFpKeepPaths, { versionId, paths });
    printResult(result ?? { fpKeepPaths: paths ?? [] }, args.json);
  },
});

const wait = defineCommand({
  meta: {
    name: "fp-check wait",
    description: "Wait for the current false-positive review",
  },
  args: {
    ...commonArgs,
    job: { type: "string", description: "Expected FP check job ID" },
    interval: {
      type: "string",
      description: "Poll interval in seconds (default 5)",
    },
    timeout: { type: "string", description: "Timeout in minutes (default 45)" },
    full: {
      type: "boolean",
      description: "Include the complete backend payload",
    },
  },
  run: async ({ args }) => {
    // Validate the wait flags before dispatching, so a bad --interval
    // fails locally instead of after a round trip.
    const window = waitWindow(args, FP_CHECK_WAIT_DEFAULTS);
    const { client, versionId, versionNumber } = await resolveCommandContext(args);
    await waitForFpCheck({
      client,
      versionId,
      versionNumber,
      jobId: args.job,
      ...window,
      json: Boolean(args.json),
      full: Boolean(args.full),
    });
  },
});

const run = defineCommand({
  meta: {
    name: "fp-check run",
    description: "Run the false-positive review panel",
  },
  args: {
    ...commonArgs,
    "use-general-tokens": {
      type: "boolean",
      description: "Charge general tokens instead of revision tokens",
    },
    wait: { type: "boolean", description: "Wait for the FP check to finish" },
    interval: {
      type: "string",
      description: "Poll interval in seconds (default 5)",
    },
    timeout: { type: "string", description: "Timeout in minutes (default 45)" },
    full: { type: "boolean", description: "Include raw result when waiting" },
  },
  run: async ({ args }) => {
    const waitOptions = resolveWaitWindow(args, FP_CHECK_WAIT_DEFAULTS);
    const { client, versionId, versionNumber } = await resolveCommandContext(args);
    const result: any = await client.action(api.fpReview.requestFpCheck, {
      versionId,
      useGeneralTokens: args["use-general-tokens"] || undefined,
    });
    if (waitOptions) {
      await waitForFpCheck({
        client,
        versionId,
        versionNumber,
        jobId: result?.jobId,
        ...waitOptions,
        json: Boolean(args.json),
        full: Boolean(args.full),
      });
      return;
    }
    const waitCommand = result?.jobId
      ? `olympus fp-check wait ${args.id} --job=${result.jobId} --json`
      : `olympus fp-check wait ${args.id} --json`;
    if (args.json) return printJson({ ...result, version: versionNumber, waitCommand });
    console.log(`\n  False-positive review triggered on v${versionNumber}.`);
    console.log(`  Wait: ${waitCommand}\n`);
  },
});

export default defineCommand({
  meta: { name: "fp-check", description: "False-positive review operations" },
  subCommands: { view, run, wait, contest, "keep-paths": keepPaths },
});
