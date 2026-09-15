import {
  remoteArtifactHashes,
  recordedCheckInputs,
  saveObservedInputs,
} from "../core/check-inputs.ts";
import { toPublicCheckKey } from "../core/expected.ts";
import { ConvexHttpClient } from "convex/browser";
import { CliError, describeError } from "../shared/errors.ts";
import { anyApi, getFunctionName } from "convex/server";
import { dispatchWithPolicy, loadPolicy, PolicyError } from "../core/policy.ts";
import { budgetScope, readBudget } from "../core/budget.ts";
import { credentialsDir, requireAuth } from "./auth.ts";
import { resolve } from "node:path";
import { getConvexUrl } from "./config.ts";

let clientSingleton: ConvexHttpClient | null = null;
const budgetScopes = new WeakMap<object, { backend: string; account: string; directory: string }>();

export async function localBudgetStatus(client: object, challengeId: string): Promise<unknown> {
  const limit = loadPolicy().tokens.challenge_budget;
  if (limit === null) return { enabled: false, scope: "local", challengeId };
  const context = budgetScopes.get(client);
  try {
    if (!context) throw new Error("Local budget scope is unavailable");
    return {
      enabled: true,
      challengeId,
      ...(await readBudget({
        directory: context.directory,
        scope: budgetScope(context.backend, context.account, challengeId),
        limit,
      })),
    };
  } catch (error) {
    return {
      enabled: true,
      scope: "local",
      challengeId,
      limit,
      error: error instanceof Error ? error.message : "Local budget state is unavailable",
    };
  }
}

export async function getClient(): Promise<ConvexHttpClient> {
  if (clientSingleton) return clientSingleton;
  const { token, identity } = requireAuth();
  const convexUrl = await retryTransient(() => getConvexUrl());
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  installPolicyGuards(client, convexUrl, identity.sub, undefined, token);
  clientSingleton = client;
  return client;
}

export function installPolicyGuards(
  client: any,
  backend: string,
  account: string,
  directory = resolve(credentialsDir(), "challenge-budgets"),
  confirmationSecret = account,
): void {
  budgetScopes.set(client, { backend, account, directory });
  const inputDirectory = resolve(directory, "..", "check-inputs");
  const inputScope = JSON.stringify([backend, account]);
  const versions = new Map<string, string>();
  const references = new Map<string, string>();
  const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const remember = (map: Map<string, string>, key: unknown, problem: unknown) => {
    if (valid(key) && valid(problem)) {
      map.set(key, map.has(key) && map.get(key) !== problem ? "" : problem);
    }
  };
  const query = client.query.bind(client);
  Object.defineProperty(client, "query", {
    value: async (reference: any, args: any = {}, ...options: any[]) => {
      const result = await retryTransient<any>(() => query(reference, args, ...options));
      const name = getFunctionName(reference);
      if (name === "problems:getWithLatestVersion")
        remember(versions, result?.latestVersion?._id, args.problemId);
      if (name === "problems:getWithVersion")
        remember(versions, result?.version?._id, args.problemId);
      if (name === "problems:listVersions" && Array.isArray(result))
        for (const version of result) remember(versions, version?._id, args.problemId);
      if (name === "problemVersions:getByVersion") remember(versions, result?._id, args.problemId);
      const problem = args.problemId ?? versions.get(args.versionId);
      if (name === "runAgentRuns:getAgentRuns" && Array.isArray(result)) {
        for (const run of result) {
          remember(references, run?.id ?? run?._id, problem);
          remember(references, run?.jobId, problem);
        }
      }
      if (
        name === "runDynamicChecks:getDynamicChecks"
        && result
        && typeof result === "object"
        && !Array.isArray(result)
      ) {
        for (const check of Object.values(result) as any[])
          remember(references, check?.jobId, problem);
      }
      if (name === "jobs:get")
        remember(references, args.id, result?.problemId ?? versions.get(result?.versionId));
      return name === "runDynamicChecks:getDynamicChecks" && typeof args.versionId === "string"
        ? recordedCheckInputs(
            result,
            inputDirectory,
            JSON.stringify([inputScope, versions.get(args.versionId) ?? args.versionId]),
            args.versionId,
          )
        : result;
    },
  });
  const resolveChallenge = async (args: Record<string, any>): Promise<string> => {
    let problem = valid(args.problemId) ? args.problemId : undefined;
    if (valid(args.versionId)) {
      const fromVersion = versions.get(args.versionId);
      if (problem && fromVersion && problem !== fromVersion)
        throw new PolicyError(
          "tokens.challenge_budget",
          "Challenge and version scope do not match",
        );
      problem ??= fromVersion;
    }
    problem ??= references.get(args.runId) ?? references.get(args.jobId);
    if (!problem && valid(args.jobId)) {
      const job = await client.query(anyApi.jobs.get, { id: args.jobId });
      problem = references.get(args.jobId) ?? versions.get(job?.versionId);
    }
    if (!problem)
      throw new PolicyError(
        "tokens.challenge_budget",
        "Cannot resolve the challenge scope; read the challenge version before dispatch",
      );
    return problem;
  };
  for (const method of ["action", "mutation"] as const) {
    const invoke = client[method].bind(client);
    Object.defineProperty(client, method, {
      value: (reference: any, args: any = {}, ...options: any[]) => {
        const name = getFunctionName(reference);
        const policy = loadPolicy();
        const dispatch = async () => {
          const tracking =
            name === "runDynamicChecks:triggerDynamicCheck"
            || name === "runDynamicChecks:triggerAllDynamicChecks";
          let before: Record<string, string> | undefined;
          let problemId: string | undefined;
          const existingJobs = new Set<string>();
          const observedAt = Date.now();
          if (tracking) {
            try {
              problemId = await resolveChallenge(args);
              const snapshot = await client.query(api.problems.getWithLatestVersion, { problemId });
              if (snapshot?.latestVersion?._id === args.versionId) {
                const previous = await client.query(api.runDynamicChecks.getDynamicChecks, {
                  versionId: args.versionId,
                });
                for (const check of Object.values(previous ?? {}) as any[])
                  if (typeof check?.jobId === "string") existingJobs.add(check.jobId);
                before = remoteArtifactHashes(snapshot.latestVersion);
              }
            } catch {
              process.stderr.write(
                "Input tracking unavailable; dispatch will proceed without causal hashes.\n",
              );
            }
          }
          const result = await invoke(reference, args, ...options);
          if (tracking && before && problemId) {
            try {
              const snapshot = await client.query(api.problems.getWithLatestVersion, { problemId });
              if (snapshot?.latestVersion?._id === args.versionId) {
                const after = remoteArtifactHashes(snapshot.latestVersion);
                const entries =
                  name === "runDynamicChecks:triggerDynamicCheck"
                    ? [{ checkKey: args.checkKey, jobId: result?.jobId }]
                    : Array.isArray(result)
                      ? result
                      : [];
                for (const entry of entries) {
                  if (
                    typeof entry?.jobId !== "string"
                    || typeof entry?.checkKey !== "string"
                    || existingJobs.has(entry.jobId)
                  )
                    continue;
                  const requested =
                    name === "runDynamicChecks:triggerDynamicCheck"
                      ? [args.checkKey]
                      : (args.checkKeys ?? []);
                  if (
                    !requested.some(
                      (key: string) => toPublicCheckKey(key) === toPublicCheckKey(entry.checkKey),
                    )
                  )
                    continue;
                  saveObservedInputs({
                    directory: inputDirectory,
                    scope: JSON.stringify([inputScope, problemId]),
                    versionId: args.versionId,
                    jobId: entry.jobId,
                    check: entry.checkKey,
                    before,
                    after,
                    observedAt,
                  });
                }
              }
            } catch {
              process.stderr.write(
                "Check dispatched; input tracking unavailable. Do not redispatch.\n",
              );
            }
          }
          return result;
        };
        return dispatchWithPolicy({
          client,
          name,
          args,
          invoke: dispatch,
          scope: { directory, backend, account, resolveChallenge },
          policy,
          confirmationSecret,
        });
      },
    });
  }
}

// Untyped by necessity: this fork does not contain the private Convex source
// tree that generates the server-side API type.
export const api = anyApi;

async function retryTransient<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      const description = describeError(error);
      if (description.retryable !== true || !["network", "rate_limit"].includes(description.kind))
        throw error;
      if (attempt === 3) {
        throw new CliError(error instanceof Error ? error.message : String(error), {
          ...description,
          hint: "Read-only request failed after 3 attempts with exponential backoff. No mutation was retried. Check backend connectivity before retrying this read.",
        });
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)),
      );
    }
  }
  throw lastError;
}

/**
 * Marker for values the backend treats as document ids.
 *
 * Convex is reached through `anyApi`, so ids are plain strings here; this keeps
 * call sites self-documenting without pretending the value is validated.
 */
export function asId(value: string): string {
  return value;
}

export type ProblemWithVersion = {
  problem: any;
  version: any;
};

export async function resolveProblemVersion(
  client: ConvexHttpClient,
  problemId: string,
  versionNumber?: number,
): Promise<ProblemWithVersion> {
  if (versionNumber === undefined) {
    return requireProblemVersion(client, problemId);
  }
  const data: any = await client.query(api.problems.getWithVersion, {
    problemId,
    versionNumber,
  });
  if (!data?.version) {
    throw new Error(`Version v${versionNumber} was not found for problem ${problemId}`);
  }
  return { problem: data.problem ?? data, version: data.version };
}

export function parseVersionNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new Error(`Invalid version number: ${value}`);
  }
  return parsed;
}

/** Fetch a problem and its latest version with transient retry. */
export async function requireProblemVersion(
  client: ConvexHttpClient,
  problemId: string,
): Promise<ProblemWithVersion> {
  const data: any = await client.query(api.problems.getWithLatestVersion, {
    problemId,
  });
  if (!data) {
    throw new Error(`Problem not found: ${problemId}`);
  }
  if (!data.latestVersion) {
    throw new Error(`No version found for problem ${problemId}`);
  }
  return { problem: data, version: data.latestVersion };
}
