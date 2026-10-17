import { anyApi as api } from "convex/server";
import { GATING_CHECK_KEYS, toPublicCheckKey } from "./expected.ts";
import { type Requirement, type NativeDependencyReport } from "./native-dependencies.ts";

export const PATCHES: Record<string, string[]> = {
  verifyTests: ["testPatch"],
  verifySolution: ["testPatch", "solutionPatch"],
  verifyFlakiness: ["testPatch", "solutionPatch"],
  testQuality: ["testPatch"],
  taskQuality: [],
  solutionQuality: ["solutionPatch"],
  descriptionQuality: [],
  verifierIncompleteness: ["testPatch", "solutionPatch"],
};
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;

export type NativeRuleContext = {
  action: string;
  args: Record<string, any>;
  version: Record<string, any>;
  problem: Record<string, any>;
  errors: Map<string, string>;
  requirements: Requirement[];
  read: (key: string, ref: any, args: Record<string, any>) => Promise<any>;
  query: (key: string, ref: any) => Promise<any>;
  checks: () => Promise<any>;
  scope: () => Promise<any>;
  image: () => Promise<any>;
  admin: () => Promise<any>;
  readiness: () => Promise<any>;
  readyImage: () => Promise<void>;
  criterion: (id: string, allowWarning: boolean, next: string, command: string) => Promise<void>;
  command: (parts: string) => string;
  add: (
    id: string,
    value: boolean | undefined,
    reason: string,
    observed: unknown,
    ...repair: [action?: string, command?: string]
  ) => void;
  checkBoolean: (
    id: string,
    value: unknown,
    reason: string,
    action?: string,
    command?: string,
  ) => void;
  evaluate: (action: string) => Promise<NativeDependencyReport>;
};

const handlers: Record<string, (context: NativeRuleContext) => Promise<void>> = {
  "image.build": async (context) => {
    const { image, add, checkBoolean } = context;
    const state = await image();
    checkBoolean(
      "image.canBuild",
      state?.canBuild,
      "Backend must allow this image build.",
      "artifacts.update",
    );
    add(
      "image.inputs",
      state ? !(state.lastBuildFailedForCurrentInputs && !state.rebuildSafeNeeded) : undefined,
      "Change failed build inputs before retrying unless the backend requests a safe rebuild.",
      state
        ? {
            lastBuildFailedForCurrentInputs: state.lastBuildFailedForCurrentInputs,
            rebuildSafeNeeded: state.rebuildSafeNeeded,
          }
        : null,
      "artifacts.update",
    );
  },
  "prechecks.run": async (context) => {
    const { version, problem, add } = context;
    const fields = [
      "title",
      "description",
      "category",
      "language",
      "githubRepoUrl",
      "githubCommitHash",
      "dockerfile",
      "testPatch",
      "solutionPatch",
    ];
    const missing = fields.filter((field) => !text(version?.[field] ?? problem?.[field]));
    add(
      "artifacts.required",
      missing.length === 0,
      "Complete the required submission fields before prechecks.",
      { missing },
      "artifacts.update",
    );
  },
  "scope_gate.run": async (context) => {
    const { read, scope, criterion, command, add, checkBoolean } = context;
    await criterion("prechecks", false, "prechecks.run", "checks run-prechecks <id> --json");
    const [state, connection] = await Promise.all([
      scope(),
      read("github", api.githubCredentials.getMyGithubConnection, {}),
    ]);
    add(
      "github.connected",
      typeof connection?.connected === "boolean" && typeof connection?.valid === "boolean"
        ? connection.connected && connection.valid
        : undefined,
      "Connect/reconnect GitHub in Olympus before running Scope Gate.",
      connection ? { connected: connection.connected, valid: connection.valid } : null,
    );
    checkBoolean(
      "scope.idle",
      typeof state?.inFlight === "boolean" ? !state.inFlight : undefined,
      "Scope Gate must not already be running.",
      undefined,
      command("scope-gate wait <id> --json"),
    );
    add(
      "scope.rerunnable",
      state && typeof state.fresh === "boolean" && typeof state.isAdmin === "boolean"
        ? state.isAdmin || !state.fresh || state.latestVerdict == null
        : undefined,
      "A fresh exact-content verdict cannot rerun for non-admins; edit the submission first.",
      state ? { fresh: state.fresh, verdict: state.latestVerdict, isAdmin: state.isAdmin } : null,
      "artifacts.update",
    );
  },
  "checks.run_all": async (context) => {
    const { args, requirements, add, evaluate } = context;
    const selected = args.checkKeys ?? args.checks;
    const valid =
      Array.isArray(selected)
      && selected.length > 0
      && selected.every(
        (key) =>
          typeof key === "string"
          && (GATING_CHECK_KEYS as readonly string[]).includes(toPublicCheckKey(key)),
      );
    add(
      "selection.explicit",
      valid,
      "Provide an explicit nonempty selection of ordinary quality checks; special checks use dedicated actions.",
      selected,
    );
    if (valid)
      for (const key of new Set<string>(selected.map(toPublicCheckKey))) {
        requirements.push(...(await evaluate(`checks.${key}`)).requirements);
      }
  },
  "checks.autoReview": async (context) => {
    const { query, command, add, checkBoolean } = context;
    const state = await query("autoReview", api.runDynamicChecks.getAutoReviewTriggerState);
    checkBoolean(
      "autoReview.canRun",
      state?.canRun,
      Array.isArray(state?.blockers)
        ? state.blockers.map((b: any) => b.reason).join("; ") || "Backend must allow Auto Review."
        : "Backend must allow Auto Review.",
      undefined,
      command("auto-review view <id> --json"),
    );
    if (state?.canRun !== true && Array.isArray(state?.blockers))
      for (const blocker of state.blockers) {
        add(
          `autoReview.${blocker.id}`,
          false,
          blocker.reason ?? "Backend Auto Review blocker.",
          blocker,
        );
      }
  },
  "checks.rolloutCoach": async ({ query, command, checkBoolean }) => {
    const state = await query("rolloutCoach", api.rolloutCoach.getRolloutCoachState);
    checkBoolean(
      "rolloutCoach.canRun",
      state?.canRun,
      "Backend must allow a Rollout Coach run for this version.",
      undefined,
      command("checks view <id> --json"),
    );
  },
  "checks.*": async (context) => {
    const { action, version, checks, scope, admin, readyImage, command, add, checkBoolean } =
      context;
    const key = action.slice(7);
    await readyImage();
    const state = await scope();
    checkBoolean(
      "scope.dynamicAllowed",
      state?.canRunDynamicChecks,
      "Backend Scope Gate eligibility controls quality checks (including native role/stale-pass exceptions).",
      "scope_gate.run",
      command("scope-gate view <id> --json"),
    );
    for (const field of PATCHES[key] ?? [])
      add(
        `artifact.${field}`,
        text(version[field]),
        `This check requires ${field}.`,
        { present: text(version[field]) },
        "artifacts.update",
      );
    if (key === "verifierIncompleteness") {
      const [all, isAdmin] = await Promise.all([checks(), admin()]);
      const solution = all?.verifySolution;
      let enabled: boolean | undefined;
      let solutionPassed: boolean | undefined;
      if (isAdmin === false && all) {
        enabled = all._verifierIncompletenessRunsEnabled === true;
        solutionPassed =
          solution?.status === "completed"
          && solution?.stale !== true
          && String(solution?.output?.verdict ?? "").toUpperCase() === "PASS";
      }
      if (isAdmin === true) {
        enabled = true;
        solutionPassed = true;
      }
      if (all?._verifierIncompletenessRunsEnabled === true) enabled = true;
      add(
        "verifier.enabled",
        enabled,
        "Verifier audit must be enabled for this contributor (admins are exempt).",
        { enabled: all?._verifierIncompletenessRunsEnabled ?? null, isAdmin: isAdmin ?? null },
      );
      add(
        "verifySolution.pass",
        solutionPassed,
        "Non-admin verifier audit requires fresh passing Verify Solution.",
        solution
          ? { status: solution.status, stale: solution.stale, verdict: solution.output?.verdict }
          : null,
        "checks.verifySolution",
        command("checks run <id> --check=verifySolution --json"),
      );
    }
  },
  "rollouts.run": async (context) => {
    const { version, admin, readyImage, criterion, add } = context;
    await readyImage();
    add("version.unlocked", version.isLocked !== true, "Cannot run rollouts on a locked version.", {
      isLocked: version.isLocked ?? false,
    });
    const isAdmin = await admin();
    if (isAdmin === true)
      add(
        "readiness.adminExemption",
        true,
        "Native admin exception for rollout readiness criteria.",
        true,
      );
    else if (isAdmin === false) {
      await criterion("prechecks", false, "prechecks.run", "checks run-prechecks <id> --json");
      await criterion("scopeGate", false, "scope_gate.run", "scope-gate run <id> --json");
      await criterion("dynamicChecks", true, "checks.run_all", "checks view <id> --json");
    } else
      add(
        "role.known",
        undefined,
        "Could not determine the native rollout readiness exception.",
        null,
      );
  },
  "re_evaluation.run": async (context) => {
    const { query, command, add } = context;
    const state = await query("reevaluation", api.reEvalRuns.getReEvalOffer);
    add(
      "reevaluation.eligible",
      typeof state?.eligible === "boolean" ? state.eligible : undefined,
      state?.reason ?? "Backend must offer eligible existing solutions for re-evaluation.",
      state ? { eligible: state.eligible, reason: state.reason } : null,
      undefined,
      command("runs re-evaluate view <id> --json"),
    );
  },
  "fp_check.run": async (context) => {
    const { query, command, checkBoolean } = context;
    const state = await query("fp", api.fpReview.getFpCheckForVersion);
    checkBoolean(
      "fp.canRun",
      state?.canRun,
      "Backend must allow FP Check.",
      undefined,
      command("fp-check view <id> --json"),
    );
    checkBoolean(
      "fp.eligiblePasses",
      state?.hasEligiblePasses,
      "FP Check needs eligible passing runs, not necessarily the full minimum cohort.",
      "rollouts.run",
    );
  },
  "auto_review.orchestrate": async (context) => {
    const { admin, checkBoolean } = context;
    checkBoolean("role.admin", await admin(), "Multi-slot orchestration is restricted to admins.");
  },
  "submission.submit": async (context) => {
    const { readiness, command, add } = context;
    const state = await readiness();
    add(
      "submission.canSubmit",
      typeof state?.canSubmit === "boolean" ? state.canSubmit : undefined,
      "Backend submission readiness must allow submission for the current lane and version.",
      state
        ? { canSubmit: state.canSubmit, criteria: state.criteria, isBypassed: state.isBypassed }
        : null,
      undefined,
      command("checks view <id> --json"),
    );
  },
  "verifier_audit.decide": async (context) => {
    const { args, checks, add, checkBoolean } = context;
    const all = await checks();
    const check = all?.verifierIncompleteness;
    const jobId = args.jobId ?? args.job ?? check?.jobId;
    const decision = args.decision;
    add(
      "decision.valid",
      ["accepted", "accepted_with_edits", "rejected"].includes(decision),
      "Choose accepted, accepted_with_edits or rejected.",
      decision,
    );
    add("verifier.job", text(jobId), "An audit job is required.", jobId);
    if (decision !== "rejected") {
      add(
        "verifier.current",
        all ? !!check && check.jobId === jobId : undefined,
        "Acceptance must target the current audit job.",
        check?.jobId,
      );
      add(
        "verifier.fresh",
        check ? check.stale !== true : undefined,
        "Cannot accept a stale audit.",
        check?.stale,
      );
      checkBoolean(
        "verifier.patchApplies",
        check?.output?.patchValidation?.appliesCleanly,
        "The proposed patch must apply cleanly.",
      );
      if (decision === "accepted_with_edits")
        add(
          "verifier.editedPatch",
          text(args.finalPatch),
          "Edited acceptance requires the final patch contents.",
          { present: text(args.finalPatch) },
        );
    }
  },
};
export async function evaluateNativeRules(context: NativeRuleContext): Promise<void> {
  const handler =
    handlers[context.action]
    ?? (context.action.startsWith("checks.") ? handlers["checks.*"] : undefined);
  if (!handler) throw new Error(`No native dependency evaluator for ${context.action}`);
  await handler(context);
}
