/** Minimal output formatting helpers. */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

type Cell = string | number | boolean | null | undefined;
export interface TableColumn {
  key: string;
  label: string;
  width?: number;
}

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

function padVisible(str: string, width: number): string {
  const needed = width - stripAnsi(str).length;
  return needed > 0 ? str + " ".repeat(needed) : str;
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printTable(
  rows: Record<string, Cell>[],
  columns: TableColumn[],
): void {
  if (rows.length === 0) {
    console.log("  (no results)");
    return;
  }
  const widths = columns.map((column) => {
    const maxData = Math.max(
      ...rows.map((row) => stripAnsi(String(row[column.key] ?? "")).length),
    );
    return column.width ?? Math.max(column.label.length, maxData);
  });
  const header = columns
    .map((column, index) => column.label.padEnd(widths[index] ?? 0))
    .join("  ");
  console.log(`  ${header}`);
  console.log(`  ${widths.map((width) => "─".repeat(width)).join("  ")}`);
  for (const row of rows) {
    const line = columns
      .map((column, index) =>
        padVisible(String(row[column.key] ?? ""), widths[index] ?? 0),
      )
      .join("  ");
    console.log(`  ${line}`);
  }
}

export function printKeyValue(
  pairs: Array<[string, string | undefined | null]>,
): void {
  const maxKey = Math.max(...pairs.map(([key]) => key.length));
  for (const [key, value] of pairs) {
    if (value !== undefined && value !== null) {
      console.log(`  ${key.padEnd(maxKey)}  ${value}`);
    }
  }
}

/** Status badge for terminal output. */
export function statusBadge(status: string): string {
  const map: Record<string, string> = {
    completed: "\x1b[32m✓\x1b[0m",
    running: "\x1b[33m⟳\x1b[0m",
    pending: "\x1b[90m○\x1b[0m",
    failed: "\x1b[31m✗\x1b[0m",
    draft: "\x1b[90m○\x1b[0m",
    pending_solution: "\x1b[33m○\x1b[0m",
    pending_review: "\x1b[34m○\x1b[0m",
    accepted: "\x1b[32m✓\x1b[0m",
    rejected: "\x1b[31m✗\x1b[0m",
    revision_requested: "\x1b[33m!\x1b[0m",
    finalizing_review: "\x1b[34m⟳\x1b[0m",
    approved: "\x1b[32m✓\x1b[0m",
    pass: "\x1b[32m✓\x1b[0m",
    fail: "\x1b[31m✗\x1b[0m",
    warning: "\x1b[33m!\x1b[0m",
    skipped: "\x1b[90m-\x1b[0m",
    missing_fields: "\x1b[33m○\x1b[0m",
  };
  return `${map[status] ?? "?"} ${status}`;
}

export function truncate(str: string, max: number): string {
  const oneLine = str.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`;
}
