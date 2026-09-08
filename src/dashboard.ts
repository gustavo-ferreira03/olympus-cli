import { api, localBudgetStatus } from "./convex.ts";
import { getDynamicCheckEntries, formatDynamicCheckLabel } from "./model.ts";
import { sanitizeDiagnostic } from "./errors.ts";

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
export type Row = {
  key: string;
  label: string;
  status: string;
  verdict: string;
  freshness: string;
  detail: string;
  batch?: string;
};
export const clean = (value: unknown): string =>
  sanitizeDiagnostic(String(value ?? "")).replace(/[\r\n\t]/g, " ");
const errorText = (error: unknown) =>
  clean(error instanceof Error ? error.message : error).slice(0, 300);
const fresh = (data: any) =>
  data?.scratched
    ? "scratched"
    : data?.stale === false
      ? "current"
      : data?.stale === true
        ? "stale"
        : "unknown";
const pick = (data: any, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((key) => data?.[key] !== undefined)
      .map((key) => [
        key,
        typeof data[key] === "string" ? clean(data[key]) : data[key],
      ]),
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
    return data
      .filter((item: any) => item && typeof item === "object")
      .map(compactItem);
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
      ...pick(data, [
        "fresh",
        "freshPass",
        "latestVerdict",
        "inFlight",
        "status",
      ]),
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
      criteria: (Array.isArray(data.criteria) ? data.criteria : []).map(
        (item: any) =>
          pick(item, ["id", "label", "status", "stale", "detail", "verdict"]),
      ),
    };
  return pick(
    data,
    name === "balance"
      ? [
          "balance",
          "cap",
          "tokenCap",
          "generalTokenBalance",
          "revisionTokenBalance",
          "tierName",
        ]
      : ["enabled", "scope", "limit", "spent", "reserved", "remaining"],
  );
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
      checks: () =>
        client.query(api.runDynamicChecks.getDynamicChecks, { versionId }),
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
    throw new Error(
      "Version changed during refresh; retrying without mixing versions",
    );
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
    output.verdict ??
    output.evaluation?.verdict ??
    item?.latestVerdict ??
    item?.verdict;
  return {
    key,
    label: clean(label),
    status: clean(
      item?.inFlight ? "running" : (item?.status ?? item?.state ?? "not_run"),
    ),
    verdict: clean(verdict),
    freshness: fresh(item),
    detail: clean(
      item?.error ??
        output.message ??
        output.summary ??
        output.evaluation?.summary ??
        item?.currentStep ??
        item?.message ??
        item?.detail ??
        "",
    ),
  };
}

export function dashboardRows(snapshot: Snapshot): {
  checks: Row[];
  runs: Row[];
  readiness: Row[];
} {
  const source = (name: string) => snapshot.sources[name]?.data;
  const checks: Row[] = [];
  const latest = new Map<string, any>();
  for (const stage of source("prechecks") ?? []) {
    const key = String(stage.stageId ?? stage.id ?? stage._id);
    if (
      !latest.has(key) ||
      (stage.createdAt ?? stage._creationTime ?? 0) >=
        (latest.get(key).createdAt ?? latest.get(key)._creationTime ?? 0)
    )
      latest.set(key, stage);
  }
  for (const [key, stage] of latest)
    checks.push(
      row(`stage:${key}`, stage.stageName ?? stage.name ?? key, stage),
    );
  if (!latest.size) {
    const criterion = source("readiness")?.criteria?.find(
      (item: any) => item.id === "prechecks",
    );
    checks.push(row("stage:summary", "Prechecks", criterion));
  }
  const scope = source("scope");
  checks.push(
    row("scope", "Scope Gate", {
      ...scope,
      ...scope?.current,
      stale: typeof scope?.fresh === "boolean" ? !scope.fresh : undefined,
      status: scope?.inFlight
        ? "running"
        : (scope?.current?.status ?? scope?.latestVerdict),
    }),
  );
  const image = source("image"),
    build = source("build");
  checks.push(
    row("image", "Image / Build", {
      ...build,
      stale: image?.stale,
      status: build?.status ?? (image?.hasImage ? "available" : "not_run"),
      detail: image?.harborStatus,
    }),
  );
  for (const check of getDynamicCheckEntries(source("checks")))
    checks.push(
      row(`check:${check.key}`, formatDynamicCheckLabel(check.key), check),
    );
  const uiOrder = [
    "verifyTests",
    "verifySolution",
    "verifyFairness",
    "testQuality",
    "verifyFlakiness",
    "taskQuality",
    "solutionQuality",
    "descriptionQuality",
  ];
  const rank = (item: Row) =>
    item.key.startsWith("stage:")
      ? -3
      : item.key === "scope"
        ? -2
        : item.key === "image"
          ? -1
          : uiOrder.indexOf(item.key.replace("check:", "")) >= 0
            ? uiOrder.indexOf(item.key.replace("check:", ""))
            : uiOrder.length;
  checks.sort((a, b) => rank(a) - rank(b));
  const slots = source("review")?.slots;
  if (slots && Object.values(slots).some(Boolean)) {
    const prior = checks.findIndex((item) => item.key === "check:autoReview");
    if (prior >= 0) checks.splice(prior, 1);
    for (const key of [
      "description",
      "tests",
      "solution",
      "agents",
      "synthesis",
    ]) {
      const slot = slots[key],
        output = slot?.output;
      const synthesis = slots.synthesis;
      const useSynthesis =
        synthesis?.status === "completed" &&
        synthesis?.stale === false &&
        (!slot || (slot.status === "completed" && slot.stale === false)) &&
        synthesis.output?.[key] != null;
      const resultSlot = useSynthesis ? synthesis : slot;
      const criterion = useSynthesis ? synthesis.output[key] : output;
      checks.push(
        row(
          `review:${key}`,
          key === "synthesis" ? "Overall" : key[0].toUpperCase() + key.slice(1),
          {
            ...resultSlot,
            output: {
              verdict:
                key === "synthesis"
                  ? output?.outcome
                  : typeof criterion?.band === "number"
                    ? `BAND ${criterion.band}`
                    : undefined,
              summary: criterion?.summary ?? criterion?.reasoning,
            },
          },
        ),
      );
    }
    const scope = slots.synthesis?.output?.effectiveScope;
    if (scope)
      checks.push(
        row("review:scope", "Effective scope", {
          ...slots.synthesis,
          output: { verdict: scope.verdict, summary: scope.reasoning },
        }),
      );
  }
  const fp = source("fp");
  checks.push(
    row(
      "fp",
      "FP Check",
      fp
        ? {
            ...fp,
            status: fp.inFlight
              ? "running"
              : (fp.state ??
                fp.status ??
                fp.job?.status ??
                fp.jobStatus ??
                (fp.verdict ||
                fp.output?.verdict ||
                typeof fp.passed === "boolean" ||
                fp.completedAt
                  ? "completed"
                  : undefined)),
            stale: fp.passesChangedSinceCheck === true ? true : fp.stale,
            verdict:
              fp.verdict ??
              fp.output?.verdict ??
              fp.job?.output?.verdict ??
              (typeof fp.passed === "boolean"
                ? fp.passed
                  ? "PASS"
                  : "FAIL"
                : undefined),
            output: {
              summary:
                fp.summary ?? fp.output?.summary ?? fp.job?.output?.summary,
              message:
                fp.message ?? fp.output?.message ?? fp.job?.output?.message,
            },
            error: fp.error ?? fp.job?.error,
          }
        : fp,
    ),
  );
  const runs = (source("runs") ?? []).map((run: any, i: number) => ({
    ...row(`run:${run.id ?? run._id ?? i}`, run.label ?? run.id ?? "Run", run),
    batch: clean(run.batchName ?? run.batchTag ?? "Ungrouped"),
  }));
  runs.sort(
    (a: Row, b: Row) =>
      (a.freshness === "current" ? 0 : 1) -
        (b.freshness === "current" ? 0 : 1) ||
      (a.batch ?? "").localeCompare(b.batch ?? "") ||
      a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
  const readiness = (source("readiness")?.criteria ?? []).map(
    (criterion: any) =>
      row(`ready:${criterion.id}`, criterion.label, criterion),
  );
  return { checks, runs, readiness };
}

export function observedChanges(
  before: Snapshot | undefined,
  after: Snapshot,
): string[] {
  if (!before)
    return ["First snapshot received; activity covers this session only"];
  if (before.versionId !== after.versionId)
    return [
      `Version changed: v${before.version ?? "none"} -> v${after.version ?? "none"}`,
    ];
  const old = dashboardRows(before),
    next = dashboardRows(after);
  const changes: string[] = [];
  if (before.status !== after.status)
    changes.push(`Challenge: ${before.status} -> ${after.status}`);
  const prior = new Map(
    [...old.checks, ...old.runs].map((item) => [item.key, item]),
  );
  for (const item of [...next.checks, ...next.runs]) {
    const prev = prior.get(item.key);
    if (
      !prev ||
      [prev.status, prev.verdict, prev.freshness].join() !==
        [item.status, item.verdict, item.freshness].join()
    )
      changes.push(
        `${item.label}: ${item.status} ${item.verdict} (${item.freshness})`,
      );
  }
  return changes;
}
