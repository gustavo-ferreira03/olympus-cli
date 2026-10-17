import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// A re-evaluation offer, once seen for a version, keeps blocking new rollouts until a re-evaluation of
// that version completes with verdicts: an offer lost to failed attempts must not unlock fresh runs.
const offerDirectory = () => resolve(homedir(), ".shipd", "olympus", "reeval-offers");

const safeName = (versionId: string) => versionId.replaceAll(/[^A-Za-z0-9_-]/g, "_");

export function rememberReEvaluationOffer(versionId: string, offer: unknown): number | null {
  const file = resolve(offerDirectory(), `${safeName(versionId)}.json`);
  // Changed solver inputs void the old cohort legitimately (a calibration revision of task.md): fresh runs
  // are then the right lever, so the remembered offer no longer applies.
  const reason =
    offer !== null && typeof offer === "object" && !Array.isArray(offer)
      ? (offer as { reason?: unknown }).reason
      : undefined;
  if (reason === "solver_inputs_changed") {
    rmSync(file, { force: true });
    return null;
  }
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as { seenAt?: unknown };
    if (typeof stored.seenAt === "number") return stored.seenAt;
  } catch {
    // No record yet.
  }
  const eligible =
    offer !== null
    && typeof offer === "object"
    && !Array.isArray(offer)
    && (offer as { eligible?: unknown }).eligible === true;
  if (!eligible) return null;
  const seenAt = Date.now();
  mkdirSync(offerDirectory(), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const { cohortHash, runCount } = offer as { cohortHash?: unknown; runCount?: unknown };
  writeFileSync(temporary, `${JSON.stringify({ versionId, seenAt, cohortHash, runCount })}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
  return seenAt;
}

type RunRecord = {
  batchTag?: unknown;
  status?: unknown;
  fault?: unknown;
  verdict?: unknown;
  createdAt?: unknown;
  completedAt?: unknown;
};

const runsOf = (runs: unknown): RunRecord[] =>
  Array.isArray(runs)
    ? runs.filter((run): run is RunRecord => run !== null && typeof run === "object")
    : [];

const time = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function reEvaluatedSince(runs: unknown, seenAt: number): boolean {
  return runsOf(runs).some(
    (run) =>
      typeof run.batchTag === "string"
      && run.batchTag.startsWith("reeval-")
      && run.status === "completed"
      && run.fault !== "infra"
      && typeof run.verdict === "string"
      && time(run.createdAt) >= seenAt,
  );
}

export const INFRA_COOLDOWN_MS = 60 * 60 * 1000;

// The newest batch failed entirely on infrastructure and finished less than the cooldown ago: the platform is
// down, and another batch only burns attempts (a re-evaluation offer, run slots) without producing verdicts.
export function infrastructureCooldown(
  runs: unknown,
  now = Date.now(),
): { batchTag: string; until: string } | null {
  const batches = new Map<string, RunRecord[]>();
  for (const run of runsOf(runs)) {
    if (typeof run.batchTag !== "string" || !run.batchTag) continue;
    batches.set(run.batchTag, [...(batches.get(run.batchTag) ?? []), run]);
  }
  let newest: [string, RunRecord[]] | undefined;
  for (const entry of batches) {
    const created = Math.max(...entry[1].map((run) => time(run.createdAt)));
    if (!newest || created > Math.max(...newest[1].map((run) => time(run.createdAt))))
      newest = entry;
  }
  if (!newest) return null;
  const [batchTag, members] = newest;
  if (!members.every((run) => run.fault === "infra" && run.status === "failed")) return null;
  const finished = Math.max(...members.map((run) => time(run.completedAt) || time(run.createdAt)));
  if (now - finished >= INFRA_COOLDOWN_MS) return null;
  return { batchTag, until: new Date(finished + INFRA_COOLDOWN_MS).toISOString() };
}
