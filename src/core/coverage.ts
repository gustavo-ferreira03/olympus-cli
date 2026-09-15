export type CoverageCounts =
  | {
      total: number;
      fullyCovered: number;
      partial: number;
      uncovered: number;
      fullyCoveredRatio: number;
    }
  | {
      total: null;
      fullyCovered: null;
      partial: null;
      uncovered: null;
      fullyCoveredRatio: null;
    };
export type CoverageSummary = CoverageCounts & { untestedGapCount: number | null };
export type CoverageDiagnostic = {
  code:
    | "coverage.requirements_missing"
    | "coverage.requirements_empty"
    | "coverage.requirements_malformed"
    | "coverage.suggestions_missing"
    | "coverage.suggestions_malformed";
  path: string;
  message: string;
};
export type CoverageOutput = {
  coverageSummary: CoverageSummary;
  coverageDiagnostics: CoverageDiagnostic[];
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function requirementCounts(output: unknown): {
  counts: CoverageCounts;
  diagnostics: CoverageDiagnostic[];
} {
  const unknown = (code: CoverageDiagnostic["code"], path: string, message: string) => ({
    counts: {
      total: null,
      fullyCovered: null,
      partial: null,
      uncovered: null,
      fullyCoveredRatio: null,
    },
    diagnostics: [{ code, path, message }],
  });
  if (!object(output) || !Object.hasOwn(output, "requirements"))
    return unknown(
      "coverage.requirements_missing",
      "output.requirements",
      "Test Quality requirements are absent; fully covered ratio is unknown.",
    );
  const requirements = output.requirements;
  if (!Array.isArray(requirements))
    return unknown(
      "coverage.requirements_malformed",
      "output.requirements",
      "Test Quality requirements must be a non-empty array; fully covered ratio is unknown.",
    );
  if (requirements.length === 0)
    return unknown(
      "coverage.requirements_empty",
      "output.requirements",
      "Test Quality requirements are empty; no coverage ratio can be calculated.",
    );
  let fullyCovered = 0,
    partial = 0,
    uncovered = 0;
  for (let index = 0; index < requirements.length; index++) {
    const requirement = requirements[index];
    if (
      !object(requirement)
      || !Object.hasOwn(requirement, "covered")
      || !["yes", "partial", "no"].includes(requirement.covered as string)
    )
      return unknown(
        "coverage.requirements_malformed",
        `output.requirements.${index}.covered`,
        'Each requirement must have covered exactly "yes", "partial", or "no"; fully covered ratio is unknown.',
      );
    if (requirement.covered === "yes") fullyCovered++;
    else if (requirement.covered === "partial") partial++;
    else uncovered++;
  }
  return {
    counts: {
      total: requirements.length,
      fullyCovered,
      partial,
      uncovered,
      fullyCoveredRatio: fullyCovered / requirements.length,
    },
    diagnostics: [],
  };
}

export function summarizeCoverage(output: unknown): CoverageOutput {
  const { counts, diagnostics } = requirementCounts(output);
  let untestedGapCount: number | null = null;
  if (!object(output) || !Object.hasOwn(output, "coverageSuggestions")) {
    diagnostics.push({
      code: "coverage.suggestions_missing",
      path: "output.coverageSuggestions",
      message: "Test Quality coverageSuggestions are absent; untested gap count is unknown.",
    });
  } else if (Array.isArray(output.coverageSuggestions)) {
    untestedGapCount = 0;
    for (let index = 0; index < output.coverageSuggestions.length; index++) {
      const suggestion = output.coverageSuggestions[index];
      if (
        !object(suggestion)
        || !Object.hasOwn(suggestion, "gapKind")
        || typeof suggestion.gapKind !== "string"
        || !suggestion.gapKind.trim()
      ) {
        untestedGapCount = null;
        diagnostics.push({
          code: "coverage.suggestions_malformed",
          path: `output.coverageSuggestions.${index}.gapKind`,
          message:
            "Each coverage suggestion must contain a non-empty string gapKind; untested gap count is unknown.",
        });
        break;
      }
      if (suggestion.gapKind.toLowerCase() === "untested") untestedGapCount++;
    }
  } else {
    diagnostics.push({
      code: "coverage.suggestions_malformed",
      path: "output.coverageSuggestions",
      message: "Test Quality coverageSuggestions must be an array; untested gap count is unknown.",
    });
  }
  return { coverageSummary: { ...counts, untestedGapCount }, coverageDiagnostics: diagnostics };
}

export function normalizeCoverageOutput(output: unknown): Record<string, unknown> & CoverageOutput {
  return { ...(object(output) ? output : {}), ...summarizeCoverage(output) };
}

const fields = ["total", "fullyCovered", "partial", "uncovered", "fullyCoveredRatio"];
export const COVERAGE_RESULT_SCHEMA = {
  type: "object",
  required: ["output"],
  properties: {
    output: {
      type: "object",
      required: ["coverageSummary", "coverageDiagnostics"],
      properties: {
        coverageSummary: {
          type: "object",
          additionalProperties: false,
          required: [...fields, "untestedGapCount"],
          description:
            'Only exact covered="yes" contributes to the unrounded ratio. Only case-insensitive gapKind="untested" contributes to untestedGapCount. Unknown metrics are null.',
          properties: {
            ...Object.fromEntries(
              fields.map((key) => [
                key,
                key === "fullyCoveredRatio"
                  ? { type: ["number", "null"], minimum: 0, maximum: 1 }
                  : { type: ["integer", "null"], minimum: key === "total" ? 1 : 0 },
              ]),
            ),
            untestedGapCount: { type: ["integer", "null"], minimum: 0 },
          },
          oneOf: [
            {
              properties: Object.fromEntries(
                fields.map((key) => [
                  key,
                  { type: key === "fullyCoveredRatio" ? "number" : "integer" },
                ]),
              ),
            },
            { properties: Object.fromEntries(fields.map((key) => [key, { type: "null" }])) },
          ],
        },
        coverageDiagnostics: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["code", "path", "message"],
            properties: {
              code: {
                enum: [
                  "coverage.requirements_missing",
                  "coverage.requirements_empty",
                  "coverage.requirements_malformed",
                  "coverage.suggestions_missing",
                  "coverage.suggestions_malformed",
                ],
              },
              path: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
  },
};
