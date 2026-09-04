import { defineCommand } from "citty";
import { api } from "../convex.ts";
import { printJson } from "../format.ts";
import { omitEmpty } from "../output.ts";
import { commonArgs, resolveCommandContext } from "../command-utils.ts";

function isActive(status: unknown): boolean {
  return status === "pending" || status === "running";
}

function parsePositiveNumber(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
  return value;
}

function imageState(image: any, build: any): string {
  if (isActive(build?.status)) return "building";
  if (image?.hasImage && !image?.stale && !image?.rebuildSafeNeeded) return "ready";
  if (build?.status === "failed" || image?.lastBuildFailedForCurrentInputs) return "failed";
  return "required";
}

function summarizeImage(version: number, image: any, build: any) {
  return omitEmpty({
    status: imageState(image, build),
    version,
    image: {
      hasImage: Boolean(image?.hasImage),
      stale: Boolean(image?.stale),
      rebuildSafeNeeded: Boolean(image?.rebuildSafeNeeded),
      canBuild: image?.canBuild,
      imageUrl: image?.imageUrl,
      sizeBytes: image?.sizeBytes,
      harborStatus: image?.harborStatus,
      harborWarnings: image?.harborWarnings,
      harborFailureReason: image?.harborFailureReason,
    },
    build: build
      ? {
          jobId: build.jobId,
          status: build.status,
          progress: build.progress,
          currentStep: build.currentStep,
          error: build.error,
          createdAt: build.createdAt,
          completedAt: build.completedAt,
        }
      : undefined,
  });
}

async function readImageState(client: any, versionId: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const [image, build] = await Promise.all([
        client.query(api.dockerImage.getImageStatus, { versionId }),
        client.query(api.dockerImage.getLatestBuildJobForVersion, { versionId }),
      ]);
      return { image, build };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

async function waitForImage({
  client,
  versionId,
  versionNumber,
  expectedJobId,
  intervalMs,
  timeoutMs,
  json,
  full,
}: any) {
  const startedAt = Date.now();
  while (true) {
    const { image, build } = await readImageState(client, versionId);
    const state = imageState(image, build);
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

    if (expectedJobId && build?.jobId && build.jobId !== expectedJobId) {
      throw new Error(`Image build ${expectedJobId} was replaced by ${build.jobId}`);
    }
    if (state === "ready") {
      const result = full
        ? { status: "ready", version: versionNumber, elapsedSeconds, image, build }
        : { ...summarizeImage(versionNumber, image, build), elapsedSeconds };
      if (json) printJson(result);
      else console.log(`\n  Image ready for v${versionNumber}${build?.jobId ? ` (${build.jobId})` : ""}.\n`);
      return result;
    }
    if (state === "failed") {
      const result = full
        ? { status: "failed", version: versionNumber, elapsedSeconds, image, build }
        : { ...summarizeImage(versionNumber, image, build), elapsedSeconds };
      if (json) printJson(result);
      else console.error(`\n  Image build failed: ${build?.error ?? "unknown error"}\n`);
      process.exitCode = 1;
      return result;
    }
    if (!isActive(build?.status)) {
      throw new Error("No active image build exists for this version");
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const result = {
        ...summarizeImage(versionNumber, image, build),
        status: "timeout",
        elapsedSeconds,
      };
      if (json) printJson(result);
      else console.error(`\n  Timed out waiting for image build ${build.jobId ?? ""}.\n`);
      process.exitCode = 2;
      return result;
    }
    if (!json) {
      process.stderr.write(
        `\r  building image elapsed=${elapsedSeconds}s progress=${build?.progress ?? "?"}% step=${build?.currentStep ?? "starting"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const view = defineCommand({
  meta: { name: "image view", description: "View the current version image state" },
  args: {
    ...commonArgs,
    full: { type: "boolean", description: "Include complete backend payloads" },
  },
  run: async ({ args }) => {
    const { client, versionId, versionNumber } = await resolveCommandContext(args);
    const { image, build } = await readImageState(client, versionId);
    const result = args.full
      ? { status: imageState(image, build), version: versionNumber, image, build }
      : summarizeImage(versionNumber, image, build);
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

const wait = defineCommand({
  meta: { name: "image wait", description: "Wait for the current version image build" },
  args: {
    ...commonArgs,
    job: { type: "string", description: "Expected image build job ID" },
    interval: { type: "string", description: "Poll interval in seconds (default 5)" },
    timeout: { type: "string", description: "Timeout in minutes (default 30)" },
    full: { type: "boolean", description: "Include complete backend payloads" },
  },
  run: async ({ args }) => {
    const { client, versionId, versionNumber } = await resolveCommandContext(args);
    await waitForImage({
      client,
      versionId,
      versionNumber,
      expectedJobId: args.job,
      intervalMs: parsePositiveNumber(args.interval, 5, "--interval") * 1000,
      timeoutMs: parsePositiveNumber(args.timeout, 30, "--timeout") * 60 * 1000,
      json: Boolean(args.json),
      full: Boolean(args.full),
    });
  },
});

const build = defineCommand({
  meta: { name: "image build", description: "Build or rebuild the current version image" },
  args: {
    ...commonArgs,
    wait: { type: "boolean", description: "Wait for the image to become ready" },
    interval: { type: "string", description: "Poll interval in seconds (default 5)" },
    timeout: { type: "string", description: "Timeout in minutes (default 30)" },
    full: { type: "boolean", description: "Include complete backend payloads when waiting" },
  },
  run: async ({ args }) => {
    const { client, problemId, versionId, versionNumber } = await resolveCommandContext(args);
    let { image, build: latestBuild } = await readImageState(client, versionId);

    if (imageState(image, latestBuild) === "ready") {
      const result = { ...summarizeImage(versionNumber, image, latestBuild), built: false };
      if (args.json) return printJson(result);
      console.log(`\n  Image already ready for v${versionNumber}.\n`);
      return;
    }
    if (image?.lastBuildFailedForCurrentInputs && !image?.rebuildSafeNeeded) {
      throw new Error("The last image build failed for the current Dockerfile; edit it before rebuilding");
    }
    if (image?.canBuild === false) throw new Error("The image cannot currently be built");

    let triggered = false;
    if (!isActive(latestBuild?.status)) {
      await client.action(api.dockerImage.buildVersionImage, { versionId });
      triggered = true;
      ({ image, build: latestBuild } = await readImageState(client, versionId));
    }

    const jobId = latestBuild?.jobId;
    if (args.wait) {
      await waitForImage({
        client,
        versionId,
        versionNumber,
        expectedJobId: jobId,
        intervalMs: parsePositiveNumber(args.interval, 5, "--interval") * 1000,
        timeoutMs: parsePositiveNumber(args.timeout, 30, "--timeout") * 60 * 1000,
        json: Boolean(args.json),
        full: Boolean(args.full),
      });
      return;
    }

    const waitCommand = jobId
      ? `olympus image wait ${problemId} --job=${jobId} --json`
      : `olympus image wait ${problemId} --json`;
    const result = omitEmpty({
      status: "building",
      version: versionNumber,
      jobId,
      triggered,
      waitCommand,
    });
    if (args.json) return printJson(result);
    console.log(`\n  Image build ${triggered ? "queued" : "already running"} for v${versionNumber}.`);
    console.log(`  Wait: ${waitCommand}\n`);
  },
});

const cancel = defineCommand({
  meta: { name: "image cancel", description: "Cancel the active current version image build" },
  args: commonArgs,
  run: async ({ args }) => {
    const { client, versionId, versionNumber } = await resolveCommandContext(args);
    const { build } = await readImageState(client, versionId);
    if (!isActive(build?.status)) throw new Error("No active image build exists for this version");
    const result = await client.mutation(api.dockerImage.cancelBuildJob, { versionId });
    const output = {
      status: result?.cancelled ? "cancelled" : "completed",
      version: versionNumber,
      jobId: build.jobId,
      cancelled: Boolean(result?.cancelled),
    };
    if (args.json) return printJson(output);
    console.log(result?.cancelled ? "\n  Image build cancelled.\n" : "\n  Image build already finished.\n");
  },
});

export default defineCommand({
  meta: { name: "image", description: "Build and inspect version images" },
  subCommands: { view, build, wait, cancel },
});
