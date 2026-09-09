import { BudgetError, PolicyError } from "./error-types.ts";

export type ErrorKind =
  | "usage"
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "network"
  | "config"
  | "policy"
  | "budget"
  | "unknown";

export type ErrorDescription = {
  kind: ErrorKind;
  code: string;
  retryable: boolean | null;
  hint: string;
};

export class CliError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly retryable: boolean | null;
  readonly hint: string;

  constructor(
    message: string,
    options: Pick<ErrorDescription, "kind" | "code">
      & Partial<Pick<ErrorDescription, "retryable" | "hint">>,
  ) {
    super(message);
    this.name = "CliError";
    this.kind = options.kind;
    this.code = options.code;
    this.retryable = options.retryable === undefined ? false : options.retryable;
    this.hint = options.hint ?? "Review the command and try again.";
  }
}

const usageCodes = new Set(["EARG", "E_UNKNOWN_COMMAND", "E_NO_COMMAND", "E_MISSING_ARGS"]);
const transientCodes = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function readProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function classify(error: object): ErrorDescription | undefined {
  if (error instanceof CliError) {
    return {
      kind: error.kind,
      code: error.code,
      retryable: error.retryable,
      hint: error.hint,
    };
  }
  if (error instanceof BudgetError) {
    return {
      kind: "budget",
      code: error.rule,
      retryable: false,
      hint: "Review the local challenge budget and accounting state before dispatching again.",
    };
  }
  if (error instanceof PolicyError) {
    if (error.rule === "policy.invalid" || error.rule === "policy.unreadable") {
      return {
        kind: "config",
        code: error.rule,
        retryable: false,
        hint: "Check the local policy file for validity and read access.",
      };
    }
    return {
      kind: "policy",
      code: error.rule,
      retryable: false,
      hint: "Review the reported policy rule and choose an operation permitted by the guardrails.",
    };
  }
  const code = readProperty(error, "code");
  if (typeof code === "string" && usageCodes.has(code)) {
    return {
      kind: "usage",
      code,
      retryable: false,
      hint: "Run the command with --help and check its arguments.",
    };
  }
  for (const key of ["status", "statusCode"]) {
    const status = readProperty(error, key);
    if (typeof status !== "number" || !Number.isInteger(status)) continue;
    if (status === 401)
      return {
        kind: "auth",
        code: "HTTP_401",
        retryable: false,
        hint: "Sign in again using the CLI authentication command.",
      };
    if (status === 403)
      return {
        kind: "permission",
        code: "HTTP_403",
        retryable: false,
        hint: "Check that your account has permission for this operation.",
      };
    if (status === 404)
      return {
        kind: "not_found",
        code: "HTTP_404",
        retryable: false,
        hint: "Check the requested resource identifier and its availability.",
      };
    if (status === 429)
      return {
        kind: "rate_limit",
        code: "HTTP_429",
        retryable: true,
        hint: "Wait and reduce request frequency; check operation state before retrying to avoid duplicate work.",
      };
    if (status >= 500 && status <= 599)
      return {
        kind: "network",
        code: `HTTP_${status}`,
        retryable: true,
        hint: "The service reported a server error. Check operation state before retrying to avoid duplicate work.",
      };
  }
  if (typeof code === "string" && transientCodes.has(code)) {
    return {
      kind: "network",
      code,
      retryable: true,
      hint: "Check connectivity and operation state before retrying to avoid duplicate work.",
    };
  }
  if (code === "EACCES" || code === "EPERM") {
    return {
      kind: "permission",
      code,
      retryable: false,
      hint: "Check access permissions for the requested operation.",
    };
  }
  return undefined;
}

/**
 * Strip terminal escape sequences and invisible characters from text that is
 * about to be printed as a diagnostic.
 *
 * Matching control characters is the entire point here, so `no-control-regex`
 * is suppressed deliberately rather than worked around.
 */
/* eslint-disable no-control-regex -- stripping control characters is the purpose of this function */
export function sanitizeDiagnostic(text: string): string {
  return text
    .replaceAll(
      /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g,
      "",
    )
    .replaceAll(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll(/\u001b[ -/]*[@-~]/g, "")
    .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replaceAll(/[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, "");
}
/* eslint-enable no-control-regex */

export function describeError(error: unknown): ErrorDescription {
  const seen = new Set<object>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current) && seen.size < 32) {
    seen.add(current);
    try {
      const description = classify(current);
      if (description)
        return {
          ...description,
          code: sanitizeDiagnostic(description.code),
          hint: sanitizeDiagnostic(description.hint),
        };
    } catch {
      break;
    }
    current = readProperty(current, "cause");
  }
  return {
    kind: "unknown",
    code: "unknown",
    retryable: null,
    hint: "Inspect the error and command context before retrying.",
  };
}
