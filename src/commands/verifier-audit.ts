import { defineCommand } from "citty";
import { api } from "../convex.ts";
import { parseWaitNumber, waitForChecks } from "./checks.ts";
import { printJson } from "../format.ts";
import { normalizeDynamicChecks } from "../model.ts";
import {
  commonArgs,
  printResult,
  readOptionalFile,
  resolveCommandContext,
} from "../command-utils.ts";

const view = defineCommand({
  meta: {
    name: "verifier-audit view",
    description: "View verifier completeness output and current decision",
  },
  args: commonArgs,
  run: async ({ args }) => {
    const { client, versionId } = await resolveCommandContext(args);
    const dynamic: any = await client.query(api.runDynamicChecks.getDynamicChecks, {
      versionId,
    });
    const check = normalizeDynamicChecks(dynamic).verifierIncompleteness ?? null;
    const [decision, notice] = await Promise.all([
      check?.jobId
        ? client.query(api.verifierIncompleteness.getVerifierIncompletenessDecision, {
            jobId: check.jobId,
          })
        : Promise.resolve(null),
      client.query(api.verifierIncompleteness.getVerifierAuditReviewNotice, {
        versionId,
      }),
    ]);
    printResult(
      {
        check,
        decision,
        notice,
        agent: dynamic?._verifierIncompletenessAgent ?? null,
        originalTestPatch: dynamic?._verifierIncompletenessOriginalTestPatch ?? null,
        proposedTestPatch: dynamic?._verifierIncompletenessProposedTestPatch ?? null,
      },
      args.json,
    );
  },
});

const run = defineCommand({
  meta: { name: "verifier-audit run", description: "Run verifier completeness audit" },
  args: {
    ...commonArgs,
    "use-general-tokens": {
      type: "boolean",
      description: "Charge general tokens instead of revision tokens",
    },
    wait: { type: "boolean", description: "Wait for the verifier audit to finish" },
    interval: { type: "string", description: "Poll interval in seconds (default 5)" },
    timeout: { type: "string", description: "Timeout in minutes (default 45)" },
    full: { type: "boolean", description: "Include raw result when waiting" },
  },
  run: async ({ args }) => {
    const { client, problemId, version, versionId, versionNumber } = await resolveCommandContext(args);
    const [dynamic, isAdmin] = await Promise.all([
      client.query(api.runDynamicChecks.getDynamicChecks, { versionId }),
      client.query(api.admins.isCurrentUser, {}),
    ]);
    const checks: any = dynamic ?? {};
    if (!version.testPatch || !version.solutionPatch) {
      throw new Error("Verifier audit requires both test and solution patches");
    }
    if (!isAdmin && checks._verifierIncompletenessRunsEnabled !== true) {
      throw new Error("Verifier audit is not enabled for this contributor");
    }
    const verifySolution = checks.verifySolution;
    const solutionPassed =
      verifySolution?.status === "completed" &&
      verifySolution?.stale !== true &&
      String(verifySolution?.output?.verdict ?? "").toUpperCase() === "PASS";
    if (!isAdmin && !solutionPassed) {
      throw new Error("Verifier audit requires a fresh passing Verify Solution check");
    }
    const result: any = await client.action(api.runDynamicChecks.triggerDynamicCheck, {
      versionId,
      checkKey: "verifierIncompleteness",
      useGeneralTokens: args["use-general-tokens"] || undefined,
    });
    if (args.wait) {
      await waitForChecks({
        client,
        problemId,
        version,
        jobId: result?.jobId,
        requestedKeys: result?.jobId ? undefined : ["verifierIncompleteness"],
        intervalMs: parseWaitNumber(args.interval, 5, "--interval") * 1000,
        timeoutMs: parseWaitNumber(args.timeout, 45, "--timeout") * 60 * 1000,
        json: Boolean(args.json),
        full: Boolean(args.full),
      });
      return;
    }
    const waitCommand = result?.jobId
      ? `olympus checks wait ${problemId} --job=${result.jobId} --json`
      : `olympus checks wait ${problemId} --check=verifierIncompleteness --json`;
    if (args.json) return printJson({ ...result, waitCommand });
    console.log(`\n  Verifier completeness audit triggered on v${versionNumber}.`);
    console.log(`  Wait: ${waitCommand}\n`);
  },
});

const decide = defineCommand({
  meta: {
    name: "verifier-audit decide",
    description: "Accept, edit, or reject a proposed verifier patch",
  },
  args: {
    ...commonArgs,
    job: { type: "string", description: "Verifier audit job ID (default: current job)" },
    decision: {
      type: "string",
      description: "accepted, accepted_with_edits, or rejected",
      required: true,
    },
    "patch-file": {
      type: "string",
      description: "Final patch for accepted_with_edits (use - for stdin)",
    },
    comment: { type: "string", description: "Optional reviewer note" },
  },
  run: async ({ args }) => {
    const allowed = new Set(["accepted", "accepted_with_edits", "rejected"]);
    if (!allowed.has(args.decision)) {
      throw new Error("--decision must be accepted, accepted_with_edits, or rejected");
    }
    const finalPatch = readOptionalFile(args["patch-file"]);
    if (args.decision === "accepted_with_edits" && !finalPatch?.trim()) {
      throw new Error("accepted_with_edits requires --patch-file");
    }
    if (args.decision !== "accepted_with_edits" && finalPatch !== undefined) {
      throw new Error("--patch-file is only valid with accepted_with_edits");
    }
    const { client, versionId } = await resolveCommandContext(args);
    const dynamic: any = await client.query(api.runDynamicChecks.getDynamicChecks, {
      versionId,
    });
    const check = normalizeDynamicChecks(dynamic).verifierIncompleteness ?? null;
    const jobId = args.job ?? check?.jobId;
    if (!jobId) throw new Error("No verifier audit job exists on this version; pass --job explicitly");
    if (args.decision !== "rejected") {
      if (!check || check.jobId !== jobId) {
        throw new Error("Acceptance requires the current verifier audit job");
      }
      if (check.stale) throw new Error("Cannot accept a stale verifier audit; rerun it first");
      const validation = check.output?.patchValidation;
      if (validation?.appliesCleanly !== true) {
        throw new Error("Cannot accept a verifier patch that does not apply cleanly");
      }
    }
    const payload: Record<string, unknown> = {
      jobId,
      decision: args.decision,
      ...(finalPatch !== undefined ? { finalPatch } : {}),
      ...(args.comment?.trim() ? { comment: args.comment.trim() } : {}),
    };
    const result = await client.mutation(
      api.verifierIncompleteness.submitVerifierIncompletenessDecision,
      payload,
    );
    printResult(result ?? { submitted: true }, args.json);
  },
});

export default defineCommand({
  meta: { name: "verifier-audit", description: "Verifier completeness audit operations" },
  subCommands: { view, run, decide },
});
