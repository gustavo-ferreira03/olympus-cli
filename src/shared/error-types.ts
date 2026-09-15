/**
 * Error classes shared across layers.
 *
 * This module is a leaf: it imports nothing from the rest of the CLI. The
 * classes live here rather than beside the code that throws them so that
 * low-level modules can raise a typed error and `errors.ts` can classify one,
 * without the two importing each other.
 */

/** A policy rule refused the operation. */
export class PolicyError extends Error {
  constructor(
    public rule: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

/** The local token budget refused the dispatch. */
export class BudgetError extends Error {
  readonly rule = "tokens.challenge_budget";
  constructor(
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BudgetError";
  }
}
