import { defineCommand } from "citty";
import { api } from "../platform/convex.ts";
import { CliError } from "../shared/errors.ts";
import { type Json } from "../shared/types.ts";
import { printJson, printKeyValue, statusBadge, truncate } from "../terminal/format.ts";
import { commonArgs, resolveCommandContext } from "./command-utils.ts";

const CANDIDATE_SUMMARY_FIELDS = [
  "source",
  "problemId",
  "assessmentItemId",
  "title",
  "githubRepoUrl",
  "verdict",
  "confidence",
  "similarity",
  "isOlder",
  "evalStatus",
  "one_liner",
  "reason",
] as const;

function summarizeCandidate(candidate: Json): Json {
  return Object.fromEntries(
    CANDIDATE_SUMMARY_FIELDS.filter((key) => candidate[key] !== undefined).map((key) => [
      key,
      candidate[key],
    ]),
  );
}

function dedupeSummary(stage: Json, check: Json) {
  const details = check.details ?? {};
  return {
    status: String(check.status ?? "not_run").toLowerCase(),
    stageStatus: String(stage.status ?? "not_run").toLowerCase(),
    stale: stage.stale ?? null,
    overall: details.overall ?? null,
    skipped: details.skipped === true,
    reason: details.reason ?? null,
    message: check.message ?? null,
  };
}

function readDedupe(results: Json | null, full: boolean) {
  const stage = results?.plagiarism_review ?? {};
  const checks: Json[] = Array.isArray(stage.checks) ? stage.checks : [];
  const check = checks.find((entry) => entry.id === "llm_dedup") ?? {};
  const candidates: Json[] = Array.isArray(check.details?.perCandidate)
    ? check.details.perCandidate
    : [];
  return {
    ...dedupeSummary(stage, check),
    candidateCount: candidates.length,
    candidates: full ? candidates : candidates.map(summarizeCandidate),
    ...(full ? { stage: results?.plagiarism_review ?? null } : {}),
  };
}

function percent(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "unknown";
}

function printEvidence(label: string, values: unknown): void {
  if (!Array.isArray(values) || values.length === 0) return;
  console.log(`    ${label}:`);
  for (const value of values) console.log(`      - ${String(value)}`);
}

function printCandidate(candidate: Json, index: number, full: boolean): void {
  console.log(`\n  ${index + 1}. ${candidate.title ?? "Candidate"}`);
  printKeyValue([
    ["Verdict", candidate.verdict ?? "unknown"],
    ["Confidence", percent(candidate.confidence)],
    ["Similarity", percent(candidate.similarity)],
    ["Older", String(candidate.isOlder ?? "unknown")],
    ["Evaluation", candidate.evalStatus],
    ["Problem", candidate.problemId ?? candidate.assessmentItemId],
    ["Repository", candidate.githubRepoUrl],
  ]);
  if (candidate.one_liner) {
    const summary = String(candidate.one_liner);
    console.log(`    ${full ? summary : truncate(summary, 240)}`);
  }
  if (!full) return;
  if (candidate.reason) console.log(`    Reason: ${String(candidate.reason)}`);
  if (candidate.submission_summary)
    console.log(`    Submission: ${String(candidate.submission_summary)}`);
  printEvidence("Shared APIs", candidate.overlap?.shared_apis);
  printEvidence("Shared test behaviors", candidate.overlap?.shared_test_behaviors);
  printEvidence("Meaningful differences", candidate.meaningful_differences);
  printEvidence("Evidence gaps", candidate.evidence_gaps);
}

function printDedupe(result: ReturnType<typeof readDedupe>, full: boolean): void {
  printKeyValue([
    ["Status", statusBadge(result.status)],
    ["Stage status", statusBadge(result.stageStatus)],
    ["Overall", result.overall ?? "unavailable"],
    ["Stale", String(result.stale ?? "unknown")],
    ["Skipped", String(result.skipped)],
    ["Candidates", String(result.candidateCount)],
    ["Message", result.message],
    ["Skip reason", result.reason],
  ]);
  if (result.stale) console.log("\n  Stale: this analysis predates the current content.");
  if (result.status === "not_run") console.log("\n  No dedupe analysis exists for this version.");
  else if (result.skipped) console.log("\n  The dedupe analysis was skipped.");
  else if (result.candidateCount === 0) console.log("\n  No candidate analyses returned.");
  result.candidates.forEach((candidate, index) => printCandidate(candidate, index, full));
  if (!full && result.candidateCount > 0)
    console.log("\n  Use --full for overlap, meaningful differences, and evidence gaps.");
  console.log("");
}

export const dedupe = defineCommand({
  meta: {
    name: "dedupe",
    description: "View the existing AI dedupe analysis for a challenge version",
  },
  args: {
    ...commonArgs,
    full: {
      type: "boolean",
      description: "Include complete candidate details and raw dedupe stage",
    },
  },
  run: async ({ args }) => {
    const { client, problemId, versionId, versionNumber, version } =
      await resolveCommandContext(args);
    const results = await client.query(api.stages.getValidationResults, {
      itemId: problemId,
      versionId,
    });
    const analysis = readDedupe(results, Boolean(args.full));
    if (args.json)
      return printJson({
        problemId,
        versionId,
        version: versionNumber,
        githubRepoUrl: version.githubRepoUrl ?? null,
        ...analysis,
      });
    console.log(`\n  AI Dedupe Analysis for ${problemId} (v${versionNumber})\n`);
    printDedupe(analysis, Boolean(args.full));
  },
});

export const repoStatus = defineCommand({
  meta: {
    name: "repo-status",
    description: "View current repository submission counts and cap blocking status",
  },
  args: {
    ...commonArgs,
    repo: {
      type: "string",
      description: "GitHub repository URL (default: selected version's repo)",
    },
  },
  run: async ({ args }) => {
    const { client, problemId, versionId, versionNumber, version } =
      await resolveCommandContext(args);
    const githubRepoUrl = (args.repo ?? version.githubRepoUrl ?? "").trim();
    if (!githubRepoUrl)
      throw new CliError("No repository URL is set for this version. Supply --repo=<url>.", {
        kind: "usage",
        code: "repo_status.missing_repo",
        retryable: false,
        hint: "Use --repo=https://github.com/owner/repo or set the challenge's repository.",
      });
    const status = await client.query(api.problems.getRepoCapStatus, {
      problemId,
      githubRepoUrl,
    });
    if (status == null)
      throw new CliError("Repository submission counts are unavailable.", {
        kind: "not_found",
        code: "repo_status.unavailable",
        retryable: false,
      });
    const blocked = Boolean(status.blockedBy && !status.override);
    if (args.json)
      return printJson({
        problemId,
        versionId,
        version: versionNumber,
        githubRepoUrl,
        ...status,
        blocked,
      });
    console.log(`\n  Repository status for ${problemId} (v${versionNumber})\n`);
    printKeyValue([
      ["Repository", status.repoKey ?? githubRepoUrl],
      ["Your submissions", String(status.author ?? "unavailable")],
      ["All submissions", String(status.global ?? "unavailable")],
      ["Blocked", String(blocked)],
      ["Blocked by", status.blockedBy],
      ["Admin override", status.override ? "yes" : "no"],
      ["Same repo resubmit", String(status.sameRepoResubmit ?? "unknown")],
      ["Message", status.message],
    ]);
    console.log(
      "\n  Current counts used by repository caps; these count submissions, not unique people.\n",
    );
  },
});
