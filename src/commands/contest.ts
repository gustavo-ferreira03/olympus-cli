import { defineCommand } from "citty";
import { api } from "../convex.ts";
import {
  commonArgs,
  printResult,
  resolveCommandContext,
} from "../command-utils.ts";

function noteArgs(description: string) {
  return {
    ...commonArgs,
    note: { type: "string", description, required: true },
  } as const;
}

function requireNote(note: string): string {
  const value = note.trim();
  if (!value) throw new Error("--note must not be empty");
  return value;
}

const view = defineCommand({
  meta: { name: "contest view", description: "View contest state for quality checks" },
  args: commonArgs,
  run: async ({ args }) => {
    const { client, problemId, versionId } = await resolveCommandContext(args);
    const [dynamicChecks, description, taskQuality] = await Promise.all([
      client.query(api.runDynamicChecks.getDynamicChecks, { versionId }),
      client.query(api.systemComments.getDescriptionQualityContestStatus, {
        problemId,
        versionId,
      }),
      client.query(api.taskQualityContest.getTaskQualityContestStatus, { problemId }),
    ]);
    printResult({ dynamicChecks, description, taskQuality }, args.json);
  },
});

const description = defineCommand({
  meta: { name: "contest description", description: "Contest Description Quality" },
  args: commonArgs,
  run: async ({ args }) => {
    const { client, problemId, versionId } = await resolveCommandContext(args);
    const result = await client.mutation(api.systemComments.contestDescriptionQuality, {
      problemId,
      versionId,
    });
    printResult(result ?? { contested: true }, args.json);
  },
});

const fairness = defineCommand({
  meta: { name: "contest fairness", description: "Contest Test Quality / Verify Fairness" },
  args: noteArgs("Why the flagged tests are fair"),
  run: async ({ args }) => {
    const { client, problemId, versionId } = await resolveCommandContext(args);
    const result = await client.mutation(api.fairnessContest.contestVerifyFairness, {
      problemId,
      versionId,
      note: requireNote(args.note),
    });
    printResult(result ?? { contested: true }, args.json);
  },
});

const solution = defineCommand({
  meta: { name: "contest solution", description: "Contest Solution Quality" },
  args: noteArgs("Why the flagged issues are wrong or out of scope"),
  run: async ({ args }) => {
    const { client, problemId, versionId } = await resolveCommandContext(args);
    const result = await client.mutation(api.solutionQualityContest.contestSolutionQuality, {
      problemId,
      versionId,
      note: requireNote(args.note),
    });
    printResult(result ?? { contested: true }, args.json);
  },
});

const taskAsMars = defineCommand({
  meta: {
    name: "contest task-as-mars",
    description: "Evaluate Task Quality under the Mars rubric",
  },
  args: {
    ...commonArgs,
    "use-general-tokens": {
      type: "boolean",
      description: "Charge general tokens instead of revision tokens",
    },
  },
  run: async ({ args }) => {
    const { client, problemId, versionId } = await resolveCommandContext(args);
    try {
      await client.mutation(api.taskQualityContest.contestTaskQualityAsMars, {
        problemId,
        versionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ALREADY_MARS|already evaluated against the Mars rubric/i.test(message)) {
        throw error;
      }
    }
    const result = await client.action(api.runDynamicChecks.triggerDynamicCheck, {
      versionId,
      checkKey: "taskQuality",
      useGeneralTokens: args["use-general-tokens"] || undefined,
    });
    printResult(result ?? { triggered: "taskQuality" }, args.json);
  },
});

export default defineCommand({
  meta: { name: "contest", description: "Contest quality-check verdicts" },
  subCommands: { view, description, fairness, solution, "task-as-mars": taskAsMars },
});
