/**
 * Fetching and printing job artifacts.
 *
 * Checks and rollouts both expose an `artifact` subcommand with identical
 * behaviour: resolve a signed URL, download it, slice it down to the requested
 * window, then print it as text or JSON. Only the identifying labels differ.
 */
import { api } from "../platform/convex.ts";
import { printJson } from "../terminal/format.ts";
import { omitEmpty, parsePositiveInteger, sliceText } from "../terminal/output.ts";
import { type Client } from "../shared/types.ts";

/** The `--head`/`--tail`/`--contains`/`--max-chars` window flags. */
export type ArtifactSliceArgs = {
  head?: string;
  tail?: string;
  contains?: string;
  full?: boolean;
  json?: boolean;
  "max-chars"?: string;
};

/** Everything needed to fetch and render one artifact. */
export type ArtifactRequest = {
  client: Client;
  /** Backend job that produced the artifact. */
  jobId: string;
  /** Which artifact of that job to fetch. */
  artifactKey: string;
  /** How the owner is described in error messages, e.g. `check "verifyTests"`. */
  ownerDescription: string;
  /** Extra fields identifying the owner in JSON output. */
  jsonIdentity: Record<string, unknown>;
  /** Command that would re-run this without truncation. */
  fullCommand: string;
  /** Default `--max-chars` applied in JSON mode when the flag is absent. */
  jsonMaxChars?: number;
  args: ArtifactSliceArgs;
};

/**
 * Fetch one artifact and write it to stdout, as text or JSON.
 *
 * @throws Error when the artifact is unknown to the backend or the download fails.
 */
export async function printArtifact({
  client,
  jobId,
  artifactKey,
  ownerDescription,
  jsonIdentity,
  fullCommand,
  jsonMaxChars = 12000,
  args,
}: ArtifactRequest): Promise<void> {
  const url = await client.action(api.artifactProxy.fetchArtifact, { jobId, artifactKey });
  if (!url) {
    throw new Error(`Artifact "${artifactKey}" was not found for ${ownerDescription}`);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Artifact fetch failed with HTTP ${response.status}`);
  }
  const content = await response.text();
  const sliced = sliceText(content, {
    head: parsePositiveInteger(args.head, undefined, "--head"),
    tail: parsePositiveInteger(args.tail, undefined, "--tail"),
    contains: args.contains,
    maxChars: args.full
      ? undefined
      : parsePositiveInteger(
          args["max-chars"],
          args.json ? jsonMaxChars : undefined,
          "--max-chars",
        ),
  });
  const nextCommand = sliced.truncated ? fullCommand : undefined;
  if (args.json) {
    printJson(omitEmpty({ ...jsonIdentity, jobId, artifact: artifactKey, ...sliced, nextCommand }));
    return;
  }
  process.stdout.write(sliced.content);
  if (!sliced.content.endsWith("\n")) process.stdout.write("\n");
  if (sliced.truncated) {
    process.stderr.write(
      `Artifact truncated: ${sliced.returnedChars}/${sliced.totalChars} chars. Full: ${nextCommand}\n`,
    );
  }
}
