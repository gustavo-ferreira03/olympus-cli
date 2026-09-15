import { api, localBudgetStatus } from "../platform/convex.ts";
import { getDynamicCheckEntries, formatDynamicCheckLabel } from "../core/model.ts";
import { sanitizeDiagnostic } from "../shared/errors.ts";
import { summarizeTokenUsage, type TokenUsageSnapshot } from "../core/token-telemetry.ts";

export type Source = {
  data: any;
  updatedAt: number | null;
  error: string | null;
};
export type Snapshot = {
  id: string;
  title: string;
  status: string;
  version: number | null;
  versionId: string | null;
  fetchedAt: number;
  sources: Record<string, Source>;
};
export type OverviewChallenge = {
  id: string;
  title: string;
  status: string;
  archived: boolean;
  version: number | null;
  versionId: string | null;
  language: string | null;
  difficulty: string | null;
  category: string | null;
  lastActivityAt: number | null;
  totalRuns: number | null;
  passedRuns: number | null;
  finalized: boolean | null;
  reviewState: string | null;
};
export type OverviewSnapshot = {
  fetchedAt: number;
  totalChallenges: number;
  archivedHidden: number;
  filters: {
    includeArchived: boolean;
    status: string | null;
    language: string | null;
    difficulty: string | null;
    category: string | null;
  };
  availableFilters: {
    status: string[];
    language: string[];
    difficulty: string[];
    category: string[];
  };
  challenges: OverviewChallenge[];
  tokens: {
    balance: number | null;
    cap: number | null;
    tierName: string | null;
    nextDripAt: number | null;
    acceptedInWindow: number | null;
    olympusAcceptedInWindow: number | null;
    lifetimeAccepted: number | null;
    pendingDrip: number | null;
    dripPaused: boolean | null;
    dripUnlimited: boolean | null;
    nextTierRequirement: {
      tierName: string | null;
      requiredAccepted: number | null;
      requiredOlympus: number | null;
      discounted: boolean | null;
    } | null;
    tierAcceptanceBonusUsd: number | null;
    tierDripAmount: number | null;
    tierWindowDays: number | null;
    generalTokenBalance: number | null;
    revisionTokenBalance: number | null;
    revisionError: string | null;
    usage: TokenUsageSnapshot;
    error: string | null;
  };
  elo: {
    value: number | null;
    projectedValue: number | null;
    rank: number | null;
    seatCutElo: number | null;
    isMember: boolean | null;
    acceptedAtRotation: number | null;
    acceptedNow: number | null;
    windowDays: number | null;
    nextRotationAt: number | null;
    timelineNow: number | null;
    agedOutBufferMs: number | null;
    agingOutByRotation: number | null;
    usage: {
      binMs: number | null;
      bins: number[];
    };
    marks: Array<{
      at: number;
      countsAtRotation: boolean;
      inWindow: boolean;
    }>;
    available: boolean;
    note: string;
  };
  acceptedTimeline: {
    windowDays: number;
    bufferDays: number;
    now: number;
    marks: Array<{
      at: number;
      lane: string;
    }>;
  } | null;
};
export type Row = {
  key: string;
  label: string;
  status: string;
  verdict: string;
  freshness: string;
  detail: string;
  batch?: string;
  progress?: number;
};
export const clean = (value: unknown): string =>
  sanitizeDiagnostic(String(value ?? "")).replaceAll(/[\r\n\t]/g, " ");
const errorText = (error: unknown) =>
  clean(error instanceof Error ? error.message : error).slice(0, 300);
const numberValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return null;
};
const latestActivity = (problem: any): number | null => {
  const timestamps = [
    problem.lastDraftEditedAt,
    problem.lastReviewedAt,
    problem.lastSubmittedAt,
    problem.currentStatusEnteredAt,
    problem._creationTime,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
};
const runSummary = (problem: any): Pick<OverviewChallenge, "totalRuns" | "passedRuns"> => {
  const stats = problem.aggStats;
  return {
    totalRuns: typeof stats?.totalRuns === "number" ? stats.totalRuns : null,
    passedRuns: typeof stats?.passedRuns === "number" ? stats.passedRuns : null,
  };
};
export type DashboardOverviewFilters = {
  includeArchived?: boolean;
  status?: string;
  language?: string;
  difficulty?: string;
  category?: string;
};
const normalizedFilter = (value: string | undefined): string | null => {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized !== "all" ? normalized : null;
};
const matchesFilter = (value: string | null, expected: string | null): boolean =>
  expected === null || value?.toLowerCase() === expected;
export async function readDashboardOverview(
  client: any,
  requested: DashboardOverviewFilters = {},
): Promise<OverviewSnapshot> {
  const prestigeRequest = (async () => {
    try {
      return await client.query(api.tierRotation.getMyPrestigeOutlook, {});
    } catch (error) {
      return { error: errorText(error) };
    }
  })();
  const [problems, balance, revisionTokens, prestige, transactions, tierTimeline] =
    await Promise.all([
      client.query(api.problems.listByUser, {}),
      client.query(api.contributorTokens.getBalance, {}).catch((error: unknown) => ({
        error: errorText(error),
      })),
      client.query(api.contributorTokens.getAllRevisionTokens, {}).catch((error: unknown) => ({
        error: errorText(error),
      })),
      prestigeRequest,
      client.query(api.contributorTokens.getTransactions, {}).catch((error: unknown) => ({
        error: errorText(error),
      })),
      client.query(api.contributorTokens.getTierWindowTimeline, {}).catch((error: unknown) => ({
        error: errorText(error),
      })),
    ]);
  if (!Array.isArray(problems)) throw new Error("Invalid challenge list response");
  const allChallenges = problems
    .filter((problem: any) => problem && typeof problem === "object" && problem._id != null)
    .map((problem: any): OverviewChallenge => {
      const latest = problem.latestVersion;
      const summary = runSummary(problem);
      const status = clean(problem.status ?? "unknown");
      return {
        id: String(problem._id),
        title: clean(problem.title ?? "Untitled challenge"),
        status,
        archived: problem.archived === true || status.toLowerCase() === "archived",
        version: typeof latest?.version === "number" ? latest.version : null,
        versionId: latest?._id == null ? null : String(latest._id),
        language: clean(latest?.language ?? problem.language) || null,
        difficulty: clean(latest?.difficulty ?? problem.difficulty) || null,
        category: clean(latest?.category ?? problem.category) || null,
        lastActivityAt: latestActivity(problem),
        totalRuns: summary.totalRuns,
        passedRuns: summary.passedRuns,
        finalized: typeof problem.finalized === "boolean" ? problem.finalized : null,
        reviewState: clean(latest?.reviewState ?? problem.reviewState) || null,
      };
    })
    .toSorted(
      (a, b) =>
        (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1)
        || a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
        || a.id.localeCompare(b.id),
    );
  const filters = {
    includeArchived: requested.includeArchived === true,
    status: normalizedFilter(requested.status),
    language: normalizedFilter(requested.language),
    difficulty: normalizedFilter(requested.difficulty),
    category: normalizedFilter(requested.category),
  };
  const available = (field: "status" | "language" | "difficulty" | "category") =>
    allChallenges
      .map((challenge) => challenge[field])
      .filter((value): value is string => value !== null)
      .filter((value, index, values) => values.indexOf(value) === index)
      .toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const challenges = allChallenges.filter(
    (challenge) =>
      (filters.includeArchived || !challenge.archived)
      && matchesFilter(challenge.status, filters.status)
      && matchesFilter(challenge.language, filters.language)
      && matchesFilter(challenge.difficulty, filters.difficulty)
      && matchesFilter(challenge.category, filters.category),
  );
  const archivedHidden = allChallenges.filter(
    (challenge) => challenge.archived && !filters.includeArchived,
  ).length;
  const balanceRecord =
    balance && typeof balance === "object" ? (balance as Record<string, any>) : {};
  const revisionRecord =
    revisionTokens && typeof revisionTokens === "object"
      ? (revisionTokens as Record<string, any>)
      : {};
  const prestigeRecord =
    prestige && typeof prestige === "object" && !Array.isArray(prestige)
      ? (prestige as Record<string, any>)
      : {};
  const balanceError = typeof balanceRecord.error === "string" ? balanceRecord.error : null;
  const revisionError = typeof revisionRecord.error === "string" ? revisionRecord.error : null;
  const prestigeError = typeof prestigeRecord.error === "string" ? prestigeRecord.error : null;
  const tierTimelineRecord =
    tierTimeline && typeof tierTimeline === "object" && !Array.isArray(tierTimeline)
      ? (tierTimeline as Record<string, any>)
      : {};
  const eloValue = numberValue(prestigeRecord.currentElo);
  const projectedElo = numberValue(prestigeRecord.projectedElo);
  const seatCutElo = numberValue(prestigeRecord.seatCutElo);
  const isMember = typeof prestigeRecord.isMember === "boolean" ? prestigeRecord.isMember : null;
  const acceptedAtRotation = numberValue(prestigeRecord.acceptedAtRotation);
  const acceptedNow = numberValue(prestigeRecord.acceptedNow);
  const windowDays = numberValue(prestigeRecord.windowDays);
  const nextRotationAt = numberValue(prestigeRecord.nextRotationAt);
  const timelineNow = numberValue(prestigeRecord.now);
  const agedOutBufferMs = numberValue(prestigeRecord.agedOutBufferMs);
  const agingOutByRotation = numberValue(prestigeRecord.agingOutByRotation);
  const usageRecord =
    prestigeRecord.usage
    && typeof prestigeRecord.usage === "object"
    && !Array.isArray(prestigeRecord.usage)
      ? prestigeRecord.usage
      : {};
  const usageBins = Array.isArray(usageRecord.bins)
    ? usageRecord.bins
        .map((value: unknown) => numberValue(value))
        .filter((value: number | null): value is number => value !== null)
    : [];
  const marks = Array.isArray(prestigeRecord.marks)
    ? prestigeRecord.marks
        .filter((mark: any) => numberValue(mark?.at) !== null)
        .map((mark: any) => ({
          at: numberValue(mark.at)!,
          countsAtRotation: mark.countsAtRotation === true,
          inWindow: mark.inWindow === true,
        }))
    : [];
  const revisionTotal = Array.isArray(revisionTokens)
    ? revisionTokens.reduce((sum: number, item: any) => sum + (numberValue(item?.balance) ?? 0), 0)
    : null;
  const nextTierRecord =
    balanceRecord.nextTierRequirement
    && typeof balanceRecord.nextTierRequirement === "object"
    && !Array.isArray(balanceRecord.nextTierRequirement)
      ? balanceRecord.nextTierRequirement
      : null;
  const fetchedAt = Date.now();
  const usage = summarizeTokenUsage(transactions, fetchedAt);
  const acceptedTimeline =
    typeof tierTimelineRecord.windowDays === "number"
    && typeof tierTimelineRecord.bufferDays === "number"
    && typeof tierTimelineRecord.now === "number"
    && Array.isArray(tierTimelineRecord.marks)
      ? {
          windowDays: tierTimelineRecord.windowDays,
          bufferDays: tierTimelineRecord.bufferDays,
          now: tierTimelineRecord.now,
          marks: tierTimelineRecord.marks
            .filter((mark: any) => numberValue(mark?.at) !== null)
            .map((mark: any) => ({
              at: numberValue(mark.at)!,
              lane: clean(mark.lane) || "unknown",
            })),
        }
      : null;
  return {
    fetchedAt,
    totalChallenges: allChallenges.length,
    archivedHidden,
    filters,
    availableFilters: {
      status: available("status"),
      language: available("language"),
      difficulty: available("difficulty"),
      category: available("category"),
    },
    challenges,
    tokens: {
      balance: numberValue(balanceRecord.balance),
      cap: numberValue(balanceRecord.cap),
      tierName: clean(balanceRecord.tierName) || null,
      nextDripAt: numberValue(balanceRecord.nextDripAt),
      acceptedInWindow: numberValue(balanceRecord.acceptedInWindow),
      olympusAcceptedInWindow: numberValue(balanceRecord.olympusAcceptedInWindow),
      lifetimeAccepted: numberValue(balanceRecord.lifetimeAccepted),
      pendingDrip: numberValue(balanceRecord.pendingDrip),
      dripPaused: typeof balanceRecord.dripPaused === "boolean" ? balanceRecord.dripPaused : null,
      dripUnlimited:
        typeof balanceRecord.dripUnlimited === "boolean" ? balanceRecord.dripUnlimited : null,
      nextTierRequirement: nextTierRecord
        ? {
            tierName: clean(nextTierRecord.tierName) || null,
            requiredAccepted: numberValue(nextTierRecord.requiredAccepted),
            requiredOlympus: numberValue(nextTierRecord.requiredOlympus),
            discounted:
              typeof nextTierRecord.discounted === "boolean" ? nextTierRecord.discounted : null,
          }
        : null,
      tierAcceptanceBonusUsd: numberValue(balanceRecord.tierAcceptanceBonusUsd),
      tierDripAmount: numberValue(balanceRecord.tierDripAmount),
      tierWindowDays: numberValue(balanceRecord.tierWindowDays),
      generalTokenBalance: numberValue(balanceRecord.generalTokenBalance),
      revisionTokenBalance: numberValue(balanceRecord.revisionTokenBalance) ?? revisionTotal,
      revisionError,
      usage,
      error: balanceError,
    },
    elo: {
      value: eloValue,
      projectedValue: projectedElo,
      rank: null,
      seatCutElo,
      isMember,
      acceptedAtRotation,
      acceptedNow,
      windowDays,
      nextRotationAt,
      timelineNow,
      agedOutBufferMs,
      agingOutByRotation,
      usage: {
        binMs: numberValue(usageRecord.binMs),
        bins: usageBins,
      },
      marks,
      available: eloValue !== null,
      note: prestigeError
        ? `Olympus prestige ELO unavailable: ${prestigeError}`
        : eloValue === null
          ? "Olympus prestige ELO is unavailable"
          : "Source: tierRotation.getMyPrestigeOutlook",
    },
    acceptedTimeline,
  };
}
/** Describe how current a record is, from its `scratched`/`stale` markers. */
const fresh = (data: any): "scratched" | "current" | "stale" | "unknown" => {
  if (data?.scratched) return "scratched";
  if (data?.stale === false) return "current";
  if (data?.stale === true) return "stale";
  return "unknown";
};
const pick = (data: any, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((key) => data?.[key] !== undefined)
      .map((key) => [key, typeof data[key] === "string" ? clean(data[key]) : data[key]]),
  );
const compactItem = (item: any) => ({
  ...pick(item, [
    "id",
    "_id",
    "key",
    "stageId",
    "stageName",
    "name",
    "label",
    "batchName",
    "batchTag",
    "status",
    "state",
    "stale",
    "scratched",
    "createdAt",
    "_creationTime",
    "completedAt",
    "progress",
    "currentStep",
    "error",
    "jobId",
  ]),
  output: {
    ...pick(item?.output, ["verdict", "message", "summary"]),
    evaluation: pick(item?.output?.evaluation, ["verdict", "summary"]),
  },
});
function compactSource(name: string, data: any): any {
  if (data === null || data === undefined) return null;
  if (name === "runs" || name === "prechecks")
    return data.filter((item: any) => item && typeof item === "object").map(compactItem);
  if (name === "review")
    return {
      slots: Object.fromEntries(
        Object.entries(data.slots ?? {}).map(([key, value]: [string, any]) => [
          key,
          value
            ? {
                ...pick(value, ["status", "stale"]),
                output: pick(value.output, [
                  "band",
                  "outcome",
                  "summary",
                  "description",
                  "tests",
                  "solution",
                  "effectiveScope",
                ]),
              }
            : null,
        ]),
      ),
    };
  if (name === "checks")
    return Object.fromEntries(
      getDynamicCheckEntries(data).map((item) => [item.key, compactItem(item)]),
    );
  if (name === "scope")
    return {
      ...pick(data, ["fresh", "freshPass", "latestVerdict", "inFlight", "status"]),
      current: compactItem(data.current),
    };
  if (name === "fp")
    return {
      ...pick(data, [
        "verdict",
        "inFlight",
        "jobStatus",
        "stale",
        "error",
        "summary",
        "message",
        "state",
        "status",
        "passed",
        "passesChangedSinceCheck",
        "completedAt",
        "requestedAt",
        "workingRunCount",
        "warnings",
      ]),
      output: pick(data.output, ["verdict", "summary", "message"]),
      job: data.job ? compactItem(data.job) : undefined,
    };
  if (name === "image")
    return pick(data, [
      "hasImage",
      "stale",
      "harborStatus",
      "rebuildSafeNeeded",
      "lastBuildFailedForCurrentInputs",
    ]);
  if (name === "build") return compactItem(data);
  if (name === "readiness")
    return {
      canSubmit: data.canSubmit,
      criteria: (Array.isArray(data.criteria) ? data.criteria : []).map((item: any) =>
        pick(item, ["id", "label", "status", "stale", "detail", "verdict"]),
      ),
    };
  if (name === "balance")
    return {
      ...pick(data, [
        "balance",
        "cap",
        "tokenCap",
        "generalTokenBalance",
        "revisionTokenBalance",
        "tierName",
        "tierOrder",
        "tierWindowDays",
        "tierDripAmount",
        "tierAcceptanceBonusUsd",
        "acceptedInWindow",
        "olympusAcceptedInWindow",
        "lifetimeAccepted",
        "pendingDrip",
        "dripPaused",
        "dripUnlimited",
        "nextDripAt",
      ]),
      nextTierRequirement: data.nextTierRequirement,
    };
  return pick(data, ["enabled", "scope", "limit", "spent", "reserved", "remaining"]);
}

export async function readDashboard(
  client: any,
  id: string,
  previous?: Snapshot,
): Promise<Snapshot> {
  const data = await client.query(api.problems.getWithLatestVersion, {
    problemId: id,
  });
  if (!data) throw new Error("Challenge not found");
  const version = data.latestVersion;
  const versionId = version?._id ?? null;
  const same = previous?.versionId === versionId;
  const jobs: Record<string, () => Promise<any>> = {
    balance: () => client.query(api.contributorTokens.getBalance, {}),
    budget: () => localBudgetStatus(client, id),
  };
  if (versionId)
    Object.assign(jobs, {
      prechecks: () => client.query(api.stages.getByVersion, { versionId }),
      review: () =>
        client.query(api.orchestratorReview.getOrchestratorReview, {
          versionId,
        }),
      checks: () => client.query(api.runDynamicChecks.getDynamicChecks, { versionId }),
      runs: () => client.query(api.runAgentRuns.getAgentRuns, { versionId }),
      readiness: () =>
        client.query(api.submissionReadiness.getSubmissionReadiness, {
          problemId: id,
        }),
      scope: () => client.query(api.scopeGate.getScopeGate, { versionId }),
      image: () => client.query(api.dockerImage.getImageStatus, { versionId }),
      build: () =>
        client.query(api.dockerImage.getLatestBuildJobForVersion, {
          versionId,
        }),
      fp: () => client.query(api.fpReview.getFpCheckForVersion, { versionId }),
    });
  const sources: Record<string, Source> = {};
  await Promise.all(
    Object.entries(jobs).map(async ([name, query]) => {
      try {
        const result = await query();
        if (result?.error && name === "budget") throw new Error(result.error);
        if (["prechecks", "runs"].includes(name) && !Array.isArray(result))
          throw new Error("Invalid list response");
        sources[name] = {
          data: compactSource(name, result),
          updatedAt: Date.now(),
          error: null,
        };
      } catch (error) {
        const old = same ? previous?.sources[name] : undefined;
        sources[name] = {
          data: old?.data ?? null,
          updatedAt: old?.updatedAt ?? null,
          error: errorText(error),
        };
      }
    }),
  );
  const confirm = await client.query(api.problems.getWithLatestVersion, {
    problemId: id,
  });
  if ((confirm?.latestVersion?._id ?? null) !== versionId)
    throw new Error("Version changed during refresh; retrying without mixing versions");
  return {
    id,
    title: clean(data.title),
    status: clean(data.status),
    version: version?.version ?? null,
    versionId,
    fetchedAt: Date.now(),
    sources,
  };
}

function row(key: string, label: unknown, item: any): Row {
  const output = item?.output ?? {};
  const verdict =
    output.verdict ?? output.evaluation?.verdict ?? item?.latestVerdict ?? item?.verdict;
  return {
    key,
    label: clean(label),
    progress:
      typeof item?.progress === "number"
      && Number.isFinite(item.progress)
      && item.progress >= 0
      && item.progress <= 100
        ? item.progress
        : undefined,
    status: clean(item?.inFlight ? "running" : (item?.status ?? item?.state ?? "not_run")),
    verdict: clean(verdict),
    freshness: fresh(item),
    detail: clean(
      item?.error
        ?? output.message
        ?? output.summary
        ?? output.evaluation?.summary
        ?? item?.currentStep
        ?? item?.message
        ?? item?.detail
        ?? "",
    ),
  };
}

/** Reads one named source out of a snapshot. */
type SourceReader = (name: string) => any;

/**
 * Collapse the precheck stages to the newest record per stage, falling back to
 * the readiness criterion when no stage has reported yet.
 */
function precheckRows(source: SourceReader): Row[] {
  const latest = new Map<string, any>();
  for (const stage of Array.isArray(source("prechecks")) ? source("prechecks") : []) {
    if (!stage || typeof stage !== "object") continue;
    const key = String(stage.stageId ?? stage.id ?? stage._id);
    const previous = latest.get(key);
    const stageAt = stage.createdAt ?? stage._creationTime ?? 0;
    const previousAt = previous ? (previous.createdAt ?? previous._creationTime ?? 0) : -1;
    if (!previous || stageAt >= previousAt) latest.set(key, stage);
  }
  const criterion = source("readiness")?.criteria?.find((item: any) => item.id === "prechecks");
  const stageDetails = [...latest.entries()].map(
    ([key, stage]) =>
      `${clean(stage.stageName ?? stage.name ?? key)}: ${clean(stage.status ?? "unknown")}${stage.error ? ` — ${clean(stage.error)}` : ""}`,
  );
  return [
    row("stage:summary", "Prechecks", {
      ...criterion,
      status: criterion?.status ?? "unknown",
      detail: [
        criterion?.detail
          ?? "Precheck readiness unavailable; stage results do not establish freshness.",
        ...stageDetails,
      ].join(" | "),
    }),
  ];
}

/** Scope Gate row, merging the in-flight flag over the last recorded verdict. */
function scopeRow(source: SourceReader): Row {
  const scope = source("scope");
  return row("scope", "Scope Gate", {
    ...scope,
    ...scope?.current,
    stale: typeof scope?.fresh === "boolean" ? !scope.fresh : undefined,
    status: scope?.inFlight ? "running" : (scope?.current?.status ?? scope?.latestVerdict),
  });
}

/** Image/build row, combining the build job with image availability. */
function imageRow(source: SourceReader): Row {
  const image = source("image");
  const build = source("build");
  return row("image", "Image / Build", {
    ...build,
    stale: image?.stale,
    status: build?.status ?? (image?.hasImage ? "available" : "not_run"),
    detail: image?.harborStatus,
  });
}

/** Display order for the dynamic quality checks. */
const CHECK_UI_ORDER = [
  "verifyTests",
  "verifySolution",
  "verifyFairness",
  "testQuality",
  "verifyFlakiness",
  "taskQuality",
  "solutionQuality",
  "descriptionQuality",
];

/**
 * Sort key for a check row: pipeline stages first, then scope and image, then
 * the quality checks in {@link CHECK_UI_ORDER}; unknown keys sort last.
 */
function checkRank(item: Row): number {
  if (item.key.startsWith("stage:")) return -3;
  if (item.key === "scope") return -2;
  if (item.key === "image") return -1;
  const index = CHECK_UI_ORDER.indexOf(item.key.replace("check:", ""));
  return index >= 0 ? index : CHECK_UI_ORDER.length;
}

/** Titles for the orchestrator review slots. */
const REVIEW_SLOT_KEYS = ["description", "tests", "solution", "agents"];

/** Verdict text for one orchestrator review slot. */
function reviewVerdict(key: string, output: any, criterion: any): string | undefined {
  if (key === "synthesis") return output?.outcome;
  return typeof criterion?.band === "number" ? `BAND ${criterion.band}` : undefined;
}

/**
 * Expand the multi-slot orchestrator review into one row per dimension.
 *
 * A completed, fresh synthesis supersedes an individual slot, so the row shows
 * the synthesised judgement rather than the slot's own stale result.
 */
function reviewRows(slots: any): Row[] {
  const rows: Row[] = [];
  for (const key of REVIEW_SLOT_KEYS) {
    const slot = slots[key];
    const output = slot?.output;
    const synthesis = slots.synthesis;
    const useSynthesis =
      synthesis?.status === "completed"
      && synthesis?.stale === false
      && (!slot || (slot.status === "completed" && slot.stale === false))
      && synthesis.output?.[key] != null;
    const resultSlot = useSynthesis ? synthesis : slot;
    const criterion = useSynthesis ? synthesis.output[key] : output;
    rows.push(
      row(`review:${key}`, key === "synthesis" ? "Overall" : key[0].toUpperCase() + key.slice(1), {
        ...resultSlot,
        output: {
          verdict: reviewVerdict(key, output, criterion),
          summary: criterion?.summary ?? criterion?.reasoning,
        },
      }),
    );
  }
  const scope = slots.synthesis?.output?.effectiveScope;
  if (scope) {
    rows.push(
      row("review:scope", "Effective scope", {
        ...slots.synthesis,
        output: { verdict: scope.verdict, summary: scope.reasoning },
      }),
    );
  }
  return rows;
}

/** Status of the FP check, which reports it under several different keys. */
function fpStatus(fp: any): string | undefined {
  if (fp.inFlight) return "running";
  const reported = fp.state ?? fp.status ?? fp.job?.status ?? fp.jobStatus;
  if (reported) return reported;
  const finished =
    fp.verdict || fp.output?.verdict || typeof fp.passed === "boolean" || fp.completedAt;
  return finished ? "completed" : undefined;
}

/** Verdict of the FP check, normalising the boolean form to PASS/FAIL. */
function fpVerdict(fp: any): string | undefined {
  const reported = fp.verdict ?? fp.output?.verdict ?? fp.job?.output?.verdict;
  if (reported) return reported;
  if (typeof fp.passed !== "boolean") return undefined;
  return fp.passed ? "PASS" : "FAIL";
}

/** FP check row, flattening the several shapes the backend reports it in. */
function fpRow(source: SourceReader): Row {
  const fp = source("fp");
  if (!fp) return row("fp", "FP Check", fp);
  return row("fp", "FP Check", {
    ...fp,
    status: fpStatus(fp),
    stale: fp.passesChangedSinceCheck === true ? true : fp.stale,
    verdict: fpVerdict(fp),
    output: {
      summary: fp.summary ?? fp.output?.summary ?? fp.job?.output?.summary,
      message: fp.message ?? fp.output?.message ?? fp.job?.output?.message,
    },
    error: fp.error ?? fp.job?.error,
  });
}

/** Rollout rows, grouped by batch with current runs listed before stale ones. */
function runRows(source: SourceReader): Row[] {
  const runs: Row[] = (source("runs") ?? []).map((run: any, index: number) =>
    Object.assign(row(`run:${run.id ?? run._id ?? index}`, run.label ?? run.id ?? "Run", run), {
      batch: clean(run.batchName ?? run.batchTag ?? "Ungrouped"),
    }),
  );
  runs.sort(
    (a: Row, b: Row) =>
      (a.freshness === "current" ? 0 : 1) - (b.freshness === "current" ? 0 : 1)
      || (a.batch ?? "").localeCompare(b.batch ?? "")
      || a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
  return runs;
}

/**
 * Flatten a snapshot into the three row lists the dashboard renders.
 *
 * Each section is built by its own helper above; this function only decides
 * which sections appear and in what order.
 */
export function dashboardRows(snapshot: Snapshot): {
  checks: Row[];
  runs: Row[];
  readiness: Row[];
} {
  const source: SourceReader = (name) => snapshot.sources[name]?.data;
  const checks: Row[] = [
    ...precheckRows(source),
    scopeRow(source),
    imageRow(source),
    ...getDynamicCheckEntries(source("checks")).map((check) =>
      row(`check:${check.key}`, formatDynamicCheckLabel(check.key), check),
    ),
  ];
  checks.sort((a, b) => checkRank(a) - checkRank(b));

  const slots = source("review")?.slots;
  if (slots && Object.values(slots).some(Boolean)) {
    const prior = checks.findIndex((item) => item.key === "check:autoReview");
    if (prior >= 0) checks.splice(prior, 1);
    checks.push(...reviewRows(slots));
  }
  checks.push(fpRow(source));

  const readiness = (source("readiness")?.criteria ?? []).map((criterion: any) =>
    row(`ready:${criterion.id}`, criterion.label, criterion),
  );
  return { checks, runs: runRows(source), readiness };
}

export function observedChanges(before: Snapshot | undefined, after: Snapshot): string[] {
  if (!before) return ["First snapshot received; activity covers this session only"];
  if (before.versionId !== after.versionId)
    return [`Version changed: v${before.version ?? "none"} -> v${after.version ?? "none"}`];
  const old = dashboardRows(before),
    next = dashboardRows(after);
  const changes: string[] = [];
  if (before.status !== after.status)
    changes.push(`Challenge: ${before.status} -> ${after.status}`);
  const prior = new Map([...old.checks, ...old.runs].map((item) => [item.key, item]));
  for (const item of [...next.checks, ...next.runs]) {
    const prev = prior.get(item.key);
    if (
      !prev
      || [prev.status, prev.verdict, prev.freshness].join(",")
        !== [item.status, item.verdict, item.freshness].join(",")
    )
      changes.push(`${item.label}: ${item.status} ${item.verdict} (${item.freshness})`);
  }
  return changes;
}
