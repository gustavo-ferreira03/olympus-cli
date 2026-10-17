import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError } from "../shared/errors.ts";
import { defineCommand } from "citty";
import {
  api,
  asId,
  getClient,
  parseVersionNumber,
  requireProblemVersion,
  resolveProblemVersion,
} from "../platform/convex.ts";
import { queryPrecheckStages } from "../platform/prechecks.ts";
import { printJson, printKeyValue, printTable, statusBadge, truncate } from "../terminal/format.ts";
import { omitEmpty } from "../terminal/output.ts";
import {
  formatDynamicCheckLabel,
  formatRunLabel,
  getDynamicCheckEntries,
  groupRunsByBatch,
  normalizeAgentRuns,
} from "../core/model.ts";
import { type SubmissionReadiness } from "../core/model.ts";
import {
  type CriteriaReport,
  type Problem,
  type ProblemVersion,
  type Review,
} from "../shared/types.ts";
import {
  assertFileWithinLimit,
  clampResultLimit,
  formatBytes,
  MAX_INPUT_FILE_BYTES,
  MAX_STDIN_BYTES,
} from "../shared/limits.ts";

const DEFAULT_LIMIT = 30;
function printReadiness(readiness: SubmissionReadiness | null | undefined): void {
  if (!readiness) return;
  console.log("\n  Submission Readiness:");
  for (const criterion of readiness.criteria) {
    const detail = criterion.detail ? `  ${criterion.detail}` : "";
    const stale = criterion.stale ? " \x1b[33m(stale)\x1b[0m" : "";
    console.log(`    ${statusBadge(criterion.status)}  ${criterion.label}${detail}${stale}`);
  }
  if (readiness.bypassNote) {
    console.log(`    \x1b[33mBypass: ${truncate(readiness.bypassNote, 90)}\x1b[0m`);
  }
}
function printPrechecks(stages: unknown): void {
  const stageList = Array.isArray(stages) ? stages : [];
  if (stageList.length === 0) return;
  console.log("\n  Prechecks:");
  for (const stage of stageList) {
    console.log(`    ${statusBadge(stage.status)}  ${stage.stageName ?? stage.stageId}`);
    const checks = Array.isArray(stage.checks) ? stage.checks : [];
    for (const check of checks) {
      const message = check.message ? `  ${truncate(String(check.message), 70)}` : "";
      console.log(`      ${statusBadge(check.status)}  ${check.name ?? check.key}${message}`);
    }
  }
}
function printQualityChecks(dynamicChecks: unknown): void {
  const checks = getDynamicCheckEntries(dynamicChecks);
  if (checks.length === 0) return;
  console.log("\n  Quality Checks:");
  for (const check of checks) {
    const verdict = check.output?.verdict ?? check.output?.evaluation?.verdict;
    const summary =
      check.output?.message ?? check.output?.summary ?? check.output?.evaluation?.summary;
    const stale = check.stale ? " \x1b[33m(stale)\x1b[0m" : "";
    const contested = check.contested ? " \x1b[33m(contested)\x1b[0m" : "";
    console.log(
      `    ${statusBadge(check.status)}  ${formatDynamicCheckLabel(check.key)} (${check.key})${verdict ? ` [${verdict}]` : ""}${summary ? `  ${truncate(summary, 70)}` : ""}${stale}${contested}`,
    );
  }
}
function printRunCriteria(criteria: CriteriaReport): void {
  const criteriaList = criteria?.criteria;
  if (!criteriaList || criteriaList.length === 0) return;
  console.log("\n  Rollout Criteria:");
  for (const criterion of criteriaList) {
    const detail = criterion.detail ? `  ${criterion.detail}` : "";
    const preview = criterion.preview ? " \x1b[90m(preview)\x1b[0m" : "";
    console.log(
      `    ${statusBadge(criterion.status ?? "pending")}  ${criterion.label}${detail}${preview}`,
    );
    if (criterion.description) {
      console.log(`      \x1b[90mTarget: ${criterion.description}\x1b[0m`);
    }
    if (criterion.guidance) {
      console.log(`      \x1b[33m${truncate(String(criterion.guidance), 100)}\x1b[0m`);
    }
  }
}
function printRollouts(runs: unknown): void {
  const normalizedRuns = normalizeAgentRuns(runs);
  if (normalizedRuns.length === 0) {
    console.log("\n  Rollouts:\n    \x1b[90mNo rollouts yet.\x1b[0m");
    return;
  }
  console.log("\n  Rollouts:");
  for (const group of groupRunsByBatch(normalizedRuns)) {
    const active = group.runs.filter(
      (run) => run.status === "pending" || run.status === "running",
    ).length;
    const stale = group.staleOnly ? " \x1b[33m(all stale)\x1b[0m" : "";
    const hinted = group.hinted ? " \x1b[90m(hinted)\x1b[0m" : "";
    console.log(`    ${group.name}${hinted}${stale}`);
    console.log(
      `      \x1b[90m${group.runs.length} run${group.runs.length === 1 ? "" : "s"} · ${active} active · ${group.runPhase ?? "unknown"}\x1b[0m`,
    );
    for (const run of group.runs) {
      const verdict = run.output?.verdict ? ` [${String(run.output.verdict)}]` : "";
      const scratched = run.scratched ? " \x1b[90m(scratched)\x1b[0m" : "";
      const runStale = run.stale && !group.staleOnly ? " \x1b[33m(stale)\x1b[0m" : "";
      console.log(
        `      ${statusBadge(run.status)}  ${formatRunLabel(run)}${verdict}${scratched}${runStale}`,
      );
    }
  }
}
function printReviews(reviews: Review[] | unknown): void {
  const list = Array.isArray(reviews) ? reviews : [];
  if (list.length === 0) return;
  console.log("\n  Reviews:");
  for (const review of list) {
    const date = review.submittedAt ? new Date(review.submittedAt).toLocaleDateString() : "";
    const reviewer = review.reviewerName ?? "Unknown";
    const outcome = review.outcome ? statusBadge(review.outcome) : "\x1b[90m○ pending\x1b[0m";
    const version = review.versionNumber == null ? "" : ` (v${review.versionNumber})`;
    console.log(`    ${outcome}  by ${reviewer}${version}  ${date}`);
    if (review.feedback) {
      console.log(`      ${truncate(String(review.feedback), 90)}`);
    }
  }
}
/**
 * Read the contents of a `--*-file` flag, or stdin when the value is `-`.
 *
 * @throws Error when the file (or piped payload) exceeds
 *   {@link MAX_INPUT_FILE_BYTES}, so an accidental huge path fails here rather
 *   than as an opaque upload error.
 */
function readFileArg(path: string): string {
  if (path === "-") {
    const piped = readFileSync(0, "utf-8");
    if (Buffer.byteLength(piped, "utf-8") > MAX_STDIN_BYTES) {
      throw new Error(
        `Piped input is too large: it exceeds the ${formatBytes(MAX_STDIN_BYTES)} limit`,
      );
    }
    return piped;
  }
  assertFileWithinLimit(path, MAX_INPUT_FILE_BYTES, "Input file");
  return readFileSync(path, "utf-8");
}
function writeOptionalFile(directory: string, filename: string, contents: unknown): boolean {
  if (typeof contents !== "string" || contents.length === 0) return false;
  writeFileSync(join(directory, filename), contents.endsWith("\n") ? contents : `${contents}\n`);
  return true;
}
function ensureDownloadDirectory(directory: string, force: boolean): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
    return;
  }
  const entries = readdirSync(directory);
  if (entries.length > 0 && !force) {
    throw new CliError(`Refusing to write into non-empty directory: ${directory}`, {
      kind: "usage",
      code: "input.directory_not_empty",
      retryable: false,
      hint: "Re-run with --force or choose --out <dir>.",
    });
  }
}
function buildDownloadMetadata(problem: Problem, version: ProblemVersion) {
  return {
    problemId: String(problem._id),
    title: problem.title,
    status: problem.status,
    version: version.version,
    versionId: String(version._id),
    isLocked: !!version.isLocked,
    language: version.language ?? problem.language ?? null,
    difficulty: version.difficulty ?? problem.difficulty ?? null,
    category: version.category ?? problem.category ?? null,
    repoUrl: version.githubRepoUrl ?? problem.githubRepoUrl ?? null,
    commitHash: version.githubCommitHash ?? problem.githubCommitHash ?? null,
    githubIssueUrl: version.githubIssueUrl ?? null,
    estimatedLOC: version.estimatedLOC ?? problem.estimatedLOC ?? null,
    testOutputMode: version.testOutputMode ?? null,
    downloadedAt: new Date().toISOString(),
  };
}
function inferRepoDirName(repoUrl: string | undefined | null): string {
  if (!repoUrl) return "repo";
  const trimmed = repoUrl.trim().replace(/\/+$/, "");
  const lastSegment = trimmed.split(/[/:]/).pop() ?? "repo";
  const cleaned = lastSegment.replace(/\.git$/i, "") || "repo";
  return cleaned;
}
function makeShellArgument(value: unknown): string {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) {
    throw new Error("Cannot generate Makefile: metadata contains a line break or NUL byte");
  }
  const quoted = `'${text.replaceAll("'", "'\"'\"'")}'`;
  return quoted
    .replaceAll("$", "$$$$")
    .replaceAll(/(\\*)#/g, (_, slashes) => `${slashes + slashes}\\#`);
}
function buildMakefile(problem: Problem, version: ProblemVersion): string {
  const metadata = buildDownloadMetadata(problem, version);
  const repoUrl = metadata.repoUrl ?? "";
  const commitHash = metadata.commitHash ?? "";
  if (String(commitHash).startsWith("-")) {
    throw new Error("Cannot generate Makefile: commit must not start with a dash");
  }
  const repoDir = `./${inferRepoDirName(metadata.repoUrl)}`;
  return `PROBLEM_ID := ${makeShellArgument(metadata.problemId)}
VERSION := ${makeShellArgument(metadata.version)}
REPO_URL := ${makeShellArgument(repoUrl)}
COMMIT := ${makeShellArgument(commitHash)}
IMAGE_TAG := ${makeShellArgument(`olympus-${metadata.problemId}-v${metadata.version}`)}
REPO_DIR := ${makeShellArgument(repoDir)}

.PHONY: help clone checkout apply-test-patch apply-solution-patch build-image

help:
	@echo "clone                Clone the source repo recursively and checkout the challenge commit"
	@echo "checkout             Re-checkout the challenge commit inside ./repo"
	@echo "apply-test-patch     Apply test.patch onto ./repo if present"
	@echo "apply-solution-patch Apply solution.patch onto ./repo if present"
	@echo "build-image          Build from the checked-out repo context on linux/amd64"

clone:
	@if [ -z $(REPO_URL) ]; then echo "REPO_URL is empty"; exit 1; fi
	@if [ -z $(COMMIT) ]; then echo "COMMIT is empty"; exit 1; fi
	@if [ ! -d $(REPO_DIR)/.git ]; then git clone --recursive -- $(REPO_URL) $(REPO_DIR); else printf 'repo already exists at %s\\n' $(REPO_DIR); fi
	@cd $(REPO_DIR) && git fetch --all --tags && git checkout $(COMMIT) -- && git submodule update --init --recursive

checkout:
	@if [ -z $(COMMIT) ]; then echo "COMMIT is empty"; exit 1; fi
	@if [ ! -d $(REPO_DIR)/.git ]; then printf 'repo not present at %s; run make clone\\n' $(REPO_DIR); exit 1; fi
	@cd $(REPO_DIR) && git fetch --all --tags && git checkout $(COMMIT) -- && git submodule update --init --recursive

apply-test-patch: checkout
	@if [ -f test.patch ]; then cd $(REPO_DIR) && git apply ../test.patch; else echo "test.patch not present"; fi

apply-solution-patch: checkout
	@if [ -f solution.patch ]; then cd $(REPO_DIR) && git apply ../solution.patch; else echo "solution.patch not present"; fi

build-image: checkout
	@if [ ! -f Dockerfile ]; then echo "Dockerfile not present"; exit 1; fi
	@cd $(REPO_DIR) && rm -f .dockerignore && docker build --platform linux/amd64 -f ../Dockerfile -t $(IMAGE_TAG) .
`;
}
const create = defineCommand({
  meta: { name: "problems create", description: "Create a new challenge draft" },
  args: {
    title: { type: "string", description: "Initial title" },
    description: { type: "string", description: "Initial description" },
    repo: { type: "string", description: "GitHub repository URL" },
    commit: { type: "string", description: "GitHub commit hash" },
    language: { type: "string", description: "Language" },
    category: { type: "string", description: "Category" },
    difficulty: { type: "string", description: "Difficulty" },
    "estimated-loc": { type: "string", description: "Estimated solution LOC" },
    diamond: { type: "boolean", description: "Create a Diamond challenge draft" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const estimatedLOC = args["estimated-loc"]
      ? Number.parseInt(args["estimated-loc"], 10)
      : undefined;
    const fields = Object.fromEntries(
      Object.entries({
        title: args.title,
        description: args.description,
        githubRepoUrl: args.repo,
        githubCommitHash: args.commit,
        language: args.language,
        category: args.category,
        difficulty: args.difficulty,
        estimatedLOC: Number.isFinite(estimatedLOC) ? estimatedLOC : undefined,
      }).filter(([, value]) => value !== undefined),
    );
    // The platform creates empty drafts and fills them through updateDraft.
    const result = await client.mutation(
      args.diamond ? api.problems.createDiamondDraft : api.problems.createDraft,
      {},
    );
    if (Object.keys(fields).length > 0) {
      try {
        await client.mutation(api.problems.updateDraft, { problemId: result.problemId, ...fields });
      } catch (error) {
        throw new CliError(
          `Created challenge draft ${result.problemId}, but setting its fields failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            kind: "unknown",
            code: "draft.update_failed",
            retryable: true,
            hint: `Retry with: olympus problems edit ${result.problemId} --title ...`,
          },
        );
      }
    }
    if (args.json) {
      printJson(result);
      return;
    }
    console.log(`\n  Created ${args.diamond ? "Diamond " : ""}challenge draft ${result.problemId}`);
    console.log(`  Run: olympus problems view ${result.problemId}\n`);
  },
});
const mine = defineCommand({
  meta: { name: "problems mine", description: "List your submitted challenges" },
  args: {
    status: { type: "string", description: "Filter by status" },
    limit: { type: "string", description: `Max results (default ${DEFAULT_LIMIT})` },
    archived: { type: "boolean", description: "Include archived challenges" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const limit = clampResultLimit(args.limit, DEFAULT_LIMIT);
    const queryArgs: Record<string, unknown> = {};
    if (args.status) queryArgs.status = args.status;
    const listed = await client.query(api.problems.listByUser, queryArgs);
    const problems = Array.isArray(listed)
      ? listed.filter((problem: Problem) => args.archived || !(problem as any).archived)
      : listed;
    if (!problems || problems.length === 0) {
      if (args.json) {
        printJson([]);
        return;
      }
      console.log("  No challenges found.");
      return;
    }
    problems.sort((a: Problem, b: Problem) => (b._creationTime ?? 0) - (a._creationTime ?? 0));
    const display = problems.slice(0, limit);
    if (args.json) {
      printJson(display);
      return;
    }
    printTable(
      display.map((problem: Problem) => ({
        id: String(problem._id),
        title:
          (problem.title?.length ?? 0) > 50
            ? `${problem.title.slice(0, 47)}...`
            : (problem.title ?? ""),
        status: statusBadge(problem.status ?? "unknown"),
        lang: problem.language ?? "",
        diff: problem.difficulty ?? "",
      })),
      [
        { key: "id", label: "ID" },
        { key: "title", label: "Title", width: 52 },
        { key: "status", label: "Status", width: 24 },
        { key: "lang", label: "Lang", width: 12 },
        { key: "diff", label: "Diff", width: 8 },
      ],
    );
  },
});
const view = defineCommand({
  meta: { name: "problems view", description: "View challenge details" },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    fields: {
      type: "string",
      description: "Compact fields: metadata,artifacts,readiness,description",
    },
    full: {
      type: "boolean",
      description: "Include complete checks, runs, reviews, and version payload",
    },
    json: { type: "boolean", description: "Output compact JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const data = await client.query(api.problems.getWithLatestVersion, {
      problemId: asId(args.id),
    });
    if (!data) {
      throw new CliError(`Challenge not found: ${args.id}`, {
        kind: "not_found",
        code: "resource.not_found",
        retryable: false,
        hint: "Verify the challenge ID with olympus problems mine.",
      });
    }
    const latestVersion = data.latestVersion;
    if (args.json && !args.full) {
      const requested = new Set(
        (args.fields ?? "metadata,artifacts,readiness")
          .split(",")
          .map((field) => field.trim())
          .filter(Boolean),
      );
      const allowed = new Set(["metadata", "artifacts", "readiness", "description"]);
      const unknown = [...requested].filter((field) => !allowed.has(field));
      if (unknown.length > 0) throw new Error(`Unknown --fields: ${unknown.join(", ")}`);
      const readiness = requested.has("readiness")
        ? await client
            .query(api.submissionReadiness.getSubmissionReadiness, {
              problemId: asId(args.id),
            })
            .catch(() => null)
        : null;
      const result: Record<string, unknown> = {
        id: String(data._id),
        title: data.title,
        status: data.status,
        version: latestVersion?.version,
      };
      if (requested.has("metadata")) {
        result.metadata = omitEmpty({
          locked: latestVersion?.isLocked,
          reviewState: latestVersion?.reviewState,
          language: latestVersion?.language ?? data.language,
          difficulty: latestVersion?.difficulty ?? data.difficulty,
          category: latestVersion?.category ?? data.category,
          repository: latestVersion?.githubRepoUrl,
          commit: latestVersion?.githubCommitHash,
        });
      }
      if (requested.has("artifacts")) {
        result.artifacts = {
          description: Boolean(latestVersion?.description),
          testPatch: Boolean(latestVersion?.testPatch),
          solutionPatch: Boolean(latestVersion?.solutionPatch),
          dockerfile: Boolean(latestVersion?.dockerfile),
          solutionApproach: Boolean(latestVersion?.solutionApproach),
        };
      }
      if (requested.has("description")) result.description = latestVersion?.description;
      if (requested.has("readiness")) {
        result.readiness = omitEmpty({
          canSubmit: readiness?.canSubmit,
          bypassed: readiness?.isBypassed,
          blockers: readiness?.criteria
            ?.filter((criterion: any) => !["pass", "warn"].includes(criterion.status))
            .map((criterion: any) => ({
              id: criterion.id,
              label: criterion.label,
              status: criterion.status,
              detail: criterion.detail,
              stale: criterion.stale,
            })),
        });
      }
      result.nextCommands = {
        checks: `olympus checks view ${args.id} --json`,
        runs: `olympus runs view ${args.id} --json`,
        full: `olympus problems view ${args.id} --json --full`,
      };
      printJson(omitEmpty(result));
      return;
    }
    const [stages, dynamicChecks, runs, criteria, readiness, reviews] = latestVersion
      ? await Promise.all([
          queryPrecheckStages(client, {
            problemId: asId(args.id),
            versionId: latestVersion._id,
          }).catch(() => []),
          client
            .query(api.runDynamicChecks.getDynamicChecks, { versionId: latestVersion._id })
            .catch(() => null),
          client
            .query(api.runAgentRuns.getAgentRuns, { versionId: latestVersion._id })
            .catch(() => null),
          client
            .query(api.runAgentRuns.getAgentRunCriteria, { versionId: latestVersion._id })
            .catch(() => null),
          client
            .query(api.submissionReadiness.getSubmissionReadiness, {
              problemId: asId(args.id),
            })
            .catch(() => null),
          client.query(api.reviews.getReviewHistory, { problemId: asId(args.id) }).catch(() => []),
        ])
      : [[], null, null, null, null, []];
    if (args.json) {
      printJson({
        ...data,
        checks: { stages, dynamicChecks, readiness },
        runs: { agentRuns: runs, criteria },
        reviews,
      });
      return;
    }
    console.log("");
    printKeyValue([
      ["ID", String(data._id)],
      ["Title", data.title],
      ["Status", statusBadge(data.status)],
      [
        "Version",
        latestVersion
          ? `v${latestVersion.version}${latestVersion.isLocked ? " (locked)" : " (unlocked)"}`
          : "none",
      ],
      ["Language", latestVersion?.language ?? data.language],
      ["Difficulty", latestVersion?.difficulty ?? data.difficulty],
      ["Category", latestVersion?.category ?? data.category],
      ["Repo", latestVersion?.githubRepoUrl],
      ["Commit", latestVersion?.githubCommitHash?.slice(0, 8)],
      ["Test Patch", latestVersion?.testPatch ? "yes" : "no"],
      ["Solution", latestVersion?.solutionPatch ? "yes" : "no"],
      ["Dockerfile", latestVersion?.dockerfile ? "yes" : "no"],
    ]);
    if (latestVersion?.description) {
      const description = latestVersion.description
        .split("\n")
        .map((line: string) => `    ${line}`)
        .join("\n");
      console.log(`\n  Description:\n${description}`);
    }
    printReadiness(readiness);
    printPrechecks(stages);
    printQualityChecks(dynamicChecks);
    printRollouts(runs);
    printRunCriteria(criteria);
    printReviews(reviews);
    console.log("\n  Commands:");
    console.log(
      `    olympus problems download ${args.id}        Download the current version locally`,
    );
    console.log(`    olympus checks view ${args.id}              Checks + readiness detail`);
    console.log(
      `    olympus checks run-all ${args.id}           Run the default quality-check set`,
    );
    console.log(`    olympus runs view ${args.id}                Rollout batches + criteria`);
    console.log(`    olympus runs presets ${args.id}             Show quick/full rollout mixes`);
    console.log(
      `    olympus runs run ${args.id} --preset full   Trigger the production full rollout preset`,
    );
    console.log(`    olympus problems edit ${args.id} --help     Edit draft fields`);
    console.log(`    olympus problems version list ${args.id}    List all versions`);
    console.log("");
  },
});
const download = defineCommand({
  meta: {
    name: "problems download",
    description: "Download the current challenge version into a local folder",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    out: { type: "string", description: "Output directory (default: ./olympus-<id>-v<version>)" },
    force: { type: "boolean", description: "Allow writing into an existing non-empty directory" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const data = await client.query(api.problems.getWithLatestVersion, {
      problemId: asId(args.id),
    });
    if (!data) {
      throw new CliError(`Challenge not found: ${args.id}`, {
        kind: "not_found",
        code: "resource.not_found",
        retryable: false,
        hint: "Verify the challenge ID with olympus problems mine.",
      });
    }
    const latestVersion = data.latestVersion;
    if (!latestVersion) {
      throw new CliError("No version found.", {
        kind: "not_found",
        code: "resource.not_found",
        retryable: false,
        hint: "Verify that the challenge has a version.",
      });
    }
    const outDir = resolve(args.out ?? `olympus-${String(data._id)}-v${latestVersion.version}`);
    ensureDownloadDirectory(outDir, !!args.force);
    const writtenFiles: string[] = [];
    writeFileSync(join(outDir, "task.md"), latestVersion.description ?? "");
    writtenFiles.push("task.md");
    const writeTracked = (filename: string, contents: unknown) => {
      if (writeOptionalFile(outDir, filename, contents)) writtenFiles.push(filename);
    };
    writeTracked("Dockerfile", latestVersion.dockerfile);
    writeTracked("test.patch", latestVersion.testPatch);
    writeTracked("solution.patch", latestVersion.solutionPatch);
    writeTracked("solution-approach.md", latestVersion.solutionApproach);
    writeFileSync(
      join(outDir, "metadata.json"),
      `${JSON.stringify(buildDownloadMetadata(data, latestVersion), null, 2)}\n`,
    );
    writtenFiles.push("metadata.json");
    writeFileSync(join(outDir, "Makefile"), buildMakefile(data, latestVersion));
    writtenFiles.push("Makefile");
    if (args.json) {
      printJson({
        problemId: String(data._id),
        version: latestVersion.version,
        directory: outDir,
        files: writtenFiles,
      });
      return;
    }
    console.log(`\n  Downloaded ${args.id} v${latestVersion.version} to ${outDir}`);
    for (const file of writtenFiles) {
      console.log(`    - ${file}`);
    }
    console.log("\n  Commands:");
    console.log(`    cd ${outDir}`);
    console.log("    make clone");
    console.log("    make build-image");
    console.log("");
  },
});
// The dashboard moved from the fetchAll action to the paginated fetchPage query.
async function fetchDashboardRows(client: any, status: string | undefined): Promise<Problem[]> {
  try {
    const rows: Problem[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: any = await client.query(api.problemDashboard.fetchPage, {
        ...(status ? { statuses: [status] } : {}),
        paginationOpts: { numItems: 100, cursor },
      });
      rows.push(...(page?.page ?? []));
      if (page?.isDone !== false || !page?.continueCursor) return rows;
      cursor = page.continueCursor;
    }
  } catch (pageError) {
    let rows: Problem[];
    try {
      rows = await client.action(api.problemDashboard.fetchAll, {});
    } catch {
      throw pageError;
    }
    return status ? rows.filter((problem) => problem.status === status) : rows;
  }
}
const dump = defineCommand({
  meta: { name: "problems dump", description: "Export many challenges as JSON" },
  args: {
    status: { type: "string", description: "Filter by status" },
    out: { type: "string", description: "Output file (default: olympus-dump-<date>.json)" },
    stdout: { type: "boolean", description: "Print to stdout instead of writing a file" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    console.log("  Fetching submissions (this may take a moment)...");
    const problems = await fetchDashboardRows(client, args.status);
    if (!problems || problems.length === 0) {
      console.log("  No submissions found.");
      return;
    }
    const json = JSON.stringify(problems, null, 2);
    if (args.stdout) {
      console.log(json);
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    const outPath = args.out ?? `olympus-dump-${date}.json`;
    writeFileSync(outPath, `${json}\n`);
    console.log(`  Wrote ${problems.length} submissions to ${outPath}`);
  },
});
const edit = defineCommand({
  meta: { name: "problems edit", description: "Edit a challenge draft" },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    title: { type: "string", description: "Set title" },
    description: { type: "string", description: "Set description" },
    "description-file": {
      type: "string",
      description: "Read description from file (use - for stdin)",
    },
    repo: { type: "string", description: "Set GitHub repo URL" },
    commit: { type: "string", description: "Set GitHub commit hash" },
    language: { type: "string", description: "Set language" },
    category: { type: "string", description: "Set category" },
    difficulty: { type: "string", description: "Set difficulty" },
    "test-patch": { type: "string", description: "Read test patch from file (use - for stdin)" },
    "solution-patch": {
      type: "string",
      description: "Read solution patch from file (use - for stdin)",
    },
    "solution-approach-file": {
      type: "string",
      description: "Read solution approach from file (use - for stdin)",
    },
    "environment-description-file": {
      type: "string",
      description: "Read environment description from file (use - for stdin)",
    },
    dockerfile: { type: "string", description: "Read Dockerfile from file (use - for stdin)" },
    "github-issue-url": { type: "string", description: "Set GitHub issue URL" },
    "replace-rolled-out": {
      type: "boolean",
      description:
        "Replace artifacts of a version that already has completed rollouts (normally open a new version)",
    },
    json: { type: "boolean", description: "Output result as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const updates: Record<string, unknown> = {};
    if (args.title !== undefined) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args["description-file"] !== undefined)
      updates.description = readFileArg(args["description-file"]);
    if (args.repo !== undefined) updates.githubRepoUrl = args.repo;
    if (args.commit !== undefined) updates.githubCommitHash = args.commit;
    if (args.language !== undefined) updates.language = args.language;
    if (args.category !== undefined) updates.category = args.category;
    if (args.difficulty !== undefined) updates.difficulty = args.difficulty;
    if (args["test-patch"] !== undefined) updates.testPatch = readFileArg(args["test-patch"]);
    if (args["solution-patch"] !== undefined)
      updates.solutionPatch = readFileArg(args["solution-patch"]);
    if (args["solution-approach-file"] !== undefined)
      updates.solutionApproach = readFileArg(args["solution-approach-file"]);
    if (args["environment-description-file"] !== undefined)
      updates.environmentDescription = readFileArg(args["environment-description-file"]);
    if (args.dockerfile !== undefined) updates.dockerfile = readFileArg(args.dockerfile);
    if (args["github-issue-url"] !== undefined) updates.githubIssueUrl = args["github-issue-url"];
    if (Object.keys(updates).length === 0) {
      throw new CliError("No fields to update. Use flags like --title or --test-patch <file>.", {
        kind: "usage",
        code: "input.missing_update",
        retryable: false,
        hint: "Run: olympus problems edit --help",
      });
    }
    // A version with completed rollouts keeps its rolled-out contract as history: replacing its artifacts
    // orphans its runs. Its correction belongs in a successor derived from it.
    const artifactFields = ["description", "testPatch", "solutionPatch", "dockerfile"];
    if (!args["replace-rolled-out"] && artifactFields.some((field) => field in updates)) {
      const { version } = await requireProblemVersion(client, args.id);
      const runs = normalizeAgentRuns(
        await client.query(api.runAgentRuns.getAgentRuns, { versionId: version._id }),
      );
      // Runs carry no version; one created after this version opened belongs to it.
      const opened = Number((version as any)._creationTime ?? 0);
      const completed = runs.filter(
        (run) => run.status === "completed" && (run.createdAt ?? 0) >= opened,
      );
      if (completed.length > 0)
        throw new CliError(
          `Version v${version.version} already has ${completed.length} completed rollout(s); open a new version before changing its artifacts.`,
          {
            kind: "usage",
            code: "version.rolled_out",
            retryable: false,
            hint: `Lock v${version.version} if needed (olympus problems lock ${args.id}), then olympus problems version create ${args.id} --from ${version.version}, and upload to the new version.`,
          },
        );
    }
    const result = await client.mutation(api.problems.updateDraft, {
      problemId: asId(args.id),
      ...updates,
    });
    if (args.json) {
      printJson(result);
      return;
    }
    console.log(`\n  Updated ${Object.keys(updates).join(", ")} on ${args.id}`);
    console.log(`  Run: olympus problems view ${args.id}\n`);
  },
});
const version = defineCommand({
  meta: { name: "problems version", description: "Manage challenge versions" },
  subCommands: {
    create: defineCommand({
      meta: {
        name: "problems version create",
        description: "Create an editable version from any existing version",
      },
      args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        from: { type: "string", description: "Source version number (default: latest)" },
        json: { type: "boolean", description: "Output as JSON" },
      },
      run: async ({ args }) => {
        const client = await getClient();
        const { version: sourceVersion } = await resolveProblemVersion(
          client,
          args.id,
          parseVersionNumber(args.from),
        );
        const result = await client.mutation(api.problems.createVersionFromPrevious, {
          problemId: asId(args.id),
          versionId: sourceVersion._id,
        });
        if (args.json) return printJson(result);
        console.log(`\n  Created new version from v${sourceVersion.version} on ${args.id}.\n`);
      },
    }),
    list: defineCommand({
      meta: { name: "problems version list", description: "List all versions of a challenge" },
      args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        json: { type: "boolean", description: "Output as JSON" },
      },
      run: async ({ args }) => {
        const client = await getClient();
        const versions = await client.query(api.problems.listVersions, {
          problemId: asId(args.id),
        });
        if (args.json) return printJson(versions);
        const list = Array.isArray(versions) ? versions : [];
        if (list.length === 0) {
          console.log("  No versions found.");
          return;
        }
        console.log("");
        for (const item of list) {
          const locked = item.isLocked ? " \x1b[33m(locked)\x1b[0m" : "";
          const state = item.reviewState ? ` ${item.reviewState}` : "";
          const date = new Date(item.createdAt ?? item._creationTime).toLocaleDateString();
          console.log(`  v${item.version}${locked}${state}  ${date}`);
        }
        console.log("");
      },
    }),
    view: defineCommand({
      meta: { name: "problems version view", description: "View a specific challenge version" },
      args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        version: { type: "string", description: "Version number", required: true },
        json: { type: "boolean", description: "Output as JSON" },
      },
      run: async ({ args }) => {
        const client = await getClient();
        const result = await client.query(api.problemVersions.getByVersion, {
          problemId: asId(args.id),
          version: parseVersionNumber(args.version),
        });
        if (args.json) return printJson(result);
        console.log(JSON.stringify(result, null, 2));
      },
    }),
    compare: defineCommand({
      meta: {
        name: "problems version compare",
        description: "Compare two challenge versions",
      },
      args: {
        id: { type: "positional", description: "Challenge ID", required: true },
        from: { type: "string", description: "Earlier version number", required: true },
        to: { type: "string", description: "Later version number", required: true },
        json: { type: "boolean", description: "Output as JSON" },
      },
      run: async ({ args }) => {
        const client = await getClient();
        const fromNumber = parseVersionNumber(args.from);
        const toNumber = parseVersionNumber(args.to);
        const [before, after] = await Promise.all([
          client.query(api.problemVersions.getByVersion, {
            problemId: asId(args.id),
            version: fromNumber,
          }),
          client.query(api.problemVersions.getByVersion, {
            problemId: asId(args.id),
            version: toNumber,
          }),
        ]);
        const fields = [
          "description",
          "githubRepoUrl",
          "githubCommitHash",
          "dockerfile",
          "testPatch",
          "solutionPatch",
        ];
        const changes = fields.flatMap((field) => {
          const oldValue = (before as any)?.[field] ?? "";
          const newValue = (after as any)?.[field] ?? "";
          return oldValue === newValue ? [] : [{ field, oldValue, newValue }];
        });
        const result = { problemId: args.id, from: fromNumber, to: toNumber, changes };
        if (args.json) return printJson(result);
        console.log(`\n  v${fromNumber} → v${toNumber}: ${changes.length} changed field(s)`);
        for (const change of changes) {
          console.log(`\n  === ${change.field} ===`);
          console.log(`  --- v${fromNumber}`);
          console.log(String(change.oldValue));
          console.log(`  +++ v${toNumber}`);
          console.log(String(change.newValue));
        }
        console.log("");
      },
    }),
  },
});
const SUBMISSION_LANES = ["olympus", "mars"] as const;
function parseSubmissionLane(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if ((SUBMISSION_LANES as readonly string[]).includes(value)) return value;
  throw new CliError(`--type must be one of: ${SUBMISSION_LANES.join(", ")}`, {
    kind: "usage",
    code: "input.invalid_submission_type",
    retryable: false,
    hint: "Diamond challenges always submit through the olympus lane.",
  });
}
const submit = defineCommand({
  meta: { name: "problems submit", description: "Submit a challenge for review" },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    "skip-human-review": {
      type: "boolean",
      description: "Request skipping human review (requires backend eligibility)",
    },
    type: {
      type: "string",
      description: "Submission lane: olympus or mars (default: the challenge's current type)",
    },
    "include-coauthorship": {
      type: "boolean",
      description: "Include coauthors in the submission",
    },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const submissionType = parseSubmissionLane(args.type);
    const client = await getClient();
    const result = await client.mutation(api.problems.submitDraft, {
      problemId: asId(args.id),
      ...(submissionType ? { submissionType } : {}),
      ...(args["include-coauthorship"] ? { includeCoauthorship: true } : {}),
      ...(args["skip-human-review"] ? { skipHumanReview: true } : {}),
    });
    if (args.json) {
      printJson(result);
      return;
    }
    if (result && typeof result === "object" && "verifying" in result) {
      console.log(`\n  Verification started for ${args.id}; submission follows when it passes`);
    } else {
      console.log(
        `\n  Submitted ${args.id}${args["skip-human-review"] ? " with human review skip requested" : " for review"}`,
      );
    }
    console.log(`  Run: olympus problems view ${args.id}\n`);
  },
});
function archiveCommand(name: "archive" | "unarchive") {
  const archiving = name === "archive";
  return defineCommand({
    meta: {
      name: `problems ${name}`,
      description: archiving ? "Archive a challenge draft" : "Restore an archived challenge",
    },
    args: {
      id: { type: "positional", description: "Challenge ID", required: true },
      json: { type: "boolean", description: "Output as JSON" },
    },
    run: async ({ args }) => {
      const client = await getClient();
      const result = await client.mutation(
        archiving ? api.problems.archiveDraft : api.problems.unarchiveDraft,
        { problemId: asId(args.id) },
      );
      if (args.json) return printJson(result ?? { problemId: args.id, archived: archiving });
      console.log(`\n  ${archiving ? "Archived" : "Restored"} ${args.id}\n`);
    },
  });
}
const SUBMISSION_TYPES = ["olympus", "mars", "diamond"] as const;
const type = defineCommand({
  meta: {
    name: "problems type",
    description: "Show or change a challenge's submission type (olympus, mars, diamond)",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    value: { type: "positional", description: "New submission type", required: false },
    yes: {
      type: "boolean",
      description: "Confirm a change that invalidates an existing task-quality result",
    },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const problemId = asId(args.id);
    const context: any = await client.query(api.problems.getSubmissionTypeContext, { problemId });
    if (!args.value) {
      if (args.json) return printJson(context);
      console.log(`\n  Submission type: ${context?.submissionType ?? "unknown"}`);
      if (context?.olympusLocked)
        console.log(
          `  Olympus: locked${context.unlockTierName ? ` until ${context.unlockTierName}` : ""}`,
        );
      if (context?.marsAllowed === false) console.log("  Mars: not enabled for this quest");
      else if (context?.marsLocked) console.log("  Mars: not available at your tier");
      if (context?.isEditable === false || context?.isLocked) console.log("  Type is not editable");
      console.log("");
      return;
    }
    const value = args.value;
    const usage = (message: string, code: string) =>
      new CliError(message, { kind: "usage", code, retryable: false });
    if (!(SUBMISSION_TYPES as readonly string[]).includes(value))
      throw usage(
        `Submission type must be one of: ${SUBMISSION_TYPES.join(", ")}`,
        "input.invalid_submission_type",
      );
    if (context?.isEditable === false || context?.isLocked)
      throw usage("This challenge's submission type cannot be changed", "submission_type.locked");
    if (value === "olympus" && context?.olympusLocked)
      throw usage(
        context.unlockTierName
          ? `Olympus unlocks at the ${context.unlockTierName} tier`
          : "Olympus is locked for your tier",
        "submission_type.olympus_locked",
      );
    if (value === "mars" && context?.marsAllowed === false)
      throw usage(
        "Mars submissions are not enabled for this quest",
        "submission_type.mars_disabled",
      );
    if (value === "mars" && context?.marsLocked)
      throw usage("Mars submissions aren't available at your tier", "submission_type.mars_locked");
    if (value !== context?.submissionType && context?.hasTaskQualityJob && !args.yes)
      throw usage(
        "Changing the submission type invalidates the existing task-quality result; rerun with --yes",
        "submission_type.confirmation_required",
      );
    const result = await client.mutation(api.problems.setSubmissionType, {
      problemId,
      submissionType: value,
    });
    if (args.json) return printJson(result ?? { problemId: args.id, submissionType: value });
    console.log(`\n  Submission type of ${args.id} set to ${value}\n`);
  },
});
const lock = defineCommand({
  meta: { name: "problems lock", description: "Lock the latest challenge version" },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const result = await client.mutation(api.problems.snapshotVersion, {
      problemId: asId(args.id),
    });
    if (args.json) {
      printJson(result);
      return;
    }
    console.log(`\n  Locked latest version on ${args.id}\n`);
  },
});
const unlock = defineCommand({
  meta: { name: "problems unlock", description: "Unlock the latest challenge version" },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const result = await client.mutation(api.problems.unsnapshotVersion, {
      problemId: asId(args.id),
    });
    if (args.json) return printJson(result);
    console.log(`\n  Unlocked latest version on ${args.id}.\n`);
  },
});

const startEdit = defineCommand({
  meta: {
    name: "problems start-edit",
    description: "Create or enter an editable draft after submission/review",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const result = await client.mutation(api.problems.startEditVersion, {
      problemId: asId(args.id),
    });
    if (args.json) return printJson(result);
    console.log(`\n  Editable draft started for ${args.id}.\n`);
  },
});

export default defineCommand({
  meta: { name: "problems", description: "Challenges and submissions" },
  subCommands: {
    create,
    mine,
    view,
    download,
    edit,
    version,
    submit,
    lock,
    unlock,
    "start-edit": startEdit,
    dump,
    type,
    archive: archiveCommand("archive"),
    unarchive: archiveCommand("unarchive"),
  },
});
