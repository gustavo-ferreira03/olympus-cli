import { defineCommand } from "citty";
import { api } from "../convex.ts";
import { printJson } from "../format.ts";
import {
  commonArgs,
  printResult,
  resolveCommandContext,
} from "../command-utils.ts";

const view = defineCommand({
  meta: { name: "auto-review view", description: "View Auto Review state and blockers" },
  args: commonArgs,
  run: async ({ args }) => {
    const { client, problemId, versionId } = await resolveCommandContext(args);
    const [review, triggerState, readiness] = await Promise.all([
      client.query(api.orchestratorReview.getOrchestratorReview, { versionId }),
      client.query(api.runDynamicChecks.getAutoReviewTriggerState, { versionId }),
      client.query(api.submissionReadiness.getSubmissionReadinessForBothTypes, {
        problemId,
      }),
    ]);
    printResult({ review, triggerState, readiness }, args.json);
  },
});

const run = defineCommand({
  meta: { name: "auto-review run", description: "Run the UI Auto Review check" },
  args: {
    ...commonArgs,
    "use-general-tokens": {
      type: "boolean",
      description: "Charge general tokens instead of revision tokens",
    },
  },
  run: async ({ args }) => {
    const { client, versionId, versionNumber } = await resolveCommandContext(args);
    const state: any = await client.query(
      api.runDynamicChecks.getAutoReviewTriggerState,
      { versionId },
    );
    if (state?.canRun === false) {
      const reasons = (state.blockers ?? [])
        .map((item: any) => item.reason)
        .filter(Boolean);
      throw new Error(`Auto Review is blocked: ${reasons.join("; ") || "unknown reason"}`);
    }
    const result = await client.action(api.runDynamicChecks.triggerDynamicCheck, {
      versionId,
      checkKey: "autoReview",
      useGeneralTokens: args["use-general-tokens"] || undefined,
    });
    if (args.json) return printJson(result);
    console.log(`\n  Auto Review triggered on v${versionNumber}.\n`);
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
      description: "Rerun every review dimension instead of resuming existing results",
    },
  },
  run: async ({ args }) => {
    const { client, versionId } = await resolveCommandContext(args);
    const isAdmin = await client.query(api.admins.isCurrentUser, {});
    if (!isAdmin) {
      throw new Error("Auto Review orchestration is restricted to admins in the UI");
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
  subCommands: { view, run, orchestrate },
});
