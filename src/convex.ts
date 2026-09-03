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
    convexUrl = await getConvexUrl();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}\n`);
    process.exit(1);
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  clientSingleton = client;
  return client;
}

// Untyped by necessity: this fork does not contain the private Convex source
// tree that generates the server-side Api type. Runtime function names and
// payload shapes are documented in REVERSE-ENGINEERING.md and contract-tested.
export const api = anyApi;

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
  const data: any = await client.query(api.problems.getWithVersion, {
    problemId,
    versionNumber,
  });
  if (!data?.version) {
    console.error(`  Version v${versionNumber} not found for problem ${problemId}.`);
    process.exit(1);
  }
  return { problem: data.problem ?? data, version: data.version };
}

export function parseVersionNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    console.error(`  Invalid version number: ${value}`);
    process.exit(1);
  }
  return parsed;
}

/** Fetch a problem and its latest version, or exit with an error. */
export async function requireProblemVersion(
  client: ConvexHttpClient,
  problemId: string,
): Promise<ProblemWithVersion> {
  const data: any = await client.query(api.problems.getWithLatestVersion, {
    problemId,
  });
  if (!data) {
    console.error(`  Problem not found: ${problemId}`);
    process.exit(1);
  }
  if (!data.latestVersion) {
    console.error("  No version found.");
    process.exit(1);
  }
  return { problem: data, version: data.latestVersion };
}
