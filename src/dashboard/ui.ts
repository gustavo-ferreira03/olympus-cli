import { clean, dashboardRows, type Row } from "./data.ts";
import { type ViewState } from "./tui.ts";

const reset = "\x1b[0m";
const colors = {
  green: "\x1b[0;1;38;5;232;48;5;114m",
  red: "\x1b[0;1;38;5;232;48;5;210m",
  amber: "\x1b[0;1;38;5;232;48;5;222m",
  blue: "\x1b[0;1;38;5;232;48;5;117m",
  muted: "\x1b[0;38;5;245;49m",
  accent: "\x1b[0;1;38;5;255;49m",
  card: "\x1b[0;1;38;5;252;49m",
  white: "\x1b[0;38;5;252;49m",
  dim: "\x1b[0;38;5;245;49m",
};
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cellWidth = (char: string): number => {
  // Matching the ZWJ and variation selector individually is exactly what
  // grapheme width measurement needs here.
  // eslint-disable-next-line no-misleading-character-class
  if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(char)) return 0;
  if (/\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(char)) return 2;
  const cp = char.codePointAt(0)!;
  return cp >= 0x1100
    && (cp <= 0x115f
      || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe10 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0x20000 && cp <= 0x3ffff))
    ? 2
    : 1;
};
export function fit(value: unknown, width: number): string {
  let result = "",
    cells = 0;
  for (const { segment } of graphemes.segment(clean(value))) {
    const size = cellWidth(segment);
    if (cells + size > width) break;
    result += segment;
    cells += size;
  }
  return result + " ".repeat(Math.max(0, width - cells));
}
function wrap(value: unknown, width: number): string[] {
  const lines: string[] = [];
  let line = "",
    cells = 0;
  for (const { segment } of graphemes.segment(clean(value))) {
    const size = cellWidth(segment);
    if (cells + size > width && line) {
      lines.push(line);
      line = "";
      cells = 0;
    }
    line += size > width ? "�" : segment;
    cells += Math.min(size, width);
  }
  lines.push(line);
  return lines;
}
const cell = (text: unknown, width: number, color = colors.white) =>
  color + fit(text, width) + reset;
const age = (time: number | null | undefined, now: number) =>
  time ? `${Math.max(0, Math.floor((now - time) / 1000))}s` : "never";
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "?";
function badge(row: Row): { text: string; color: string } {
  if (["stale", "scratched", "outdated"].includes(row.freshness))
    return { text: row.freshness.toUpperCase(), color: colors.muted };
  const status = `${row.status} ${row.verdict}`.toLowerCase();
  if (/running|pending|queued|processing|building/.test(row.status))
    return { text: "RUNNING", color: colors.blue };
  const text = row.verdict || (row.status === "not_run" ? "NOT RUN" : row.status.toUpperCase());
  if (row.verdict.startsWith("BAND ")) {
    const band = Number(row.verdict.slice(5));
    return {
      text: `${band}/3`,
      color: band >= 3 ? colors.green : band === 2 ? colors.amber : colors.red,
    };
  }
  if (/fail|error|reject|cancel|below_bar/.test(status)) return { text: "FAIL", color: colors.red };
  if (/warn|caveat/.test(status)) return { text: "WARN", color: colors.amber };
  if (/pass|accepted|approved|available|meets_bar/.test(status))
    return { text: "PASS", color: colors.green };
  if (row.status === "completed") return { text: "DONE", color: colors.accent };
  return { text, color: row.verdict ? colors.accent : colors.muted };
}
const shortLabel = (label: string) =>
  label
    .replace("Verify ", "")
    .replace("Description Quality", "Description")
    .replace("Solution Quality", "Solution quality")
    .replace("Test Quality", "Test quality")
    .replace("Task Quality", "Task quality")
    .replace("Verifier Incompleteness", "Verifier audit")
    .replace(" · re-eval ", " / RE ");

/** Status abbreviations used when a tile is too narrow for the full word. */
const DENSE_STATUS_ABBREVIATIONS: Array<[string, string]> = [
  ["RUNNING", "RUN"],
  ["WARNING", "WARN"],
  ["MEETS BAR", "MEETS"],
  ["BAND ", "B"],
];

/** Label abbreviations used when a tile is too narrow for the full name. */
const DENSE_LABEL_ABBREVIATIONS: Array<[string, string]> = [
  ["Test quality", "Test Q."],
  ["Task quality", "Task Q."],
  ["Solution quality", "Sol. Q."],
  ["Description Quality", "Desc. Q."],
  ["Description", "Desc."],
  ["Effective scope", "Scope"],
  ["Image / Build", "Build"],
  ["Scope Gate", "Scope"],
  [" · re-eval ", "/R"],
  [" / RE ", "/R"],
];

/** Apply an abbreviation table in order. */
function abbreviate(text: string, table: Array<[string, string]>): string {
  let result = text;
  for (const [from, to] of table) result = result.replace(from, to);
  return result;
}

/** How one tile should be drawn. */
type TileContext = {
  item: Row | undefined;
  tileWidth: number;
  dense: boolean;
  /** Which of the tile's `tileHeight` lines is being drawn. */
  lineIndex: number;
  /** True when this tile holds the cursor. */
  isSelected: boolean;
};

/** Render a single dashboard tile line. */
function renderTile({ item, tileWidth, dense, lineIndex, isSelected }: TileContext): string {
  if (!item) return cell("", tileWidth);
  const marker = isSelected ? "▸" : " ";
  if (dense) {
    const b = badge(item);
    const status = abbreviate(b.text, DENSE_STATUS_ABBREVIATIONS);
    const badgeWidth = Math.min(Math.max(0, tileWidth - 2), status.length + 2);
    const label = abbreviate(shortLabel(item.label), DENSE_LABEL_ABBREVIATIONS);
    return (
      cell(`${marker}${label}`, tileWidth - badgeWidth, colors.card)
      + cell(` ${status} `, badgeWidth, b.color)
    );
  }
  if (lineIndex) {
    const b = badge(item);
    const badgeWidth = Math.min(tileWidth - 3, b.text.length + 2);
    return (
      cell("   ", 3)
      + cell(` ${b.text} `, badgeWidth, b.color)
      + cell("", tileWidth - 3 - badgeWidth)
    );
  }
  return cell(` ${marker} ${item.label}`, tileWidth, colors.card);
}

export function renderDashboard(
  state: ViewState,
  columns: number,
  rowsCount: number,
  now = Date.now(),
): string {
  const width = Math.max(1, Math.min(columns - 1, 400)),
    height = Math.max(1, Math.min(rowsCount - 1, 150));
  const lines: string[] = [];
  const put = (text: unknown, color = colors.white) => lines.push(cell(text, width, color));
  const snapshot = state.snapshot;
  put(" OLYMPUS", colors.accent);
  if (snapshot) {
    if (height >= 18) put(` ${snapshot.title}`, colors.white);
    if (height >= 16)
      lines.push(
        cell(
          ` ${snapshot.status.toUpperCase()} `,
          Math.min(width, 22, snapshot.status.length + 2),
          snapshot.status === "accepted" ? colors.green : colors.blue,
        )
          + cell(
            `   v${snapshot.version ?? "—"}  ·  read only  ·  updated ${age(snapshot.fetchedAt, now)} ago`,
            width - Math.min(width, 22, snapshot.status.length + 2),
            colors.dim,
          ),
      );
    const data = dashboardRows(snapshot);
    const current = data.runs.filter((item) => item.freshness === "current");
    const passing = current.filter((item) => ["PASS", "PASS_LEGITIMATE"].includes(item.verdict));
    const running = current.filter((item) =>
      ["running", "pending", "queued"].includes(item.status),
    );
    const blockers = data.readiness.filter(
      (item) => !["pass", "warn"].includes(item.status.toLowerCase()),
    );
    const warnings = data.readiness.filter((item) => item.status === "warn");
    const readinessKnown = snapshot.sources.readiness?.data;
    const balance = snapshot.sources.balance,
      budget = snapshot.sources.budget;
    const tokens = `TOKENS ${num(balance?.data?.balance)}`;
    const cards = [
      tokens,
      `RUNS ${passing.length}/${current.length} PASS`,
      `${running.length} RUNNING`,
      readinessKnown
        ? `${blockers.length} BLOCKERS / ${warnings.length} WARN`
        : "READINESS UNKNOWN",
    ];
    const cardColors = [colors.white, colors.white, colors.white, colors.white];
    const cardWidth = Math.floor(width / cards.length);
    if (height >= 16)
      lines.push(
        cards
          .map((text, i) =>
            cell(
              ` ${text}`,
              i === cards.length - 1 ? width - cardWidth * i : cardWidth,
              cardColors[i],
            ),
          )
          .join(""),
      );
    const displayRuns = state.history ? data.runs : current;
    [data.checks, displayRuns, data.readiness].forEach((items, i) => {
      state.selected[i] = Math.max(0, Math.min(state.selected[i] ?? 0, items.length - 1));
    });
    const dense = height < 35 || width < 80;
    const tileHeight = dense ? 1 : 2;
    const cols = Math.max(1, Math.floor((width + 2) / (dense ? (width < 60 ? 28 : 25) : 28)));
    const footerSize =
      (height >= 5 ? 1 : 0)
      + (height >= 18 ? 1 : 0)
      + (height >= 18 && readinessKnown && blockers.length > 0 ? 1 : 0);
    const preparation = data.checks.filter(
      (item) => item.key.startsWith("stage:") || item.key === "scope" || item.key === "image",
    );
    const reviews = data.checks.filter(
      (item) =>
        item.key === "fp" || item.key.startsWith("review:") || /auto.?review/i.test(item.key),
    );
    const quality = data.checks.filter(
      (item) => !preparation.includes(item) && !reviews.includes(item),
    );
    const sections = [
      { title: "Preparation", items: preparation, section: 0 },
      { title: "Quality Checks", items: quality, section: 0 },
      {
        title: state.history ? "Rollouts · history" : "Rollouts",
        items: displayRuns,
        section: 1,
      },
      {
        title: "Auto Review",
        items: reviews.filter((item) => item.key !== "fp"),
        section: 0,
      },
      {
        title: "FP Check",
        items: reviews.filter((item) => item.key === "fp"),
        section: 0,
      },
    ];
    if (state.section === 2)
      sections.push({ title: "Readiness", items: data.readiness, section: 2 });
    const bodyStart = lines.length;
    let focusStart = bodyStart,
      focusEnd = bodyStart;
    for (const group of sections) {
      const original =
        group.section === 0 ? data.checks : group.section === 1 ? displayRuns : data.readiness;
      const selectedItem = original[state.selected[group.section]];
      const selected = Math.max(0, group.items.indexOf(selectedItem));
      const needed = Math.max(1, Math.ceil(group.items.length / cols));
      const rowCount = needed;
      const capacity = rowCount * cols;
      const start = 0;
      const focused = state.section === group.section && group.items.includes(selectedItem);
      const groupStart = lines.length;
      const heading = ` ${focused ? "▸ " : ""}${group.title}${group.items.length > capacity ? `  ${start + 1}–${Math.min(start + capacity, group.items.length)} / ${group.items.length}` : ""} `;
      put(`╭─${heading}${"─".repeat(Math.max(0, width - heading.length - 3))}╮`, colors.accent);
      const tileWidth = Math.floor((width - (cols - 1) * 3) / cols);
      for (let r = 0; r < rowCount; r++) {
        for (let lineIndex = 0; lineIndex < tileHeight; lineIndex++) {
          let line = "";
          for (let c = 0; c < cols; c++) {
            const item = group.items[start + r * cols + c];
            line += renderTile({
              item,
              tileWidth,
              dense,
              lineIndex,
              isSelected: focused && item === selectedItem,
            });
            if (c < cols - 1) line += "   ";
          }
          lines.push(line + cell("", width - tileWidth * cols - (cols - 1) * 3));
        }
      }
      if (focused || (state.section === group.section && original.length === 0)) {
        focusEnd = groupStart + 1 + (Math.floor(selected / cols) + 1) * tileHeight;
        focusStart = groupStart;
      }
    }

    const details: string[] = [];
    if (state.details) {
      const selectedLists = [data.checks, displayRuns, data.readiness];
      const selected = selectedLists[state.section][state.selected[state.section]];
      const text = `${selected?.batch ? `Campaign: ${selected.batch} | ` : ""}${selected?.status ?? ""} ${selected?.verdict ?? ""} | ${selected?.detail || "No summary available"}`;
      const wrapped = wrap(text, width);
      const pageSize = Math.max(
        1,
        Math.min(6, Math.floor((height - bodyStart - footerSize - 1) / 2)),
      );
      state.detailPageSize = pageSize;
      state.detailOffset = Math.max(
        0,
        Math.min(state.detailOffset ?? 0, wrapped.length - pageSize),
      );
      const offset = state.detailOffset;
      details.push(
        cell(
          ` DETAILS ${offset + 1}–${Math.min(offset + pageSize, wrapped.length)}/${wrapped.length} ${offset ? "↑" : ""}${offset + pageSize < wrapped.length ? "↓" : ""} ${selected?.label ?? "No selection"}`,
          width,
          colors.accent,
        ),
      );
      details.push(...wrapped.slice(offset, offset + pageSize).map((line) => cell(line, width)));
    }
    const footer: string[] = [];
    const budgetData = budget?.data;
    if (height >= 18)
      footer.push(
        cell(
          ` LOCAL BUDGET ${budgetData?.enabled === false ? "DISABLED" : budgetData ? `${num(budgetData.remaining)} LEFT  /  ${num(budgetData.spent)} SPENT  /  ${num(budgetData.reserved)} RESERVED` : "UNAVAILABLE"}  |  ${snapshot.id}`,
          width,
          colors.dim,
        ),
      );
    if (height >= 18 && readinessKnown && blockers.length > 0)
      footer.push(
        cell(` BLOCKED: ${blockers.map((item) => item.label).join(", ")}`, width, colors.red),
      );
    if (height >= 5)
      footer.push(
        cell(
          state.details
            ? " PgUp/PgDn details · Enter close · q exit"
            : width < 95
              ? " Tab/↑↓ select · Enter info · q exit"
              : " q exit  r refresh  Tab section  arrows select  Enter details  h history  PgUp/PgDn page",
          width,
          colors.accent,
        ),
      );
    const body = lines.splice(bodyStart);
    const room = Math.max(1, height - bodyStart - footer.length - details.length);
    let top = Math.max(0, Math.min(state.viewportTop ?? 0, body.length - room));
    const start = focusStart - bodyStart,
      end = focusEnd - bodyStart;
    if (end > top + room) top = end - room;
    if (start < top && end - start <= room) top = start;
    if (end - tileHeight < top) top = Math.max(0, end - tileHeight);
    top = Math.max(0, Math.min(top, body.length - room));
    state.viewportTop = top;
    if (body.length > room)
      lines[0] = cell(
        ` OLYMPUS · view ${top + 1}–${Math.min(top + room, body.length)}/${body.length} ${top ? "↑" : ""}${top + room < body.length ? "↓" : ""}`,
        width,
        colors.accent,
      );
    lines.push(...body.slice(top, top + room));
    while (lines.length < bodyStart + room) put("");
    lines.push(...details, ...footer);
  } else {
    put("");
    put("Connecting to challenge...", colors.white);
    put("q / Ctrl-C exit | r refresh", colors.dim);
  }
  while (lines.length < height) put("");
  return `\x1b[H${lines
    .slice(0, height)
    .map((line) => `${line + reset}\x1b[K`)
    .join("\r\n")}\x1b[J`;
}
