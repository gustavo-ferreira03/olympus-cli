/**
 * Shared plumbing for the `--wait` family of flags.
 *
 * Every polling command accepts `--wait`, `--interval` (seconds) and
 * `--timeout` (minutes) with the same semantics but different defaults. This
 * module owns that parsing so command modules do not import it from one
 * another.
 */

/** Poll timings in milliseconds. */
export type WaitWindow = {
  intervalMs: number;
  timeoutMs: number;
};

/** The subset of parsed CLI args the wait flags occupy. */
export type WaitArgs = {
  wait?: boolean;
  interval?: string;
  timeout?: string;
};

/** Per-command defaults, expressed in the units the flags use. */
export type WaitDefaults = {
  /** Default poll interval, in seconds. */
  intervalSeconds: number;
  /** Default overall timeout, in minutes. */
  timeoutMinutes: number;
};

/**
 * Parse a numeric wait flag, falling back when it was not supplied.
 *
 * @throws Error when the flag is present but not a positive number.
 */
export function parseWaitNumber(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

/** Convert the wait flags into milliseconds, using `defaults` where unset. */
export function waitWindow(args: WaitArgs, defaults: WaitDefaults): WaitWindow {
  return {
    intervalMs: parseWaitNumber(args.interval, defaults.intervalSeconds, "--interval") * 1000,
    timeoutMs: parseWaitNumber(args.timeout, defaults.timeoutMinutes, "--timeout") * 60 * 1000,
  };
}

/**
 * Resolve the wait window only when `--wait` was passed.
 *
 * Returning `undefined` otherwise lets callers branch on the window itself
 * rather than re-testing `args.wait` and carrying optional numbers around.
 */
export function resolveWaitWindow(args: WaitArgs, defaults: WaitDefaults): WaitWindow | undefined {
  return args.wait ? waitWindow(args, defaults) : undefined;
}
