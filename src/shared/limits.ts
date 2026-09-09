/**
 * Size and count ceilings applied to untrusted input.
 *
 * Nothing here is a security boundary — the backend enforces its own limits.
 * These caps exist so a mistyped path, a runaway log, or a corrupt cache fails
 * with a clear message instead of exhausting memory or silently sending a
 * multi-megabyte payload upstream.
 */
import { statSync } from "node:fs";

/** Largest file accepted for a `--*-file` flag (patches, descriptions, …). */
export const MAX_INPUT_FILE_BYTES = 5 * 1024 * 1024;

/** Largest cache/credential file the CLI will parse from disk. */
export const MAX_LOCAL_STATE_BYTES = 1 * 1024 * 1024;

/** Largest payload read from stdin when a flag is given as `-`. */
export const MAX_STDIN_BYTES = MAX_INPUT_FILE_BYTES;

/** Largest on-disk local budget ledger the CLI will parse. */
export const MAX_BUDGET_STATE_BYTES = 16 * 1024 * 1024;

/** Upper bound for any `--limit` flag, whatever the command's default. */
export const MAX_RESULT_LIMIT = 500;

/** Format a byte count for error messages. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Throw when `path` is larger than `maxBytes`.
 *
 * @throws Error when the file exceeds the cap. A missing or unreadable file is
 *   left to the caller's own read, which reports a better message.
 */
export function assertFileWithinLimit(path: string, maxBytes: number, label = "File"): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size > maxBytes) {
    throw new Error(
      `${label} is too large: ${formatBytes(size)} exceeds the ${formatBytes(maxBytes)} limit (${path})`,
    );
  }
}

/**
 * Clamp a parsed `--limit` into `1..MAX_RESULT_LIMIT`.
 *
 * @throws Error when the flag is present but not a positive integer.
 */
export function clampResultLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return Math.min(value, MAX_RESULT_LIMIT);
}
