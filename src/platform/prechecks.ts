import { anyApi } from "convex/server";

const api = anyApi;

const STATUS_ALIASES: Record<string, string> = {
  pass: "pass",
  passed: "pass",
  warn: "warning",
  warning: "warning",
  fail: "fail",
  failed: "fail",
  error: "error",
  missing_fields: "missing_fields",
  skipped: "skipped",
  pending: "pending",
  running: "running",
};

const normalizeStatus = (value: unknown): string => {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  return STATUS_ALIASES[status] ?? (status || "unknown");
};

function normalizeCheck(check: any) {
  return { ...check, status: normalizeStatus(check?.status) };
}

export function validationResultsToStages(raw: unknown): any[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, any>).map(([stageId, result]) => {
    const stage: Record<string, unknown> = {
      _id: `validation:${stageId}`,
      _creationTime: 0,
      stageId,
      status: normalizeStatus(result?.status),
      stale: Boolean(result?.stale),
      checks: Array.isArray(result?.checks) ? result.checks.map(normalizeCheck) : [],
      source: "getValidationResults",
    };
    if (Array.isArray(result?.missingFields)) stage.missingFields = result.missingFields;
    return stage;
  });
}

export async function queryPrecheckStages(
  client: { query: (reference: any, args: any) => Promise<any> },
  { problemId, versionId }: { problemId: string; versionId: string },
): Promise<any[]> {
  // getByVersion now answers [] even after a run; the web app reads getValidationResults.
  let stages: any;
  let legacyError: unknown;
  let legacyFailed = false;
  try {
    stages = await client.query(api.stages.getByVersion, { versionId });
  } catch (error) {
    legacyFailed = true;
    legacyError = error;
  }
  if (Array.isArray(stages) && stages.length > 0) return stages;
  try {
    const validated = validationResultsToStages(
      await client.query(api.stages.getValidationResults, { itemId: problemId, versionId }),
    );
    if (validated.length > 0 || legacyFailed) return validated;
  } catch {
    if (legacyFailed) throw legacyError;
  }
  return stages ?? [];
}
