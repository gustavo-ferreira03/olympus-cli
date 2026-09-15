import { defineCommand } from "citty";
import { api } from "../platform/convex.ts";
import { resolveWaitWindow, waitWindow } from "../shared/wait.ts";

import { statusBadge, truncate, printJson } from "../terminal/format.ts";
import { commonArgs, resolveCommandContext } from "./command-utils.ts";

/** Scope Gate shares the quality-check cadence. */
const SCOPE_GATE_WAIT_DEFAULTS = {
  intervalSeconds: 5,
  timeoutMinutes: 30,
} as const;

function isActive(status: unknown): boolean {
  return status === "pending" || status === "running";
}

function scopeStatus(state: any): string {
  if (state?.inFlight) return "running";
  return String(state?.latestVerdict ?? state?.status ?? "not_run").toLowerCase();
}

async function waitForScopeGate({
  client,
  versionId,
  versionNumber,
  intervalMs,
  timeoutMs,
  json,
}: any) {
  const startedAt = Date.now();
  while (true) {
    const state: any = await client.query(api.scopeGate.getScopeGate, {
      versionId,
    });
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (state == null) {
      const result = { status: "idle", version: versionNumber };
      if (json) printJson(result);
      else console.log("\n  No Scope Gate exists for this version.\n");
      return result;
    }
    const status = scopeStatus(state);
    if (!isActive(status) && !state?.inFlight) {
      const result = {
        status: status === "fail" || status === "failed" ? "failed" : "completed",
        version: versionNumber,
        elapsedSeconds,
        state,
      };
      if (json) printJson(result);
      else
        console.log(
          `\n  Scope Gate ${result.status} on v${versionNumber}: ${statusBadge(status)}\n`,
        );
      if (result.status === "failed") process.exitCode = 1;
      return result;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const result = {
        status: "timeout",
        version: versionNumber,
        elapsedSeconds,
        state,
      };
      if (json) printJson(result);
      else console.error(`\n  Timed out waiting for Scope Gate.\n`);
      process.exitCode = 2;
      return result;
    }
    if (!json) process.stderr.write(`\r  waiting Scope Gate elapsed=${elapsedSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const view = defineCommand({
  meta: {
    name: "scope-gate view",
    description: "View Scope Gate state and history",
  },
  args: commonArgs,
  run: async ({ args }) => {
    const { client, versionId, versionNumber } = await resolveCommandContext(args);
    const result: any = await client.query(api.scopeGate.getScopeGate, {
      versionId,
    });
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

const wait = defineCommand({
  meta: {
    name: "scope-gate wait",
    description: "Wait for the current Scope Gate",
  },
  args: {
    ...commonArgs,
    interval: {
      type: "string",
      description: "Poll interval in seconds (default 5)",
    },
    timeout: { type: "string", description: "Timeout in minutes (default 30)" },
  },
  run: async ({ args }) => {
    // Validate the wait flags before dispatching, so a bad --interval
    // fails locally instead of after a round trip.
    const window = waitWindow(args, SCOPE_GATE_WAIT_DEFAULTS);
    const { client, versionId, versionNumber } = await resolveCommandContext(args);
    await waitForScopeGate({
      client,
      versionId,
      versionNumber,
      ...window,
      json: Boolean(args.json),
    });
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
    wait: { type: "boolean", description: "Wait for Scope Gate to finish" },
    interval: {
      type: "string",
      description: "Poll interval in seconds (default 5)",
    },
    timeout: { type: "string", description: "Timeout in minutes (default 30)" },
  },
  run: async ({ args }) => {
    const wait = resolveWaitWindow(args, SCOPE_GATE_WAIT_DEFAULTS);
    const { client, problemId, versionId, versionNumber } = await resolveCommandContext(args);
    const [scopeState, readiness] = await Promise.all([
      client.query(api.scopeGate.getScopeGate, { versionId }),
      client.query(api.submissionReadiness.getSubmissionReadiness, {
        problemId,
      }),
    ]);
    const prechecks = (readiness as any)?.criteria?.find(
      (criterion: any) => criterion.id === "prechecks",
    );
    if (prechecks && prechecks.status !== "pass") {
      throw new Error(`Scope Gate is blocked: Prechecks ${prechecks.detail ?? prechecks.status}`);
    }
    if ((scopeState as any)?.inFlight) throw new Error("Scope Gate is already running");
    const result: any = await client.action(api.scopeGate.triggerScopeGate, {
      versionId,
      useGeneralTokens: Boolean(args["use-general-tokens"]),
    });
    if (wait) {
      await waitForScopeGate({
        client,
        versionId,
        versionNumber,
        ...wait,
        json: Boolean(args.json),
      });
      return;
    }
    if (args.json)
      return printJson({
        ...result,
        version: versionNumber,
        waitCommand: `olympus scope-gate wait ${args.id} --version=${versionNumber} --json`,
      });
    console.log(`\n  Scope Gate triggered on v${versionNumber}.`);
    console.log(`  Wait: olympus scope-gate wait ${args.id} --version=${versionNumber} --json\n`);
  },
});

export default defineCommand({
  meta: { name: "scope-gate", description: "Scope Gate operations" },
  subCommands: { view, run, wait },
});
