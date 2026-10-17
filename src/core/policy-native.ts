import { inspectNativeDependencies, nativeDependencyCatalog } from "./native-dependencies.ts";
import { type NativeDependencyReport } from "./native-dependencies.ts";
import { type PolicyAction, type PolicyDecision } from "./policy-graph.ts";
import {
  type PolicyGuidance,
  type PolicyGuidanceOption,
  type PolicyGuidanceStep,
} from "./policy.ts";

/** Resolve only native repair edges. This never dispatches or changes policy. */
export async function resolveNativeGuidance(input: {
  guidance: PolicyGuidance;
  inspect: (action: PolicyAction) => Promise<NativeDependencyReport | null>;
  decide: (action: PolicyAction, prerequisite: boolean) => PolicyDecision;
  command: (action: PolicyAction) => { command: string[] | null; error?: string };
  independent: (left: PolicyAction, right: PolicyAction) => boolean;
}): Promise<PolicyGuidance> {
  const { guidance } = input;
  if (["waiting", "terminal", "stuck", "complete", "unguided"].includes(guidance.status))
    return guidance;
  const roots = [
    ...new Set([...guidance.expectedActions, ...guidance.options.map((o) => o.action)]),
  ];
  const options = new Map<PolicyAction, PolicyGuidanceOption>();
  const steps = new Map<PolicyAction, PolicyGuidanceStep>();
  const reports = new Map<PolicyAction, Promise<NativeDependencyReport | null>>();
  const edges: Array<{ action: PolicyAction; requirement: string; dependency: PolicyAction }> = [];
  const supported = new Set(nativeDependencyCatalog().actions.map((item) => item.action));
  const completed = new Set<PolicyAction>();

  const visit = async (action: PolicyAction, path: PolicyAction[]): Promise<void> => {
    if (completed.has(action)) return;
    const prerequisite = path.length > 0;
    const decision = input.decide(action, prerequisite);
    const generated = input.command(action);
    const step: PolicyGuidanceStep = {
      order: steps.size + 1,
      action,
      role: prerequisite ? "prerequisite" : "expected",
      status: decision.status,
      command: generated.command,
      unmetRequirements: [...decision.unmetRequirements],
      notes: decision.notes,
      ...(generated.error ? { recommendationError: generated.error } : {}),
    };
    steps.set(action, step);
    if (path.includes(action)) {
      step.status = "blocked";
      step.recommendationError = `Native dependency cycle: ${[...path, action].join(" -> ")}`;
      return;
    }
    if (!reports.has(action)) reports.set(action, input.inspect(action));
    const report = await reports.get(action)!;
    const unmet = report?.requirements.filter((r) => r.status !== "satisfied") ?? [];
    if (report && report.status !== "ready") {
      step.status = "blocked";
      step.unmetRequirements.push(
        ...unmet.map((r) => ({
          profile: "native",
          check: null,
          path: r.id,
          expected: "satisfied",
          actual: r.observed,
          reason: (r.status === "unknown" ? "missing_field" : "predicate_failed") as
            | "missing_field"
            | "predicate_failed",
        })),
      );
      step.recommendationError = unmet.map((r) => `${r.id}: ${r.reason}`).join("; ");
      // Unknown evidence is not a repair instruction. Non-executable repairs require user input.
      if (
        unmet.length > 0
        && unmet.every((r) => r.status === "blocked" && r.action && supported.has(r.action))
      ) {
        for (const requirement of unmet) {
          const dependency = requirement.action as PolicyAction;
          edges.push({ action, requirement: requirement.id, dependency });
          await visit(dependency, [...path, action]);
        }
      }
    } else if (decision.status === "allowed" || decision.status === "confirmation_required") {
      options.set(action, {
        action,
        status:
          decision.status === "confirmation_required"
            ? "confirmation_required"
            : generated.command
              ? "ready"
              : "needs_arguments",
        command: generated.command,
        notes: decision.notes,
        ...(generated.error ? { recommendationError: generated.error } : {}),
      });
    }
    completed.add(action);
  };
  for (const root of roots) await visit(root, []);
  // Preserve independent siblings; shared repairs are deduplicated. Never assume new repairs commute.
  const frontier: PolicyGuidanceOption[] = [];
  for (const option of options.values())
    if (frontier.every((other) => input.independent(other.action, option.action)))
      frontier.push(option);
  const nextCommands = frontier.flatMap((o) =>
    o.status === "ready" && o.command ? [o.command] : [],
  );
  const proposedCommands = frontier.flatMap((o) =>
    o.status === "confirmation_required" && o.command ? [o.command] : [],
  );
  const status =
    nextCommands.length > 0
      ? "ready"
      : proposedCommands.length > 0
        ? "confirmation_required"
        : frontier.some((o) => o.status === "needs_arguments")
          ? "needs_arguments"
          : "blocked";
  const selected = frontier.find((o) => o.status === status);
  return {
    ...guidance,
    status,
    nextAction: selected?.action ?? null,
    nextActions: frontier.map((o) => o.action),
    nextCommand: nextCommands[0] ?? null,
    nextCommands,
    proposedCommand: proposedCommands[0] ?? null,
    proposedCommands,
    options: frontier,
    steps: [...steps.values()],
    nativeDependencies: edges,
    explanation:
      status === "ready"
        ? "Execute the ready native prerequisite/frontier, then refresh the original policy objective."
        : "Resolve native or policy blockers before continuing.",
    parallelExecution: frontier.flatMap((left, index) =>
      frontier.slice(index + 1).map((right) => ({
        actions: [left.action, right.action] as [PolicyAction, PolicyAction],
        reason: "Independent policy actions after native prerequisite resolution.",
      })),
    ),
    stepId: null,
    runCommand: null,
  };
}

export function nativeGuidanceInspector(
  client: Parameters<typeof inspectNativeDependencies>[0],
  challengeId: string,
  versionId: string | null,
  argumentsFor: (action: PolicyAction) => Record<string, unknown>,
) {
  const supported = new Set(nativeDependencyCatalog().actions.map((item) => item.action));
  return async (action: PolicyAction): Promise<NativeDependencyReport | null> => {
    if (!supported.has(action)) return null;
    const snapshot = await inspectNativeDependencies(client, challengeId, [action], {
      ...argumentsFor(action),
      versionId,
    });
    if (snapshot.versionId !== versionId)
      return {
        action,
        status: "unknown",
        requirements: [
          {
            id: "snapshot.version",
            status: "unknown",
            observed: snapshot.versionId,
            reason: "Policy and native dependency versions differ; refresh.",
          },
        ],
      };
    return snapshot.reports[0];
  };
}
