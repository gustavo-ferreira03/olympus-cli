import { defineCommand } from "citty";
import { api } from "../convex.ts";
import { printJson } from "../format.ts";
import {
  commonArgs,
  printResult,
  resolveCommandContext,
} from "../command-utils.ts";

const view = defineCommand({
  meta: { name: "fp-check view", description: "View false-positive review state" },
  args: commonArgs,
  run: async ({ args }) => {
    const { client, versionId } = await resolveCommandContext(args);
    const result = await client.query(api.fpReview.getFpCheckForVersion, { versionId });
    printResult(result, args.json);
  },
});

const run = defineCommand({
  meta: { name: "fp-check run", description: "Run the false-positive review panel" },
  args: {
    ...commonArgs,
    "use-general-tokens": {
      type: "boolean",
      description: "Charge general tokens instead of revision tokens",
    },
  },
  run: async ({ args }) => {
    const { client, versionId, versionNumber } = await resolveCommandContext(args);
    const state: any = await client.query(api.fpReview.getFpCheckForVersion, { versionId });
    if (state?.canRun === false || state?.hasEligiblePasses === false) {
      const reasons = [
        state.hasEligiblePasses === false ? "no eligible passing runs" : null,
        state.canRun === false ? "backend reports this check cannot run" : null,
      ].filter(Boolean);
      throw new Error(`FP check is blocked: ${reasons.join("; ") || "unknown reason"}`);
    }
    const result = await client.action(api.fpReview.requestFpCheck, {
      versionId,
      useGeneralTokens: args["use-general-tokens"] || undefined,
    });
    if (args.json) return printJson(result);
    console.log(`\n  False-positive review triggered on v${versionNumber}.\n`);
  },
});

export default defineCommand({
  meta: { name: "fp-check", description: "False-positive review operations" },
  subCommands: { view, run },
});
