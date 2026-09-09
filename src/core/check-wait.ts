/**
 * Polling for dynamic quality checks.
 *
 * `olympus checks wait` and the single-check commands (auto-review, fp-check,
 * scope-gate, verifier-audit) all poll the same backend endpoint and print the
 * same summaries, so the loop lives here rather than in any one command.
 */
import { api, asId } from "../platform/convex.ts";
import { printJson, statusBadge, truncate } from "../terminal/format.ts";
import {
  type DynamicCheckEntry,
  formatDynamicCheckLabel,
  getDynamicCheckEntries,
} from "./model.ts";
import { type Client, type ProblemVersion } from "../shared/types.ts";

/** Quality checks settle faster than rollouts, so they poll more often. */
export const CHECK_WAIT_DEFAULTS = { intervalSeconds: 5, timeoutMinutes: 30 } as const;

export function formatCheckMessage(check: DynamicCheckEntry): string | null {
  const message =
    check.output?.message ?? check.output?.summary ?? check.output?.evaluation?.summary;
  return message ?? null;
}

export function formatCheckVerdict(check: DynamicCheckEntry): string | null {
  const verdict = check.output?.verdict ?? check.output?.evaluation?.verdict;
  return verdict ?? null;
}

/** True while a check is still queued or executing. */
export function isActiveStatus(status: unknown): boolean {
  return status === "pending" || status === "running";
}

type CheckWaitSummary = {
  key: string;
  label: string;
  jobId?: string;
  status: string;
  stale: boolean;
  progress?: number;
  currentStep?: string;
  verdict?: unknown;
  message?: unknown;
  error?: string;
  createdAt?: number;
  completedAt?: number;
};

export function summarizeCheck(check: DynamicCheckEntry): CheckWaitSummary {
  return {
    key: check.key,
    label: formatDynamicCheckLabel(check.key),
    jobId: check.jobId,
    status: check.status,
    stale: Boolean(check.stale),
    progress: check.progress,
    currentStep: check.currentStep,
    verdict: formatCheckVerdict(check) ?? undefined,
    message: formatCheckMessage(check) ?? undefined,
    error: check.error,
    createdAt: check.createdAt,
    completedAt: check.completedAt,
  };
}

async function queryDynamicChecksWithRetry(client: Client, versionId: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await client.query(api.runDynamicChecks.getDynamicChecks, { versionId });
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        process.stderr.write(`\n  Poll failed; retrying (${attempt}/3)...\n`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw lastError;
}

/** Options accepted by {@link waitForChecks}. */
export type WaitForChecksOptions = {
  client: Client;
  problemId: string;
  version: ProblemVersion;
  jobId?: string;
  requestedKeys?: string[];
  intervalMs: number;
  timeoutMs: number;
  json?: boolean;
  full?: boolean;
};

export async function waitForChecks({
  client,
  problemId,
  version,
  jobId,
  requestedKeys,
  intervalMs,
  timeoutMs,
  json,
  full,
}: WaitForChecksOptions) {
  const startedAt = Date.now();
  let targetKeys: string[] | null = requestedKeys?.length ? requestedKeys : null;
  const expectedJobId: string | undefined = jobId;

  while (true) {
    const dynamicChecks = await queryDynamicChecksWithRetry(client, version._id);
    const entries = getDynamicCheckEntries(dynamicChecks);

    if (targetKeys === null) {
      if (expectedJobId) {
        const match = entries.find((check) => check.jobId === expectedJobId);
        if (!match)
          throw new Error(`Check job ${expectedJobId} is not current on v${version.version}`);
        targetKeys = [match.key];
      } else {
        targetKeys = entries
          .filter((check) => !check.stale && isActiveStatus(check.status))
          .map((check) => check.key);
        if (targetKeys.length === 0) {
          const result = { status: "idle", version: version.version, checks: [] };
          if (json) printJson(result);
          else console.log(`\n  No active current checks on v${version.version}.\n`);
          return result;
        }
      }
    }

    const selected = targetKeys.map((key) => {
      const check = entries.find((entry) => entry.key === key);
      if (!check) throw new Error(`Check ${key} has not been started on v${version.version}`);
      if (expectedJobId && check.jobId !== expectedJobId) {
        throw new Error(`Check ${key} was replaced by job ${check.jobId ?? "unknown"}`);
      }
      return check;
    });
    const active = selected.filter((check) => isActiveStatus(check.status));
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

    if (active.length === 0) {
      const summaries = selected.map(summarizeCheck);
      const executionFailed = selected.some((check) => check.status === "failed");
      const result: Record<string, unknown> = {
        status: executionFailed ? "failed" : "completed",
        version: version.version,
        elapsedSeconds,
        checks: summaries,
      };
      if (full) {
        result.raw = Object.fromEntries(selected.map((check) => [check.key, check]));
        result.readiness = await client.query(api.submissionReadiness.getSubmissionReadiness, {
          problemId: asId(problemId),
        });
      }
      if (json) printJson(result);
      else {
        process.stderr.write("\r\x1b[2K");
        for (const check of summaries) {
          const detail = check.verdict ?? check.message ?? check.error ?? "";
          console.log(
            `${statusBadge(check.status)}  ${check.label}${detail ? ` — ${truncate(String(detail), 100)}` : ""}`,
          );
        }
      }
      if (executionFailed) process.exitCode = 1;
      return result;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const result = {
        status: "timeout",
        version: version.version,
        elapsedSeconds,
        checks: selected.map(summarizeCheck),
      };
      if (json) printJson(result);
      else console.error(`\n  Timed out waiting for ${active.length} check(s).`);
      process.exitCode = 2;
      return result;
    }

    if (!json) {
      const progress = active.map((check) => `${check.key}:${check.progress ?? "?"}%`).join(" ");
      process.stderr.write(
        `\r  waiting checks=${active.length} elapsed=${elapsedSeconds}s ${progress}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
