import { defineCommand } from "citty";
import { api } from "../convex.ts";
import { parseWaitNumber } from "./checks.ts";
import { printJson } from "../format.ts";
import {
  commonArgs,
  printResult,
  resolveCommandContext,
} from "../command-utils.ts";

export function fpReviewStatus(state: any): "running" | "failed" | "completed" {
  const status = String(
    state?.state ??
      state?.status ??
      state?.job?.status ??
      state?.jobStatus ??
      "",
  ).toLowerCase();
  if (
    state?.inFlight ||
    ["pending", "running", "queued", "processing"].includes(status)
  ) {
    return "running";
  }
  if (["failed", "error", "cancelled", "canceled"].includes(status)) {
    return "failed";
  }
  return "completed";
}

function activeState(state: any): boolean {
  return fpReviewStatus(state) === "running";
}

function failedState(state: any): boolean {
  return fpReviewStatus(state) === "failed";
}

export async function queryFpStateWithRetry(
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
    const currentJobId = state?.jobId ?? state?.job?.id;
    if (jobId && currentJobId && currentJobId !== jobId) {
      throw new Error(`FP check ${jobId} was replaced by ${currentJobId}`);
    }
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (!activeState(state)) {
      const result = {
        status: failedState(state) ? "failed" : "completed",
        version: versionNumber,
        elapsedSeconds,
        ...(full
          ? { state }
          : {
              jobId: currentJobId,
              verdict: state?.verdict ?? state?.output?.verdict,
            }),
      };
      if (json) printJson(result);
      else printResult(result, false);
      if (failedState(state)) process.exitCode = 1;
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
      else
        console.error(
          `\n  Timed out waiting for FP check ${currentJobId ?? ""}.\n`,
        );
      process.exitCode = 2;
      return result;
    }
    if (!json)
      process.stderr.write(`\r  waiting FP check elapsed=${elapsedSeconds}s`);
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
    const result = await client.query(api.fpReview.getFpCheckForVersion, {
      versionId,
    });
    printResult(result, args.json);
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
    const { client, versionId, versionNumber } =
      await resolveCommandContext(args);
    await waitForFpCheck({
      client,
      versionId,
      versionNumber,
      jobId: args.job,
      intervalMs: parseWaitNumber(args.interval, 5, "--interval") * 1000,
      timeoutMs: parseWaitNumber(args.timeout, 45, "--timeout") * 60 * 1000,
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
    const { client, versionId, versionNumber } =
      await resolveCommandContext(args);
    const state: any = await client.query(api.fpReview.getFpCheckForVersion, {
      versionId,
    });
    if (state?.canRun === false || state?.hasEligiblePasses === false) {
      const reasons = [
        state.hasEligiblePasses === false ? "no eligible passing runs" : null,
        state.canRun === false ? "backend reports this check cannot run" : null,
      ].filter(Boolean);
      throw new Error(
        `FP check is blocked: ${reasons.join("; ") || "unknown reason"}`,
      );
    }
    const result: any = await client.action(api.fpReview.requestFpCheck, {
      versionId,
      useGeneralTokens: args["use-general-tokens"] || undefined,
    });
    if (args.wait) {
      await waitForFpCheck({
        client,
        versionId,
        versionNumber,
        jobId: result?.jobId,
        intervalMs: parseWaitNumber(args.interval, 5, "--interval") * 1000,
        timeoutMs: parseWaitNumber(args.timeout, 45, "--timeout") * 60 * 1000,
        json: Boolean(args.json),
        full: Boolean(args.full),
      });
      return;
    }
    const waitCommand = result?.jobId
      ? `olympus fp-check wait ${args.id} --job=${result.jobId} --json`
      : `olympus fp-check wait ${args.id} --json`;
    if (args.json) return printJson({ ...result, waitCommand });
    console.log(`\n  False-positive review triggered on v${versionNumber}.`);
    console.log(`  Wait: ${waitCommand}\n`);
  },
});

export default defineCommand({
  meta: { name: "fp-check", description: "False-positive review operations" },
  subCommands: { view, run, wait },
});
