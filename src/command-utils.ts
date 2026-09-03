import { readFileSync } from "node:fs";
import type { ArgsDef } from "citty";
import {
  getClient,
  parseVersionNumber,
  resolveProblemVersion,
} from "./convex.ts";
import { printJson } from "./format.ts";

export type CommonArgs = {
  id: string;
  version?: string;
  json?: boolean;
};

export const commonArgs = {
  id: { type: "positional", description: "Challenge ID", required: true },
  version: { type: "string", description: "Version number (default: latest)" },
  json: { type: "boolean", description: "Output as JSON" },
} as const satisfies ArgsDef;

export async function resolveCommandContext(args: CommonArgs) {
  const client = await getClient();
  const { problem, version } = await resolveProblemVersion(
    client,
    args.id,
    parseVersionNumber(args.version),
  );
  return {
    client,
    problem,
    version,
    problemId: args.id,
    versionId: String(version._id),
    versionNumber: Number(version.version ?? args.version ?? 0),
  };
}

export function printResult(value: unknown, json: boolean | undefined): void {
  if (json) {
    printJson(value);
    return;
  }
  if (value == null) {
    console.log("  No result.");
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

export function readOptionalFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}
