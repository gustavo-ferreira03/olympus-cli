import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { toPublicCheckKey } from "./expected.ts";
import { normalizeCoverageOutput } from "./coverage.ts";

export const CHECK_INPUT_ARTIFACTS = ["description", "tests", "solution", "dockerfile"] as const;
export type CheckInputArtifact = (typeof CHECK_INPUT_ARTIFACTS)[number];
export type CheckInputComparison = {
  evaluatedHash?: string;
  currentHash?: string;
  changedSinceCheck?: boolean;
};
export type CheckInputs = Partial<Record<CheckInputArtifact, CheckInputComparison>>;
export type BackendCheckInputs = Partial<Record<CheckInputArtifact, { evaluatedHash?: string }>>;
export type CurrentCheckInputs = Partial<Record<CheckInputArtifact, { currentHash?: string }>>;
export type CheckInputsDiagnostic = {
  artifact: CheckInputArtifact;
  code: "check_inputs.evaluated_hash_unavailable" | "check_inputs.current_hash_unavailable";
  message: string;
};
export type CheckInputsResult = {
  checkInputs: CheckInputs;
  checkInputsDiagnostics: CheckInputsDiagnostic[];
};

const causalInputs: Partial<Record<string, readonly CheckInputArtifact[]>> = {
  descriptionQuality: ["description"],
  testQuality: ["description", "tests"],
  solutionQuality: ["description", "tests", "solution"],
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const own = (value: unknown, key: string): unknown => {
  const object = record(value);
  return Object.hasOwn(object, key) ? object[key] : undefined;
};
const hash = (value: unknown): string | undefined =>
  typeof value === "string"
  && value.length > 0
  && value.length <= 1024
  // eslint-disable-next-line no-control-regex -- Hashes must reject control characters.
  && !/[\s\x00-\x1f\x7f]/.test(value)
  && !/^(unknown|null|undefined|none|n\/a)$/i.test(value)
    ? value
    : undefined;

export function remoteArtifactHashes(version: unknown): Record<string, string> {
  const fields = {
    description: "description",
    tests: "testPatch",
    solution: "solutionPatch",
    dockerfile: "dockerfile",
  };
  return Object.fromEntries(
    Object.entries(fields).flatMap(([artifact, field]) => {
      const value = own(version, field);
      return typeof value === "string"
        ? [[artifact, createHash("sha256").update(value).digest("hex")]]
        : [];
    }),
  );
}
const inputRecordKey = (scope: string, check: string) =>
  `${createHash("sha256")
    .update(JSON.stringify([scope, toPublicCheckKey(check)]))
    .digest("hex")}.json`;
export function saveObservedInputs({
  directory,
  scope,
  versionId,
  jobId,
  check,
  before,
  after,
  observedAt,
}: {
  directory: string;
  scope: string;
  versionId: string;
  jobId: string;
  check: string;
  before: Record<string, string>;
  after: Record<string, string>;
  observedAt: number;
}): void {
  const hashes = Object.fromEntries(
    Object.entries(before).filter(([artifact, hash]) => after[artifact] === hash),
  );
  if (Object.keys(hashes).length === 0) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, inputRecordKey(scope, check));
  const temporary = resolve(directory, `${randomUUID()}.tmp`);
  try {
    writeFileSync(
      temporary,
      JSON.stringify({
        v: 1,
        jobId,
        versionId,
        check: toPublicCheckKey(check),
        source: "cli_observed",
        observedAt,
        confirmedAt: Date.now(),
        hashes,
      }),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, path);
    const records = readdirSync(directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => ({ name, time: statSync(resolve(directory, name)).mtimeMs }))
      .toSorted((a, b) => b.time - a.time);
    for (const item of records.slice(128)) {
      try {
        unlinkSync(resolve(directory, item.name));
      } catch {}
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
export function recordedCheckInputs(
  raw: unknown,
  directory: string,
  scope: string,
  versionId: string,
): unknown {
  return Object.fromEntries(
    Object.entries(record(raw)).map(([check, value]) => {
      const jobId = own(value, "jobId");
      if (typeof jobId !== "string") return [check, value];
      try {
        const path = resolve(directory, inputRecordKey(scope, check));
        if (statSync(path).size > 4096) return [check, value];
        const saved = JSON.parse(readFileSync(path, "utf8"));
        if (
          saved.v !== 1
          || saved.jobId !== jobId
          || saved.versionId !== versionId
          || saved.check !== toPublicCheckKey(check)
          || saved.source !== "cli_observed"
        )
          return [check, value];
        const inputs = Object.fromEntries(
          CHECK_INPUT_ARTIFACTS.flatMap((artifact) =>
            typeof saved.hashes?.[artifact] === "string"
            && /^[a-f0-9]{64}$/.test(saved.hashes[artifact])
              ? [[artifact, { evaluatedHash: saved.hashes[artifact] }]]
              : [],
          ),
        );
        return [
          check,
          { ...record(value), checkInputs: inputs, checkInputsSource: "cli_observed" },
        ];
      } catch {
        return [check, value];
      }
    }),
  );
}

export function normalizeCheckInputs(
  checkKey: string,
  rawCheck: unknown,
  currentVersion: unknown,
): CheckInputsResult {
  const evaluated = own(rawCheck, "checkInputs");
  const current = Object.fromEntries(
    Object.entries(remoteArtifactHashes(currentVersion)).map(([artifact, currentHash]) => [
      artifact,
      { currentHash },
    ]),
  );
  const expected = causalInputs[toPublicCheckKey(checkKey)] ?? CHECK_INPUT_ARTIFACTS;
  const artifacts = CHECK_INPUT_ARTIFACTS.filter(
    (artifact) => expected.includes(artifact) || own(evaluated, artifact) !== undefined,
  );
  const checkInputs: CheckInputs = {};
  const checkInputsDiagnostics: CheckInputsDiagnostic[] = [];
  for (const artifact of artifacts) {
    const evaluatedHash = hash(own(own(evaluated, artifact), "evaluatedHash"));
    const currentHash = hash(own(own(current, artifact), "currentHash"));
    const comparison: CheckInputComparison = {};
    if (evaluatedHash === undefined) {
      checkInputsDiagnostics.push({
        artifact,
        code: "check_inputs.evaluated_hash_unavailable",
        message: `No recorded input hash for ${artifact}; causal prerequisite is not enforced.`,
      });
    } else {
      comparison.evaluatedHash = evaluatedHash;
    }
    if (currentHash === undefined) {
      checkInputsDiagnostics.push({
        artifact,
        code: "check_inputs.current_hash_unavailable",
        message: `Current remote ${artifact} content is unavailable; comparison is unknown.`,
      });
    } else {
      comparison.currentHash = currentHash;
    }
    if (evaluatedHash !== undefined && currentHash !== undefined)
      comparison.changedSinceCheck = evaluatedHash !== currentHash;
    if (Object.keys(comparison).length > 0) checkInputs[artifact] = comparison;
  }
  return { checkInputs, checkInputsDiagnostics };
}

export function enrichCheckResults(
  rawChecks: unknown,
  currentVersion: unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record(rawChecks)).map(([key, value]) => {
      if (
        key.startsWith("_")
        || value === null
        || typeof value !== "object"
        || Array.isArray(value)
      )
        return [key, value];
      return [
        key,
        {
          ...record(value),
          ...normalizeCheckInputs(key, value, currentVersion),
          ...(toPublicCheckKey(key) === "testQuality"
            ? { output: normalizeCoverageOutput(own(value, "output")) }
            : {}),
        },
      ];
    }),
  );
}

export const CHECK_INPUTS_RESULT_SCHEMA = {
  type: "object",
  properties: {
    checkInputs: {
      type: "object",
      additionalProperties: false,
      description:
        "Hashes observed by the CLI around a confirmed job dispatch compared with current remote content. Missing changedSinceCheck means unknown; causal unchanged prerequisites permit unknown. Platform stale is independent.",
      properties: Object.fromEntries(
        CHECK_INPUT_ARTIFACTS.map((artifact) => [
          artifact,
          {
            type: "object",
            additionalProperties: false,
            properties: {
              evaluatedHash: { type: "string", minLength: 1 },
              currentHash: { type: "string", minLength: 1 },
              changedSinceCheck: { type: "boolean" },
            },
            allOf: [
              {
                if: { required: ["changedSinceCheck"] },
                // eslint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a thenable.
                then: { required: ["evaluatedHash", "currentHash"] },
              },
            ],
          },
        ]),
      ),
    },
    checkInputsDiagnostics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["artifact", "code", "message"],
        properties: {
          artifact: { enum: [...CHECK_INPUT_ARTIFACTS] },
          code: {
            enum: [
              "check_inputs.evaluated_hash_unavailable",
              "check_inputs.current_hash_unavailable",
            ],
          },
          message: { type: "string" },
        },
      },
    },
  },
  required: ["checkInputs", "checkInputsDiagnostics"],
};
