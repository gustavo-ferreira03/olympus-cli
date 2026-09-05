import { defineCommand } from "citty";
import { api } from "../convex.ts";
import { parseWaitNumber } from "./checks.ts";
import { printJson } from "../format.ts";
import {
  commonArgs,
  printResult,
  resolveCommandContext,
} from "../command-utils.ts";

type OrchestratorWaitStatus =
  "not_started" | "running" | "failed" | "completed";

const ACTIVE_STATUSES = new Set(["pending", "running", "queued", "processing"]);
const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);

function slotStatus(slot: any): string {
  return String(slot?.status ?? "").toLowerCase();
}

export function orchestratorReviewStatus(review: any): OrchestratorWaitStatus {
  const slots = review?.slots;
  if (!slots || typeof slots !== "object") return "not_started";

  const synthesisStatus = slotStatus(slots.synthesis);
  if (synthesisStatus === "completed") return "completed";
  if (FAILED_STATUSES.has(synthesisStatus)) return "failed";
  if (ACTIVE_STATUSES.has(synthesisStatus)) return "running";

  const dimensions = [
    slots.description,
    slots.tests,
    slots.solution,
    slots.agents,
  ].filter(Boolean);
  if (dimensions.length === 0) return "not_started";
  if (dimensions.some((slot) => FAILED_STATUSES.has(slotStatus(slot))))
    return "failed";
  return "running";
}

function reviewJobIds(review: any): string[] {
  const slots = review?.slots;
  if (!slots || typeof slots !== "object") return [];
  return [
    slots.description,
    slots.tests,
    slots.solution,
    slots.agents,
    slots.synthesis,
  ]
    .map((slot) => slot?.jobId)
    .filter(
      (jobId): jobId is string => typeof jobId === "string" && jobId.length > 0,
    );
}

function summarizeOrchestratorReview(review: any) {
  const slots = review?.slots ?? {};
  return Object.fromEntries(
    ["description", "tests", "solution", "agents", "synthesis"].map((key) => [
      key,
      slots[key]
        ? {
            jobId: slots[key].jobId,
            status: slots[key].status,
            stale: slots[key].stale,
            band: slots[key].output?.band,
            outcome: slots[key].output?.outcome,
            summary: slots[key].output?.summary,
          }
        : null,
    ]),
  );
}

export async function queryAutoReviewStateWithRetry(
  client: any,
  versionId: string,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const review = await client.query(
        api.orchestratorReview.getOrchestratorReview,
        { versionId },
      );
      const triggerState = await client.query(
        api.runDynamicChecks.getAutoReviewTriggerState,
        { versionId },
      );
      return { review, triggerState };
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

async function waitForAutoReview({
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
    const { review, triggerState } = await queryAutoReviewStateWithRetry(
      client,
      versionId,
    );
    let status = orchestratorReviewStatus(review);
    const backendReportsRunning = (triggerState?.blockers ?? []).some(
      (blocker: any) => blocker?.id === "review_running",
    );
    if (status === "not_started" && backendReportsRunning) status = "running";

    const currentJobIds = reviewJobIds(review);
    if (jobId && currentJobIds.length > 0 && !currentJobIds.includes(jobId)) {
      throw new Error(
        `Auto Review job ${jobId} is not current on v${versionNumber}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (status === "completed" || status === "failed") {
      const result = {
        status,
        version: versionNumber,
        elapsedSeconds,
        ...(full
          ? { review, triggerState }
          : { slots: summarizeOrchestratorReview(review) }),
      };
      if (json) printJson(result);
      else printResult(result, false);
      if (status === "failed") process.exitCode = 1;
      return result;
    }
    if (status === "not_started") {
      throw new Error(`Auto Review has not been started on v${versionNumber}`);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const result = {
        status: "timeout",
        version: versionNumber,
        elapsedSeconds,
        slots: summarizeOrchestratorReview(review),
      };
      if (json) printJson(result);
      else console.error("\n  Timed out waiting for Auto Review.\n");
      process.exitCode = 2;
      return result;
    }
    if (!json)
      process.stderr.write(
        `\r  waiting Auto Review elapsed=${elapsedSeconds}s`,
      );
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const view = defineCommand({
  meta: {
    name: "auto-review view",
    description: "View Auto Review state and blockers",
  },
  args: commonArgs,
  run: async ({ args }) => {
    const { client, problemId, versionId } = await resolveCommandContext(args);
    const [review, triggerState, readiness] = await Promise.all([
      client.query(api.orchestratorReview.getOrchestratorReview, { versionId }),
      client.query(api.runDynamicChecks.getAutoReviewTriggerState, {
        versionId,
      }),
      client.query(api.submissionReadiness.getSubmissionReadinessForBothTypes, {
        problemId,
      }),
    ]);
    printResult({ review, triggerState, readiness }, args.json);
  },
});

const wait = defineCommand({
  meta: {
    name: "auto-review wait",
    description: "Wait for the current Auto Review check",
  },
  args: {
    ...commonArgs,
    job: { type: "string", description: "Expected Auto Review job ID" },
    interval: {
      type: "string",
      description: "Poll interval in seconds (default 5)",
    },
    timeout: { type: "string", description: "Timeout in minutes (default 30)" },
    full: { type: "boolean", description: "Include raw result when waiting" },
  },
  run: async ({ args }) => {
    const { client, versionId, versionNumber } =
      await resolveCommandContext(args);
    await waitForAutoReview({
      client,
      versionId,
      versionNumber,
      jobId: args.job,
      intervalMs: parseWaitNumber(args.interval, 5, "--interval") * 1000,
      timeoutMs: parseWaitNumber(args.timeout, 30, "--timeout") * 60 * 1000,
      json: Boolean(args.json),
      full: Boolean(args.full),
    });
  },
});

const run = defineCommand({
  meta: {
    name: "auto-review run",
    description: "Run the UI Auto Review check",
  },
  args: {
    ...commonArgs,
    "use-general-tokens": {
      type: "boolean",
      description: "Charge general tokens instead of revision tokens",
    },
    wait: { type: "boolean", description: "Wait for Auto Review to finish" },
    interval: {
      type: "string",
      description: "Poll interval in seconds (default 5)",
    },
    timeout: { type: "string", description: "Timeout in minutes (default 30)" },
    full: { type: "boolean", description: "Include raw result when waiting" },
  },
  run: async ({ args }) => {
    const { client, problemId, version, versionId, versionNumber } =
      await resolveCommandContext(args);
    const state: any = await client.query(
      api.runDynamicChecks.getAutoReviewTriggerState,
      { versionId },
    );
    if (state?.canRun === false) {
      const reasons = (state.blockers ?? [])
        .map((item: any) => item.reason)
        .filter(Boolean);
      throw new Error(
        `Auto Review is blocked: ${reasons.join("; ") || "unknown reason"}`,
      );
    }
    const result: any = await client.action(
      api.runDynamicChecks.triggerDynamicCheck,
      {
        versionId,
        checkKey: "autoReview",
        useGeneralTokens: args["use-general-tokens"] || undefined,
      },
    );
    if (args.wait) {
      await waitForAutoReview({
        client,
        versionId,
        versionNumber,
        jobId: result?.jobId,
        intervalMs: parseWaitNumber(args.interval, 5, "--interval") * 1000,
        timeoutMs: parseWaitNumber(args.timeout, 30, "--timeout") * 60 * 1000,
        json: Boolean(args.json),
        full: Boolean(args.full),
      });
      return;
    }
    const waitCommand = result?.jobId
      ? `olympus auto-review wait ${problemId} --job=${result.jobId} --json`
      : `olympus auto-review wait ${problemId} --json`;
    if (args.json) return printJson({ ...result, waitCommand });
    console.log(`\n  Auto Review triggered on v${versionNumber}.`);
    console.log(`  Wait: ${waitCommand}\n`);
  },
});

const orchestrate = defineCommand({
  meta: {
    name: "auto-review orchestrate",
    description: "Run or resume the multi-slot orchestrator review",
  },
  args: {
    ...commonArgs,
    "force-fresh": {
      type: "boolean",
      description:
        "Rerun every review dimension instead of resuming existing results",
    },
  },
  run: async ({ args }) => {
    const { client, versionId } = await resolveCommandContext(args);
    const isAdmin = await client.query(api.admins.isCurrentUser, {});
    if (!isAdmin) {
      throw new Error(
        "Auto Review orchestration is restricted to admins in the UI",
      );
    }
    const result = await client.action(
      api.orchestratorReview.triggerOrchestratorReview,
      { versionId, forceFresh: Boolean(args["force-fresh"]) },
    );
    printResult(result, args.json);
  },
});

export default defineCommand({
  meta: { name: "auto-review", description: "Auto Review operations" },
  subCommands: { view, run, wait, orchestrate },
});
