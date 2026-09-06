import { ConvexHttpClient } from "convex/browser";
import { anyApi, getFunctionName } from "convex/server";
import { dispatchWithBudget, loadPolicy, PolicyError } from "./policy.ts";
import { budgetScope, readBudget } from "./budget.ts";
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
    return { enabled: true, challengeId, ...await readBudget({ directory: context.directory, scope: budgetScope(context.backend, context.account, challengeId), limit }) };
  } catch (error) {
    return { enabled: true, scope: "local", challengeId, limit, error: error instanceof Error ? error.message : "Local budget state is unavailable" };
  }
}

export async function getClient(): Promise<ConvexHttpClient> {
  if (clientSingleton) return clientSingleton;
  const { token, identity } = requireAuth();
  let convexUrl: string;
  try {
    convexUrl = await retryTransient(() => getConvexUrl());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  installPolicyGuards(client, convexUrl, identity.sub);
  clientSingleton = client;
  return client;
}

export function installPolicyGuards(client: any, backend: string, account: string, directory = resolve(credentialsDir(), "challenge-budgets")): void {
  budgetScopes.set(client, { backend, account, directory });
  const versions = new Map<string, string>();
  const references = new Map<string, string>();
  const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const remember = (map: Map<string, string>, key: unknown, problem: unknown) => {
    if (valid(key) && valid(problem)) {
      map.set(key, map.has(key) && map.get(key) !== problem ? "" : problem);
    }
  };
  const query = client.query.bind(client);
  Object.defineProperty(client, "query", { value: async (reference: any, args: any = {}, ...options: any[]) => {
    const result = await query(reference, args, ...options);
    const name = getFunctionName(reference);
    if (name === "problems:getWithLatestVersion") remember(versions, result?.latestVersion?._id, args.problemId);
    if (name === "problems:getWithVersion") remember(versions, result?.version?._id, args.problemId);
    if (name === "problems:listVersions" && Array.isArray(result)) for (const version of result) remember(versions, version?._id, args.problemId);
    if (name === "problemVersions:getByVersion") remember(versions, result?._id, args.problemId);
    const problem = args.problemId ?? versions.get(args.versionId);
    if (name === "runAgentRuns:getAgentRuns" && Array.isArray(result)) {
      for (const run of result) { remember(references, run?.id ?? run?._id, problem); remember(references, run?.jobId, problem); }
    }
    if (name === "jobs:get") remember(references, args.id, result?.problemId ?? versions.get(result?.versionId));
    return result;
  } });
  const resolveChallenge = async (args: Record<string, any>): Promise<string> => {
    let problem = valid(args.problemId) ? args.problemId : undefined;
    if (valid(args.versionId)) {
      const fromVersion = versions.get(args.versionId);
      if (problem && fromVersion && problem !== fromVersion) throw new PolicyError("tokens.challenge_budget", "Challenge and version scope do not match");
      problem ??= fromVersion;
    }
    problem ??= references.get(args.runId) ?? references.get(args.jobId);
    if (!problem && valid(args.jobId)) {
      const job = await client.query(anyApi.jobs.get, { id: args.jobId });
      problem = references.get(args.jobId) ?? versions.get(job?.versionId);
    }
    if (!problem) throw new PolicyError("tokens.challenge_budget", "Cannot resolve the challenge scope; read the challenge version before dispatch");
    return problem;
  };
  for (const method of ["action", "mutation"] as const) {
    const invoke = client[method].bind(client);
    Object.defineProperty(client, method, { value: (reference: any, args: any = {}, ...options: any[]) =>
      dispatchWithBudget(client, getFunctionName(reference), args, () => invoke(reference, args, ...options), { directory, backend, account, resolveChallenge }) });
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
      const message = error instanceof Error ? error.message : String(error);
      if (!/fetch failed|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(message) || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

export function asId<TableName extends string>(value: string): string {
  return value;
}

export interface ProblemWithVersion {
  problem: any;
  version: any;
}

export async function resolveProblemVersion(
  client: ConvexHttpClient,
  problemId: string,
  versionNumber?: number,
): Promise<ProblemWithVersion> {
  if (versionNumber === undefined) {
    return requireProblemVersion(client, problemId);
  }
  const data: any = await retryTransient(() => client.query(api.problems.getWithVersion, {
    problemId,
    versionNumber,
  }));
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
  const data: any = await retryTransient(() => client.query(api.problems.getWithLatestVersion, {
    problemId,
  }));
  if (!data) {
    throw new Error(`Problem not found: ${problemId}`);
  }
  if (!data.latestVersion) {
    throw new Error(`No version found for problem ${problemId}`);
  }
  return { problem: data, version: data.latestVersion };
}
