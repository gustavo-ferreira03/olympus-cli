import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { requireAuth } from "./auth.ts";
import { getConvexUrl } from "./config.ts";

let clientSingleton: ConvexHttpClient | null = null;

export async function getClient(): Promise<ConvexHttpClient> {
  if (clientSingleton) return clientSingleton;
  const { token } = requireAuth();
  let convexUrl: string;
  try {
    convexUrl = await retryTransient(() => getConvexUrl());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  clientSingleton = client;
  return client;
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
