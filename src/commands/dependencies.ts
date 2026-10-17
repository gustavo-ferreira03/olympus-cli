import { defineCommand } from "citty";
import { nativeDependencyCatalog, inspectNativeDependencies } from "../core/native-dependencies.ts";
import {
  commonArgs,
  printResult,
  resolveCommandContext,
  readOptionalFile,
} from "./command-utils.ts";
import { toPublicCheckKey } from "../core/expected.ts";

export default defineCommand({
  meta: {
    name: "dependencies",
    description: "Inspect native operational prerequisites, independently of policy",
  },
  subCommands: {
    catalog: defineCommand({
      meta: {
        name: "dependencies catalog",
        description: "List known challenge-stage dependencies (no authentication required)",
      },
      args: { json: { type: "boolean", description: "Output JSON" } },
      run: ({ args }) => printResult(nativeDependencyCatalog(), args.json),
    }),
    view: defineCommand({
      meta: {
        name: "dependencies view",
        description: "Read native eligibility without dispatching any action",
      },
      args: {
        ...commonArgs,
        action: {
          type: "string",
          description: "Action from dependencies catalog; omit to inspect all",
        },
        checks: {
          type: "string",
          description: "Explicit comma-separated checks for checks.run_all",
        },
        decision: {
          type: "string",
          description: "Verifier decision: accepted, accepted_with_edits, rejected",
        },
        job: { type: "string", description: "Verifier audit job ID" },
        "patch-file": { type: "string", description: "Final patch for accepted_with_edits" },
      },
      run: async ({ args }) => {
        const actions = args.action
          ? [args.action]
          : nativeDependencyCatalog().actions.map((item) => item.action);
        const { client, problemId, versionId } = await resolveCommandContext(args);
        const snapshot = await inspectNativeDependencies(client, problemId, actions, {
          versionId,
          checkKeys: args.checks
            ?.split(",")
            .map((key) => toPublicCheckKey(key.trim()))
            .filter(Boolean),
          decision: args.decision,
          jobId: args.job,
          finalPatch: readOptionalFile(args["patch-file"]),
        });
        const result = { ...snapshot, readOnly: true, notice: nativeDependencyCatalog().semantics };
        if (args.json) return printResult(result, true);
        console.log(`\n  Native dependencies: ${problemId}`);
        for (const report of snapshot.reports) {
          console.log(`  ${report.action}: ${report.status}`);
          for (const requirement of report.requirements.filter(
            (item) => item.status !== "satisfied",
          )) {
            console.log(`    ${requirement.status} ${requirement.id}: ${requirement.reason}`);
            if (requirement.command) console.log(`      Inspect/repair: ${requirement.command}`);
          }
        }
        console.log(`\n  ${result.notice}\n`);
      },
    }),
  },
});
