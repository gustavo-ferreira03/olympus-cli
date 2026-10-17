import { PATCHES, evaluateNativeRules } from "./native-dependency-rules.ts";
import { anyApi as api } from "convex/server";
import { GATING_CHECK_KEYS, toPublicCheckKey } from "./expected.ts";
import { CliError } from "../shared/errors.ts";

type Json = Record<string, any>;
type Reader = { query: (reference: any, args: any) => Promise<any> };
export type Requirement = {
  id: string;
  status: "satisfied" | "blocked" | "unknown";
  reason: string;
  observed: unknown;
  action?: string;
  command?: string;
};
export type NativeDependencyReport = {
  action: string;
  status: "ready" | "blocked" | "unknown";
  requirements: Requirement[];
};
const CATALOG: Record<string, string[]> = {
  "image.build": ["image.canBuild", "image.inputs"],
  "prechecks.run": ["artifacts.required"],
  "scope_gate.run": ["prechecks.pass", "github.connected", "scope.idle", "scope.rerunnable"],
  ...Object.fromEntries(
    GATING_CHECK_KEYS.map((key) => [
      `checks.${key}`,
      ["image.ready", "scope.dynamicAllowed", ...PATCHES[key].map((p) => `artifact.${p}`)],
    ]),
  ),
  "checks.run_all": ["selection.explicit", "selected_checks.requirements"],
  "checks.verifierIncompleteness": [
    "image.ready",
    "scope.dynamicAllowed",
    "artifact.testPatch",
    "artifact.solutionPatch",
    "verifier.enabled",
    "verifySolution.pass",
  ],
  "checks.autoReview": ["autoReview.canRun"],
  "checks.rolloutCoach": ["rolloutCoach.canRun"],
  "rollouts.run": [
    "image.ready",
    "version.unlocked",
    "prechecks.pass",
    "scopeGate.pass",
    "dynamicChecks.pass",
  ],
  "re_evaluation.run": ["reevaluation.eligible"],
  "fp_check.run": ["fp.canRun", "fp.eligiblePasses"],
  "verifier_audit.decide": [
    "decision.valid",
    "verifier.job",
    "verifier.current",
    "verifier.fresh",
    "verifier.patchApplies",
  ],
  "auto_review.orchestrate": ["role.admin"],
  "submission.submit": ["submission.canSubmit"],
};
export function nativeDependencyCatalog() {
  return {
    kind: "olympus.native-dependencies",
    schemaVersion: 1,
    semantics:
      "Operational prerequisites only. No automatic repairs; ready is not execution authorization. Policy, budget, permissions and backend validation still apply.",
    actions: Object.entries(CATALOG).map(([action, requirements]) => ({ action, requirements })),
  };
}
const ENDPOINTS: Record<string, string> = {
  "dockerImage:buildVersionImage": "image.build",
  "contributorTokens:runAllChecksWithToken": "prechecks.run",
  "scopeGate:triggerScopeGate": "scope_gate.run",
  "runDynamicChecks:triggerAllDynamicChecks": "checks.run_all",
  "runAgentRuns:triggerAgentRun": "rollouts.run",
  "runAgentRuns:triggerRuns": "rollouts.run",
  "reEvalRuns:triggerReEvalRuns": "re_evaluation.run",
  "fpReview:requestFpCheck": "fp_check.run",
  "verifierIncompleteness:submitVerifierIncompletenessDecision": "verifier_audit.decide",
  "orchestratorReview:triggerOrchestratorReview": "auto_review.orchestrate",
  "problems:submitDraft": "submission.submit",
};
export function nativeActionForEndpoint(name: string, args: Json): string | undefined {
  return name === "runDynamicChecks:triggerDynamicCheck"
    ? `checks.${toPublicCheckKey(String(args.checkKey ?? ""))}`
    : ENDPOINTS[name];
}

/** A read-only, per-inspection cache; never reused across dispatches. */
export async function inspectNativeDependencies(
  client: Reader,
  problemId: string,
  actions: string[],
  args: Json = {},
): Promise<{ problemId: string; versionId: string | null; reports: NativeDependencyReport[] }> {
  for (const action of actions) {
    if (!Object.hasOwn(CATALOG, action))
      throw new CliError(`Unknown native action: ${action}`, {
        kind: "usage",
        code: "dependencies.action",
        hint: "Use olympus dependencies catalog --json.",
      });
  }
  const cache = new Map<string, Promise<any>>();
  const errors = new Map<string, string>();
  const read = (key: string, reference: any, input: Json) => {
    if (!cache.has(key))
      cache.set(
        key,
        (async () => {
          try {
            return await client.query(reference, input);
          } catch {
            errors.set(key, `Unable to read ${key}; retry the read-only dependency inspection.`);
            return undefined;
          }
        })(),
      );
    return cache.get(key)!;
  };
  const problem = await read("problem", api.problems.getWithLatestVersion, { problemId });
  let version = problem?.latestVersion;
  if (args.versionId && version?._id !== args.versionId) {
    const versions = await read("versions", api.problems.listVersions, { problemId });
    const selected = Array.isArray(versions)
      ? versions.find((v) => v._id === args.versionId)
      : undefined;
    const snapshot = selected
      ? await read("selectedVersion", api.problems.getWithVersion, {
          problemId,
          versionNumber: selected.version,
        })
      : undefined;
    version = snapshot?.version;
  }
  const versionId = version?._id ?? null;
  const current = versionId !== null && versionId === problem?.latestVersion?._id;
  const v = { versionId };
  const query = (key: string, reference: any) =>
    versionId ? read(key, reference, v) : Promise.resolve(undefined);
  const readiness = () =>
    current
      ? read("readiness", api.submissionReadiness.getSubmissionReadiness, { problemId })
      : Promise.resolve(undefined);
  const checks = () => query("checks", api.runDynamicChecks.getDynamicChecks);
  const scope = () => query("scope", api.scopeGate.getScopeGate);
  const image = () => query("image", api.dockerImage.getImageStatus);
  const admin = () => read("admin", api.admins.isCurrentUser, {});
  const evaluate = async (action: string): Promise<NativeDependencyReport> => {
    const requirements: Requirement[] = [];
    const add = (
      id: string,
      value: boolean | undefined,
      reason: string,
      observed: unknown,
      ...repair: [next?: string, command?: string]
    ) => {
      const [next, command] = repair;
      let status: Requirement["status"] = "unknown";
      if (value === true) status = "satisfied";
      if (value === false) status = "blocked";
      requirements.push({
        id,
        status,
        reason,
        observed: observed ?? null,
        ...(next ? { action: next } : {}),
        ...(command ? { command } : {}),
      });
    };
    const checkBoolean = (
      id: string,
      value: unknown,
      reason: string,
      next?: string,
      command?: string,
    ) => add(id, typeof value === "boolean" ? value : undefined, reason, value, next, command);
    const command = (parts: string) => `olympus ${parts.replace("<id>", problemId)}`;
    const criterion = async (
      id: string,
      allowWarning: boolean,
      next: string,
      nextCommand: string,
    ) => {
      const state = await readiness();
      const item = Array.isArray(state?.criteria)
        ? state.criteria.find((c: any) => c.id === id)
        : undefined;
      add(
        `${id}.pass`,
        item && typeof item.status === "string"
          ? item.stale !== true
              && (item.status === "pass" || (allowWarning && item.status === "warn"))
          : undefined,
        item?.detail
          ?? `Current ${id} readiness is required${current ? "" : "; latest-version readiness cannot prove historical-version eligibility"}.`,
        item,
        next,
        command(nextCommand),
      );
    };
    const readyImage = async () => {
      const state = await image();
      add(
        "image.ready",
        typeof state?.hasImage === "boolean" && typeof state?.stale === "boolean"
          ? state.hasImage && !state.stale
          : undefined,
        "Quality checks and rollouts require a built, non-stale per-version image.",
        state ? { hasImage: state.hasImage, stale: state.stale } : null,
        "image.build",
        command("image build <id> --json"),
      );
    };
    if (versionId) {
      await evaluateNativeRules({
        action,
        args,
        version,
        problem,
        errors,
        requirements,
        read,
        query,
        checks,
        scope,
        image,
        admin,
        readiness,
        readyImage,
        criterion,
        command,
        add,
        checkBoolean,
        evaluate,
      });
    } else {
      add("version.exists", undefined, "Could not resolve the requested challenge version.", null);
    }
    const unique = [...new Map(requirements.map((item) => [item.id, item])).values()];
    let status: NativeDependencyReport["status"] = "ready";
    if (unique.some((r) => r.status === "unknown")) status = "unknown";
    if (unique.some((r) => r.status === "blocked")) status = "blocked";
    return {
      action,
      status,
      requirements: unique,
    };
  };
  const reports = await Promise.all(actions.map(evaluate));
  // Never combine eligibility with a version/artifact snapshot that changed during inspection.
  if (versionId) {
    const confirmation = await client.query(api.problems.getWithLatestVersion, { problemId });
    const fields = [
      "_id",
      "description",
      "githubRepoUrl",
      "githubCommitHash",
      "dockerfile",
      "testPatch",
      "solutionPatch",
      "isLocked",
    ];
    if (
      confirmation?.latestVersion?._id !== problem?.latestVersion?._id
      || confirmation?.lastDraftEditedAt !== problem?.lastDraftEditedAt
      || (current
        && fields.some((field) => confirmation?.latestVersion?.[field] !== version[field]))
    ) {
      for (const report of reports) {
        report.status = "unknown";
        report.requirements.push({
          id: "snapshot.stable",
          status: "unknown",
          reason:
            "Version/artifacts changed during dependency inspection; refresh before dispatch.",
          observed: null,
        });
      }
    }
  }
  return { problemId, versionId, reports };
}
export class NativeDependencyError extends CliError {
  readonly details: ReturnType<typeof dependencyDetails>;
  constructor(snapshot: Awaited<ReturnType<typeof inspectNativeDependencies>>) {
    const blocked = snapshot.reports.flatMap((report) =>
      report.requirements.filter((r) => r.status !== "satisfied"),
    );
    super(
      `Native prerequisites are unmet: ${blocked.map((r) => `${r.id}: ${r.reason}`).join("; ")}`,
      {
        kind: "usage",
        code: "dependencies.blocked",
        retryable: false,
        hint: `No action dispatched. Inspect olympus dependencies view ${snapshot.problemId} --json. Suggested actions are not automatic repairs or authorization.`,
      },
    );
    this.details = dependencyDetails(snapshot);
  }
}
function dependencyDetails(snapshot: Awaited<ReturnType<typeof inspectNativeDependencies>>) {
  return {
    status: "blocked",
    dependencyStatus: snapshot.reports.some((r) => r.status === "unknown") ? "unknown" : "blocked",
    ...snapshot,
  };
}
export async function assertNativeDependencies(
  client: Reader,
  problemId: string,
  action: string,
  args: Json = {},
) {
  const snapshot = await inspectNativeDependencies(client, problemId, [action], args);
  if (snapshot.reports.some((report) => report.status !== "ready"))
    throw new NativeDependencyError(snapshot);
}
