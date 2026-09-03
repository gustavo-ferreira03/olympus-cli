import { defineCommand } from "citty";
import { api } from "../convex.ts";
import { statusBadge, truncate, printJson } from "../format.ts";
import { commonArgs, resolveCommandContext } from "../command-utils.ts";

const view = defineCommand({
  meta: { name: "scope-gate view", description: "View Scope Gate state and history" },
  args: commonArgs,
  run: async ({ args }) => {
    const { client, versionId, versionNumber } = await resolveCommandContext(args);
    const result: any = await client.query(api.scopeGate.getScopeGate, { versionId });
    if (args.json) return printJson(result);
    console.log(`\n  Scope Gate for v${versionNumber}`);
    console.log(
      `  ${statusBadge(result?.inFlight ? "running" : (result?.latestVerdict ?? "not_run"))}`,
    );
    console.log(`  Fresh: ${result?.fresh === true ? "yes" : "no"}`);
    if (result?.verdictRun?.output?.summary) {
      console.log(`  ${truncate(String(result.verdictRun.output.summary), 120)}`);
    }
    console.log("");
  },
});

const run = defineCommand({
  meta: { name: "scope-gate run", description: "Run or rerun the Scope Gate" },
  args: {
    ...commonArgs,
    "use-general-tokens": {
      type: "boolean",
      description: "Charge general tokens instead of revision tokens",
    },
  },
  run: async ({ args }) => {
    const { client, problemId, versionId, versionNumber } = await resolveCommandContext(args);
    const [scopeState, readiness] = await Promise.all([
      client.query(api.scopeGate.getScopeGate, { versionId }),
      client.query(api.submissionReadiness.getSubmissionReadiness, { problemId }),
    ]);
    const prechecks = (readiness as any)?.criteria?.find(
      (criterion: any) => criterion.id === "prechecks",
    );
    if (prechecks && prechecks.status !== "pass") {
      throw new Error(`Scope Gate is blocked: Prechecks ${prechecks.detail ?? prechecks.status}`);
    }
    if ((scopeState as any)?.inFlight) {
      throw new Error("Scope Gate is already running");
    }
    const result: any = await client.action(api.scopeGate.triggerScopeGate, {
      versionId,
      useGeneralTokens: Boolean(args["use-general-tokens"]),
    });
    if (args.json) return printJson(result);
    console.log(`\n  Scope Gate triggered on v${versionNumber}.`);
    if (result?.jobId) console.log(`  Job: ${result.jobId}`);
    console.log("");
  },
});

export default defineCommand({
  meta: { name: "scope-gate", description: "Scope Gate operations" },
  subCommands: { view, run },
});
