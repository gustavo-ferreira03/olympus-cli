import { api, localBudgetStatus } from "../platform/convex.ts";
import { validationResultsToStages } from "../platform/prechecks.ts";
import { getDynamicCheckEntries, formatDynamicCheckLabel } from "../core/model.ts";
import { PRECHECK_STAGE_IDS } from "../core/expected.ts";
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
  submissionType: string | null;
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
  createdAt: number | null;
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
    rejectedInWindow: number | null;
    tierIsBeginner: boolean | null;
    comeback: Record<string, unknown> | null;
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
    history: Array<{ reason: string; amount: number; balance: number | null; at: number }>;
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
    boosts: Array<{
      category: string;
      multiplier: number;
      startsAt: number;
      endsAt: number | null;
    }>;
    questPaused: boolean;
    available: boolean;
    note: string;
  };
  revisionRequests: {
    items: Array<{
      id: string;
      title: string;
      feedback: string | null;
      reviewerName: string | null;
      reviewedAt: number | null;
    }>;
    error: string | null;
  };
  acceptedTimeline: {
    windowDays: number;
    bufferDays: number;
    now: number;
    paused: boolean;
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
async function readFreshBalance(client: any): Promise<any> {
  const balance = await client.query(api.contributorTokens.getBalance, {});
  if (balance?.needsRefresh !== true) return balance;
  await client.mutation(api.contributorTokens.refreshBalance, {});
  return client.query(api.contributorTokens.getBalance, {});
}

export type SourceQuery = {
  name: string;
  reference: any;
  args: Record<string, unknown>;
  transform?: (raw: unknown) => unknown;
  fallback?: { reference: any; args: Record<string, unknown> };
};

export const OVERVIEW_QUERIES: SourceQuery[] = [
  { name: "problems", reference: api.problems.listByUser, args: {} },
  { name: "balance", reference: api.contributorTokens.getBalance, args: {} },
  { name: "revisionTokens", reference: api.contributorTokens.getAllRevisionTokens, args: {} },
  { name: "prestige", reference: api.tierRotation.getMyPrestigeOutlook, args: {} },
  { name: "transactions", reference: api.contributorTokens.getTransactions, args: {} },
  { name: "tierTimeline", reference: api.contributorTokens.getTierWindowTimeline, args: {} },
  { name: "revisionRequests", reference: api.dashboard.getRevisionRequests, args: {} },
];

export type OverviewRaw = Record<string, unknown>;

export function overviewValue(name: string, value: unknown): unknown {
  return name === "problems" ? slimProblems(value) : value;
}

export async function readDashboardOverview(
  client: any,
  requested: DashboardOverviewFilters = {},
): Promise<OverviewSnapshot> {
  const raw: OverviewRaw = {};
  await Promise.all(
    OVERVIEW_QUERIES.map(async ({ name, reference, args }) => {
      try {
        const value =
          name === "balance" ? await readFreshBalance(client) : await client.query(reference, args);
        raw[name] = overviewValue(name, value);
      } catch (error) {
        if (name === "problems") throw error;
        raw[name] = { error: errorText(error) };
      }
    }),
  );
  return buildOverview(raw, requested);
}

function slimProblems(problems: unknown): unknown {
  if (!Array.isArray(problems)) return problems;
  const keep = (value: any, keys: string[]) =>
    value && typeof value === "object"
      ? Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]))
      : value;
  return problems.map((problem: any) =>
    problem && typeof problem === "object"
      ? Object.assign(
          keep(problem, [
            "_id",
            "_creationTime",
            "title",
            "status",
            "archived",
            "language",
            "difficulty",
            "category",
            "finalized",
            "reviewState",
            "lastDraftEditedAt",
            "lastReviewedAt",
            "lastSubmittedAt",
            "currentStatusEnteredAt",
          ]),
          {
            aggStats: keep(problem.aggStats, ["totalRuns", "passedRuns"]),
            latestVersion: keep(problem.latestVersion, [
              "_id",
              "version",
              "language",
              "difficulty",
              "category",
              "reviewState",
            ]),
          },
        )
      : problem,
  );
}

export function buildOverview(
  raw: OverviewRaw,
  requested: DashboardOverviewFilters = {},
): OverviewSnapshot {
  const {
    problems,
    balance,
    revisionTokens,
    prestige,
    transactions,
    tierTimeline,
    revisionRequests,
  } = raw as Record<string, any>;
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
        createdAt: numberValue(problem._creationTime),
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
          paused: tierTimelineRecord.paused === true,
          marks: tierTimelineRecord.marks
            .filter((mark: any) => numberValue(mark?.at) !== null)
            .map((mark: any) => ({
              at: numberValue(mark.at)!,
              lane: clean(mark.lane) || "unknown",
            })),
        }
      : null;
  let prestigeNote = "Source: tierRotation.getMyPrestigeOutlook";
  if (eloValue === null) prestigeNote = "Olympus prestige ELO is unavailable";
  if (prestigeError) prestigeNote = `Olympus prestige ELO unavailable: ${prestigeError}`;
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
      rejectedInWindow: numberValue(balanceRecord.rejectedInWindow),
      tierIsBeginner:
        typeof balanceRecord.tierIsBeginner === "boolean" ? balanceRecord.tierIsBeginner : null,
      comeback:
        balanceRecord.comeback && typeof balanceRecord.comeback === "object"
          ? balanceRecord.comeback
          : null,
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
      history: (Array.isArray(transactions) ? transactions : [])
        .filter((item: any) => numberValue(item?.amount) !== null)
        .slice(0, 5)
        .map((item: any) => ({
          reason: clean(item.reason) || "unknown",
          amount: numberValue(item.amount)!,
          balance: numberValue(item.balance),
          at: numberValue(item.createdAt) ?? numberValue(item._creationTime) ?? 0,
        })),
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
      boosts: (Array.isArray(prestigeRecord.boosts) ? prestigeRecord.boosts : [])
        .filter(
          (boost: any) =>
            numberValue(boost?.startsAt) !== null
            && boost.startsAt <= fetchedAt
            && (boost.endsAt == null || boost.endsAt > fetchedAt),
        )
        .map((boost: any) => ({
          category: clean(boost.category),
          multiplier: numberValue(boost.multiplier) ?? 1,
          startsAt: boost.startsAt,
          endsAt: numberValue(boost.endsAt),
        })),
      questPaused: prestigeRecord.questPaused === true,
      available: eloValue !== null,
      note: prestigeNote,
    },
    revisionRequests: {
      items: Array.isArray(revisionRequests)
        ? revisionRequests
            .filter((item: any) => item?._id != null)
            .map((item: any) => ({
              id: String(item._id),
              title: clean(item.title) || "Untitled",
              feedback: clean(item.feedback) || null,
              reviewerName: clean(item.reviewerName) || null,
              reviewedAt: numberValue(item.reviewedAt),
            }))
        : [],
      error: typeof revisionRequests?.error === "string" ? revisionRequests.error : null,
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
    "contested",
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
  if (name === "delivery")
    return pick(data, [
      "status",
      "progress",
      "progressStep",
      "failureSummary",
      "clickedAt",
      "updatedAt",
    ]);
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

type Head = Pick<Snapshot, "title" | "status" | "submissionType" | "version" | "versionId">;

export function headFromProblem(data: any): Head {
  if (!data) throw new Error("Challenge not found");
  return {
    title: clean(data.title),
    status: clean(data.status),
    submissionType: clean(data.submissionType) || null,
    version: data.latestVersion?.version ?? null,
    versionId: data.latestVersion?._id ?? null,
  };
}

export function challengeQueries(id: string, versionId: string | null): SourceQuery[] {
  const queries: SourceQuery[] = [
    { name: "balance", reference: api.contributorTokens.getBalance, args: {} },
    {
      name: "readiness",
      reference: api.submissionReadiness.getSubmissionReadiness,
      args: { problemId: id },
    },
    {
      name: "delivery",
      reference: api.deliveryVerify.getSubmitVerification,
      args: { problemId: id },
    },
  ];
  if (!versionId) return queries;
  const scoped = (name: string, reference: any) => ({ name, reference, args: { versionId } });
  return [
    ...queries,
    {
      name: "prechecks",
      reference: api.stages.getValidationResults,
      args: { itemId: id, versionId },
      transform: validationResultsToStages,
      fallback: { reference: api.stages.getByVersion, args: { versionId } },
    },
    scoped("review", api.orchestratorReview.getOrchestratorReview),
    scoped("checks", api.runDynamicChecks.getDynamicChecks),
    scoped("runs", api.runAgentRuns.getAgentRuns),
    scoped("scope", api.scopeGate.getScopeGate),
    scoped("image", api.dockerImage.getImageStatus),
    scoped("build", api.dockerImage.getLatestBuildJobForVersion),
    scoped("fp", api.fpReview.getFpCheckForVersion),
  ];
}

export function sourceFromResult(name: string, result: any): Source {
  if (result?.error && name === "budget") throw new Error(result.error);
  if (["prechecks", "runs"].includes(name) && !Array.isArray(result))
    throw new Error("Invalid list response");
  return { data: compactSource(name, result), updatedAt: Date.now(), error: null };
}

export function failedSource(error: unknown, previous?: Source): Source {
  return {
    data: previous?.data ?? null,
    updatedAt: previous?.updatedAt ?? null,
    error: errorText(error),
  };
}

export function buildSnapshot(id: string, head: Head, sources: Record<string, Source>): Snapshot {
  return { id, ...head, fetchedAt: Date.now(), sources };
}

export async function readDashboard(client: any, id: string): Promise<Snapshot> {
  const head = headFromProblem(
    await client.query(api.problems.getWithLatestVersion, { problemId: id }),
  );
  const reads: Record<string, () => Promise<any>> = {
    budget: () => localBudgetStatus(client, id),
  };
  for (const { name, reference, args, transform, fallback } of challengeQueries(id, head.versionId))
    reads[name] = async () => {
      try {
        const value = await client.query(reference, args);
        return transform ? transform(value) : value;
      } catch (error) {
        if (!fallback) throw error;
        return client.query(fallback.reference, fallback.args);
      }
    };
  reads.balance = () => readFreshBalance(client);
  const sources: Record<string, Source> = {};
  await Promise.all(
    Object.entries(reads).map(async ([name, read]) => {
      try {
        sources[name] = sourceFromResult(name, await read());
      } catch (error) {
        sources[name] = failedSource(error);
      }
    }),
  );
  return buildSnapshot(id, head, sources);
}

const IN_FLIGHT_STATUS = /^(running|pending|queued|processing|building)$/i;

function row(key: string, label: unknown, item: any): Row {
  const output = item?.output ?? {};
  const verdict =
    output.verdict ?? output.evaluation?.verdict ?? item?.latestVerdict ?? item?.verdict;
  const status = clean(item?.inFlight ? "running" : (item?.status ?? item?.state ?? "not_run"));
  const freshness = IN_FLIGHT_STATUS.test(status) && !item?.scratched ? "current" : fresh(item);
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
    status,
    verdict: clean(verdict),
    freshness,
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

const PRECHECK_STAGE_LABELS: Record<string, string> = {
  github_setup: "GitHub Repository",
  problem_and_tests: "Problem Description & Tests",
  plagiarism_review: "Plagiarism Review",
  dockerfile: "Dockerfile",
  solution_patch: "Solution Patch",
};

function stageDetail(stage: any): string {
  const failures = (Array.isArray(stage.checks) ? stage.checks : [])
    .filter((check: any) => /fail|error/i.test(String(check?.status ?? "")))
    .map((check: any) => clean(`${check.id ?? "check"}: ${check.message ?? check.status}`));
  const missing = Array.isArray(stage.missingFields)
    ? [`missing ${stage.missingFields.map(clean).join(", ")}`]
    : [];
  return [stage.error ? clean(stage.error) : "", ...missing, ...failures]
    .filter(Boolean)
    .join(" | ");
}

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
  if (latest.size === 0) {
    const criterion = source("readiness")?.criteria?.find((item: any) => item.id === "prechecks");
    return [
      row("stage:summary", "Prechecks", {
        ...criterion,
        status: criterion ? requirementStatus(criterion) : "not_run",
        detail: criterion?.detail ?? "No precheck stage has reported for this version.",
      }),
    ];
  }
  const order = (key: string) => {
    const index = (PRECHECK_STAGE_IDS as readonly string[]).indexOf(key);
    return index === -1 ? PRECHECK_STAGE_IDS.length : index;
  };
  return [...latest.entries()]
    .toSorted(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([key, stage]) =>
      row(`stage:${key}`, PRECHECK_STAGE_LABELS[key] ?? stage.stageName ?? stage.name ?? key, {
        ...stage,
        detail: stageDetail(stage),
      }),
    );
}

/** Scope Gate row, merging the in-flight flag over the last recorded verdict. */
function scopeRow(source: SourceReader): Row {
  const scope = source("scope");
  const verdict = scope?.current?.output?.verdict ?? scope?.latestVerdict;
  return row("scope", "Scope Gate", {
    ...scope,
    ...scope?.current,
    stale: typeof scope?.fresh === "boolean" ? !scope.fresh : undefined,
    status: scope?.inFlight ? "running" : (scope?.current?.status ?? scope?.latestVerdict),
    output: { ...scope?.current?.output, verdict: verdict === "drop" ? "FAIL" : verdict },
  });
}

function imageRow(source: SourceReader): Row {
  const image = source("image");
  const build = source("build");
  const buildStatus = String(build?.status ?? "").toLowerCase();
  let status = image?.hasImage ? "completed" : "not_run";
  if (buildStatus === "pending" || buildStatus === "running") status = buildStatus;
  else if (buildStatus === "failed" || image?.lastBuildFailedForCurrentInputs) status = "failed";
  const building = status === "pending" || status === "running";
  return row("image", "Image / Build", {
    progress: build?.progress,
    stale: image?.stale,
    status,
    error: status === "failed" ? build?.error : undefined,
    detail: join([
      image?.harborStatus && `harbor ${image.harborStatus}`,
      building ? build?.currentStep : null,
    ]),
  });
}

const join = (parts: Array<string | null | false | undefined>) =>
  parts.filter((part): part is string => Boolean(part)).join(" · ");

const CHECK_UI_ORDER = [
  "verifyTests",
  "verifySolution",
  "testQuality",
  "verifyFlakiness",
  "taskQuality",
  "solutionQuality",
  "descriptionQuality",
  "verifierIncompleteness",
  "rolloutCoach",
];
const AUDIT_CHECK_KEYS = new Set(["check:verifierIncompleteness", "check:rolloutCoach"]);
const BUILD_ROW_KEYS = new Set(["image", "scope"]);

function checkRank(item: Row): number {
  if (item.key.startsWith("stage:")) return -10;
  if (item.key === "image") return -9;
  if (item.key === "scope") return -8;
  if (item.key.startsWith("review:")) return 100;
  if (item.key === "fp") return 101;
  const index = CHECK_UI_ORDER.indexOf(item.key.replace("check:", ""));
  return index >= 0 ? index : CHECK_UI_ORDER.length;
}

/** Titles for the orchestrator review slots. */
const REVIEW_SLOT_LABELS: Record<string, string> = {
  description: "Task Prompt",
  tests: "Tests",
  solution: "Solution",
  agents: "Agent runs",
};

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
  for (const [key, label] of Object.entries(REVIEW_SLOT_LABELS)) {
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
      row(`review:${key}`, label, {
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

function requirementStatus(criterion: any): string {
  const status = String(criterion?.status ?? "").toLowerCase();
  if (status === "pass" || status === "fail" || status === "warn") return status;
  if (status === "pending" && /\brunning\b/i.test(String(criterion?.detail ?? "")))
    return "running";
  return "not_run";
}

export function deliveryFailure(snapshot: Snapshot): string | null {
  const delivery = snapshot.sources.delivery?.data;
  const status = String(delivery?.status ?? "").toLowerCase();
  if (status !== "failed" && status !== "errored") return null;
  return clean(delivery.failureSummary) || `verification ${status}`;
}

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
    ...Object.values<any>(source("checks") ?? {}).map((check) =>
      row(`check:${check.key}`, formatDynamicCheckLabel(check.key), check),
    ),
  ];
  const slots = source("review")?.slots;
  if (slots && Object.values(slots).some(Boolean)) {
    const prior = checks.findIndex((item) => item.key === "check:autoReview");
    if (prior >= 0) checks.splice(prior, 1);
    checks.push(...reviewRows(slots));
  } else {
    const prior = checks.find((item) => item.key === "check:autoReview");
    if (prior) prior.key = "review:autoReview";
  }
  checks.push(fpRow(source));
  checks.sort((a, b) => checkRank(a) - checkRank(b));

  const readiness = (source("readiness")?.criteria ?? []).map((criterion: any) =>
    row(`ready:${criterion.id}`, criterion.label, {
      ...criterion,
      status: requirementStatus(criterion),
    }),
  );
  return { checks, runs: runRows(source), readiness };
}

export function dashboardSections(
  data: ReturnType<typeof dashboardRows>,
  history: boolean,
  showReadiness = false,
): Array<{ title: string; items: Row[]; section: number }> {
  const group = (match: (item: Row) => boolean) => data.checks.filter(match);
  const sections = [
    { title: "Prechecks", items: group((item) => item.key.startsWith("stage:")), section: 0 },
    { title: "Build & Scope", items: group((item) => BUILD_ROW_KEYS.has(item.key)), section: 0 },
    {
      title: "Quality Checks",
      items: group(
        (item) =>
          item.key.startsWith("check:")
          && !BUILD_ROW_KEYS.has(item.key)
          && !AUDIT_CHECK_KEYS.has(item.key),
      ),
      section: 0,
    },
    { title: "Audits", items: group((item) => AUDIT_CHECK_KEYS.has(item.key)), section: 0 },
    { title: "Auto Review", items: group((item) => item.key.startsWith("review:")), section: 0 },
    {
      title: "FP Check",
      items: group((item) => item.key === "fp"),
      section: 0,
    },
    {
      title: history ? "Rollouts · history" : "Rollouts",
      items: history ? data.runs : data.runs.filter((item) => item.freshness === "current"),
      section: 1,
    },
  ].filter((section) => section.section !== 0 || section.items.length > 0);
  if (showReadiness) sections.push({ title: "Readiness", items: data.readiness, section: 2 });
  return sections;
}

type Rows = ReturnType<typeof dashboardRows>;

export function observedChanges(
  before: Snapshot | undefined,
  after: Snapshot,
  rows: { before?: Rows; after?: Rows } = {},
): string[] {
  if (!before) return ["First snapshot received; activity covers this session only"];
  if (before.versionId !== after.versionId)
    return [`Version changed: v${before.version ?? "none"} -> v${after.version ?? "none"}`];
  const old = rows.before ?? dashboardRows(before),
    next = rows.after ?? dashboardRows(after);
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

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_solution: "Awaiting Solution",
  pending_review: "Pending Review",
  revision_requested: "Revision Requested",
  finalizing_review: "Finalizing Review",
  accepted: "Accepted",
  rejected: "Rejected",
  archived: "Archived",
};

export const OVERVIEW_TABS = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "pending_review", label: "Pending Review" },
  { id: "revision_requested", label: "Revision Needed" },
  { id: "finalizing_review", label: "Finalizing Review" },
  { id: "accepted", label: "Accepted" },
  { id: "rejected", label: "Rejected" },
] as const;

export function inOverviewTab(tab: string, status: string): boolean {
  const value = status.toLowerCase();
  if (tab === "all") return true;
  if (tab === "pending_review") return value === "pending_review" || value === "pending_solution";
  return value === tab;
}

export function visibleChallenges(
  overview: OverviewSnapshot | undefined,
  tab = "all",
): OverviewChallenge[] {
  return (overview?.challenges ?? []).filter((challenge) => inOverviewTab(tab, challenge.status));
}
