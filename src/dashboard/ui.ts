import { clean, dashboardRows, type OverviewSnapshot, type Row } from "./data.ts";
import { type ViewState } from "./tui.ts";

const colorEnabled =
  process.stdout.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";
const ansi = (value: string): string => (colorEnabled ? value : "");
const semanticColor = {
  green: 114,
  red: 210,
  amber: 222,
  blue: 117,
} as const;
const foreground = (color: keyof typeof semanticColor): string =>
  ansi(`\x1b[0;1;38;5;${semanticColor[color]}m`);
const statusBackground = (color: keyof typeof semanticColor): string =>
  ansi(`\x1b[0;1;38;5;232;48;5;${semanticColor[color]}m`);
const reset = ansi("\x1b[0m");
const colors = {
  green: foreground("green"),
  red: foreground("red"),
  amber: foreground("amber"),
  blue: foreground("blue"),
  muted: ansi("\x1b[0;38;5;145m"),
  purple: ansi("\x1b[0;1;38;5;141m"),
  accent: ansi("\x1b[0;1;38;5;159m"),
  card: ansi("\x1b[0;1;38;5;159m"),
  white: ansi("\x1b[0;38;5;252m"),
  dim: ansi("\x1b[0;38;5;145m"),
  bronze: ansi("\x1b[0;1;38;5;215m"),
  silver: ansi("\x1b[0;1;38;5;250m"),
  gold: ansi("\x1b[0;1;38;5;220m"),
  platinum: ansi("\x1b[0;1;38;5;159m"),
};
const statusColors = {
  green: statusBackground("green"),
  red: statusBackground("red"),
  amber: statusBackground("amber"),
  blue: statusBackground("blue"),
  muted: ansi("\x1b[0;38;5;245;49m"),
  accent: ansi("\x1b[0;1;38;5;255;49m"),
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
const animated = (row: Row) =>
  /^(running|pending|queued|processing|building)$/i.test(row.status)
  && !["stale", "scratched", "outdated"].includes(row.freshness);
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "?";
const spinner = (now: number) =>
  ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][Math.floor(now / 300) % 10];
function badge(row: Row, now: number): { text: string; color: string } {
  if (["stale", "scratched", "outdated"].includes(row.freshness))
    return { text: row.freshness.toUpperCase(), color: statusColors.muted };
  const status = `${row.status} ${row.verdict}`.toLowerCase();
  if (animated(row)) return { text: `${spinner(now)} RUN`, color: statusColors.blue };
  const text = row.verdict || (row.status === "not_run" ? "NOT RUN" : row.status.toUpperCase());
  if (row.verdict.startsWith("BAND ")) {
    const band = Number(row.verdict.slice(5));
    return {
      text: `${band}/3`,
      color: band >= 3 ? statusColors.green : band === 2 ? statusColors.amber : statusColors.red,
    };
  }
  if (/fail|error|reject|cancel|below_bar/.test(status))
    return { text: "FAIL", color: statusColors.red };
  if (/warn|caveat/.test(status)) return { text: "WARN", color: statusColors.amber };
  if (/pass|accepted|approved|available|meets_bar/.test(status))
    return { text: "PASS", color: statusColors.green };
  if (row.status === "completed") return { text: "DONE", color: statusColors.accent };
  return { text, color: row.verdict ? statusColors.accent : statusColors.muted };
}
export function dashboardBadge(row: Row, width: number, now: number): string {
  width = Math.max(0, Math.floor(width));
  const b = badge(row, now);
  const running = animated(row);
  const text =
    running && row.progress !== undefined ? `${spinner(now)} ${Math.floor(row.progress)}%` : b.text;
  const clipped = fit(text, width).trimEnd();
  const visibleWidth = [...graphemes.segment(clipped)].reduce(
    (sum, part) => sum + cellWidth(part.segment),
    0,
  );
  const left = Math.max(0, Math.floor((width - visibleWidth) / 2));
  const label = " ".repeat(left) + clipped + " ".repeat(Math.max(0, width - left - visibleWidth));
  if (!running || width < 3) return b.color + label + reset;
  const filled = row.progress === undefined ? null : Math.floor((width * row.progress) / 100);
  const position = (Math.floor(now / 300) % (width + 3)) - 3;
  let result = "",
    index = 0;
  for (const { segment } of graphemes.segment(label)) {
    const active = filled === null ? index >= position && index < position + 3 : index < filled;
    result += (active ? statusColors.blue : ansi("\x1b[0;1;38;5;255;48;5;238m")) + segment;
    index += cellWidth(segment);
  }
  return result + reset;
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
  tileHeight: number;
  /** Which of the tile's `tileHeight` lines is being drawn. */
  lineIndex: number;
  /** True when this tile holds the cursor. */
  isSelected: boolean;
  now: number;
};

/** Render a single dashboard tile line. */
function renderTile({
  item,
  tileWidth,
  dense,
  tileHeight,
  lineIndex,
  isSelected,
  now,
}: TileContext): string {
  if (!item) return cell("", tileWidth);
  const marker = isSelected ? "▸" : " ";
  if (dense) {
    const badgeWidth = Math.min(Math.max(0, tileWidth - 2), 10);
    const label = abbreviate(shortLabel(item.label), DENSE_LABEL_ABBREVIATIONS);
    return (
      cell(`${marker}${label}`, tileWidth - badgeWidth, colors.card)
      + dashboardBadge(item, badgeWidth, now)
    );
  }
  if (lineIndex === Math.floor(tileHeight / 2)) {
    const left = Math.min(3, tileWidth);
    const badgeWidth = Math.min(Math.max(0, tileWidth - left), 10);
    return (
      cell("", left)
      + dashboardBadge(item, badgeWidth, now)
      + cell("", tileWidth - left - badgeWidth)
    );
  }
  if (lineIndex !== 0) return cell("", tileWidth);
  return cell(` ${marker} ${item.label}`, tileWidth, colors.card);
}

function overviewState(status: string): { label: string; color: string } {
  const value = status.toLowerCase();
  if (value === "accepted" || value === "approved" || value === "finalized")
    return { label: "ACCEPTED", color: colors.green };
  if (value.includes("review") || value === "submitted" || value === "finalizing_review")
    return { label: "IN REVIEW", color: colors.blue };
  if (value.includes("reject") || value.includes("fail"))
    return { label: "ACTION", color: colors.red };
  if (value === "archived") return { label: "ARCHIVED", color: colors.muted };
  if (value.includes("revision") || value.includes("edit"))
    return { label: "NEEDS EDIT", color: colors.amber };
  if (value === "draft") return { label: "DRAFT", color: colors.muted };
  return { label: value.toUpperCase() || "UNKNOWN", color: colors.muted };
}
function relativeTime(timestamp: number | null, now: number): string {
  if (timestamp === null) return "no activity";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
function overviewRunCount(challenge: {
  totalRuns: number | null;
  passedRuns: number | null;
}): string {
  if (challenge.totalRuns === null) return "runs —";
  return `runs ${challenge.passedRuns ?? 0}/${challenge.totalRuns} pass`;
}
function tokenAmount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function nextTokenDrip(timestamp: number | null, now: number): string {
  if (timestamp === null) return "not scheduled";
  const seconds = Math.floor((timestamp - now) / 1000);
  if (seconds <= 0) return "due";
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.floor(seconds / 3600)}h`;
  return new Date(timestamp).toLocaleDateString();
}
function nextRotation(timestamp: number | null, now: number): string {
  if (timestamp === null) return "not scheduled";
  const seconds = Math.floor((timestamp - now) / 1000);
  if (seconds <= 0) return "due";
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.floor(seconds / 3600)}h`;
  return `in ${Math.floor(seconds / 86400)}d`;
}
function tokenTier(name: string | null): { label: string; color: string } {
  const normalized = name?.trim().toLowerCase() ?? "";
  const label = name ?? "Unknown";
  if (normalized.includes("platinum")) return { label, color: colors.platinum };
  if (normalized.includes("gold")) return { label, color: colors.gold };
  if (normalized.includes("silver")) return { label, color: colors.silver };
  if (normalized.includes("bronze")) return { label, color: colors.bronze };
  return { label: name ?? "Unknown", color: colors.muted };
}
function tokenTone(balance: number | null, cap: number | null): string {
  if (balance === null) return colors.muted;
  if (cap === null || cap <= 0) return colors.blue;
  const ratio = balance / cap;
  if (ratio <= 0.1) return colors.red;
  if (ratio <= 0.3) return colors.amber;
  return colors.green;
}
function tokenUsage(balance: number | null, cap: number | null): string {
  if (balance === null || cap === null || cap <= 0) return "usage —";
  const ratio = Math.max(0, Math.min(1, balance / cap));
  const width = 14;
  const filled = Math.round(width * ratio);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${Math.round(ratio * 100)}%`;
}
const SPARK_LEVELS = ["·", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
function timelineBars(values: number[], maximum: number, slotWidth: number): string {
  return values
    .map((value) => {
      const level =
        maximum <= 0 || value <= 0
          ? 0
          : Math.max(1, Math.min(SPARK_LEVELS.length - 1, Math.round((value / maximum) * 8)));
      return SPARK_LEVELS[level].repeat(slotWidth);
    })
    .join(" ");
}
function acceptedWindowDelta(tokens: OverviewSnapshot["tokens"]): number | null {
  if (tokens.lifetimeAccepted === null || tokens.acceptedInWindow === null) return null;
  return Math.max(0, tokens.lifetimeAccepted - tokens.acceptedInWindow);
}
function renderTierDetails(tokens: OverviewSnapshot["tokens"]): string {
  const drip =
    tokens.dripPaused === true
      ? "drip paused"
      : tokens.dripUnlimited === true
        ? "unlimited drip"
        : tokens.tierDripAmount === null
          ? "drip rate —"
          : `+${tokenAmount(tokens.tierDripAmount)}/hr drip`;
  const cap = tokens.cap === null ? "cap —" : `${tokenAmount(tokens.cap)} cap`;
  const bonus =
    tokens.tierAcceptanceBonusUsd === null
      ? "accepted bonus —"
      : `+$${tokenAmount(tokens.tierAcceptanceBonusUsd)} accepted bonus`;
  return `Tier ${tokens.tierName ?? "Unknown"} · ${drip} · ${cap} · ${bonus}`;
}
function renderAcceptedDetails(tokens: OverviewSnapshot["tokens"]): string {
  const window = tokens.tierWindowDays === null ? "—" : `${tokenAmount(tokens.tierWindowDays)}d`;
  const accepted = tokens.acceptedInWindow === null ? "—" : tokenAmount(tokens.acceptedInWindow);
  const olympus =
    tokens.olympusAcceptedInWindow === null ? "—" : tokenAmount(tokens.olympusAcceptedInWindow);
  const lifetime = tokens.lifetimeAccepted === null ? "—" : tokenAmount(tokens.lifetimeAccepted);
  const agedOut = acceptedWindowDelta(tokens);
  return `Accepted · last ${window} ${accepted} · ${olympus} Olympus · ${agedOut === null ? "aged out —" : `${agedOut} aged out`} · lifetime ${lifetime}`;
}
function renderNextTierDetails(tokens: OverviewSnapshot["tokens"]): string | null {
  const next = tokens.nextTierRequirement;
  if (!next?.tierName) return null;
  const accepted = tokens.acceptedInWindow === null ? "—" : tokenAmount(tokens.acceptedInWindow);
  const required = next.requiredAccepted === null ? "—" : tokenAmount(next.requiredAccepted);
  const window = tokens.tierWindowDays === null ? "—" : `${tokenAmount(tokens.tierWindowDays)}d`;
  return `${next.tierName} requires ${accepted}/${required} accepted in ${window}`;
}
function renderEloDetails(elo: OverviewSnapshot["elo"], now: number): string[] {
  if (!elo.available) return [elo.note];
  const toPrestige =
    elo.seatCutElo === null || elo.value === null ? null : Math.max(0, elo.seatCutElo - elo.value);
  const current = tokenAmount(elo.value);
  const projected =
    elo.projectedValue === null
      ? "est. — at rotation"
      : `est. ${tokenAmount(elo.projectedValue)} at rotation`;
  const gap = toPrestige === null ? "to Prestige —" : `to Prestige ${tokenAmount(toPrestige)}`;
  const window = elo.windowDays === null ? "window —" : `window ${tokenAmount(elo.windowDays)}d`;
  const cutoff =
    elo.seatCutElo === null ? "seat cutoff —" : `seat cutoff ${tokenAmount(elo.seatCutElo)}`;
  return [
    `ELO ${current} · ${gap} · ${projected}`,
    `${window} · ${cutoff} · rotates ${nextRotation(elo.nextRotationAt, now)}`,
  ];
}
function chartLine(cells: Array<{ text: string; color: string }>, width: number): string {
  const text = cells.map((cell) => cell.text).join("");
  const visible = [...graphemes.segment(text)].reduce(
    (sum, part) => sum + cellWidth(part.segment),
    0,
  );
  return (
    cells.map((cell) => cell.color + cell.text + reset).join("")
    + cell("", Math.max(0, width - visible))
  );
}
function renderPrestigeUsageChart(
  elo: OverviewSnapshot["elo"],
  now: number,
  width: number,
): Array<{ text: string; color: string }> {
  const bins = elo.usage.bins;
  if (bins.length === 0 || elo.windowDays === null) return [];
  const binMs = elo.usage.binMs ?? 6 * 60 * 60 * 1000;
  const chartNow = elo.timelineNow ?? now;
  const bufferMs = Math.max(0, elo.agedOutBufferMs ?? 0);
  const spanMs = Math.max(binMs * bins.length, elo.windowDays * 24 * 60 * 60 * 1000 + bufferMs);
  const agedOutBins = Math.min(bins.length, Math.floor(bufferMs / binMs));
  const maximum = Math.max(1, ...bins);
  const total = bins.reduce((sum, value) => sum + value, 0);
  const slotWidth = width >= 120 ? 2 : 1;
  const plotWidth = bins.length * slotWidth;
  const toLevel = (value: number, max: number) =>
    max <= 0 || value <= 0
      ? 0
      : Math.max(1, Math.min(SPARK_LEVELS.length - 1, Math.round((value / max) * 8)));
  const usageCells = bins.map((value, index) => ({
    text: SPARK_LEVELS[toLevel(value, maximum)].repeat(slotWidth),
    color: index < agedOutBins ? colors.muted : colors.amber,
  }));
  let accumulated = 0;
  const trendCells = bins.map((value, index) => {
    accumulated += value;
    return {
      text: SPARK_LEVELS[toLevel(accumulated, total)].repeat(slotWidth),
      color: index < agedOutBins ? colors.muted : colors.white,
    };
  });
  const markerCells = Array.from({ length: plotWidth }, () => ({ text: "·", color: colors.dim }));
  for (const mark of elo.marks) {
    const position = Math.max(
      0,
      Math.min(plotWidth - 1, Math.round(((mark.at - (chartNow - spanMs)) / spanMs) * plotWidth)),
    );
    markerCells[position] = {
      text: "◆",
      color: mark.countsAtRotation ? colors.green : mark.inWindow ? colors.amber : colors.muted,
    };
  }
  const axis = `        aged out${" ".repeat(Math.max(1, plotWidth - 15))}now`;
  const hours = Math.max(1, Math.round(binMs / (60 * 60 * 1000)));
  const chartLabelWidth = 18;
  const chartRow = (
    label: string,
    cells: Array<{ text: string; color: string }>,
    color: string,
  ) => ({
    text: `${fit(` ${label}`, chartLabelWidth)}${chartLine(cells, Math.max(0, width - chartLabelWidth))}`,
    color,
  });
  return [
    { text: ` Usage · ${hours}h bins · ${elo.windowDays}d window`, color: colors.white },
    chartRow(`usage`, usageCells, colors.amber),
    chartRow("cumulative usage", trendCells, colors.white),
    chartRow("accepted markers", markerCells, colors.dim),
    { text: axis, color: colors.dim },
    {
      text: ` ${tokenAmount(elo.acceptedAtRotation)} count at rotation · ${tokenAmount(elo.agingOutByRotation)} aging out`,
      color: colors.dim,
    },
  ];
}
function renderAcceptedTimeline(
  timeline: OverviewSnapshot["acceptedTimeline"],
  acceptedInWindow: number | null,
  width: number,
): Array<{ text: string; color: string }> {
  if (!timeline || (timeline.marks.length === 0 && acceptedInWindow === 0)) return [];
  const dayMs = 24 * 60 * 60 * 1000;
  const windowMs = timeline.windowDays * dayMs;
  const spanMs = Math.max(dayMs, (timeline.windowDays + timeline.bufferDays) * dayMs);
  const from = timeline.now - spanMs;
  const plotWidth = Math.max(30, Math.min(76, width - 18));
  const cells = Array.from({ length: plotWidth }, () => ({ text: "·", color: colors.dim }));
  const laneCounts = new Map<string, number>();
  let inWindow = 0;
  let agedOut = 0;
  for (const mark of timeline.marks) {
    const position = Math.max(
      0,
      Math.min(plotWidth - 1, Math.round(((mark.at - from) / spanMs) * (plotWidth - 1))),
    );
    const counts = timeline.now - mark.at <= windowMs;
    if (counts) {
      inWindow++;
      laneCounts.set(mark.lane, (laneCounts.get(mark.lane) ?? 0) + 1);
    } else {
      agedOut++;
    }
    cells[position] = { text: "◆", color: counts ? colors.green : colors.muted };
  }
  const boundary = Math.max(
    0,
    Math.min(
      plotWidth - 1,
      Math.round((timeline.bufferDays / (timeline.windowDays + timeline.bufferDays)) * plotWidth),
    ),
  );
  if (cells[boundary].text === "·") cells[boundary] = { text: "┆", color: colors.dim };
  const laneSummary = [...laneCounts.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([lane, count]) => `${count} ${lane}`)
    .join(" · ");
  const acceptedLabel = `${colors.green}${acceptedInWindow ?? inWindow} accepted${reset}`;
  return [
    { text: ` Accepted · last ${timeline.windowDays}d`, color: colors.white },
    { text: chartLine(cells, width), color: colors.dim },
    { text: ` ${alignedTimelineAxis(plotWidth)}`, color: colors.dim },
    {
      text: ` ${acceptedLabel} · ${agedOut} aged out · ${timeline.windowDays}d window${laneSummary ? ` · ${laneSummary}` : ""}`,
      color: colors.dim,
    },
    ...(agedOut > 0
      ? [
          {
            text: ` ${agedOut} accepted just aged out of the window`,
            color: colors.amber,
          },
        ]
      : []),
  ];
}
function panelRows(title: string, content: string[], width: number): string[] {
  const rule = "─".repeat(Math.max(0, width - title.length - 2));
  return [`${colors.accent} ${title} ${rule}${reset}`, ...content.map((line) => ` ${line}`)];
}
function styleOverviewRow(row: { text: string; color: string }): string {
  return row.text.includes("\x1b[") ? row.text : `${row.color}${row.text}${reset}`;
}
function alignedTimelineAxis(plotWidth: number): string {
  const labels = ["aged out", "24d window", "now"];
  const chars = Array.from({ length: plotWidth }, () => " ");
  const positions = [
    0,
    Math.max(labels[0].length + 1, Math.floor((plotWidth - labels[1].length) / 2)),
    Math.max(0, plotWidth - labels[2].length),
  ];
  for (const [index, label] of labels.entries()) {
    const position = Math.min(positions[index], plotWidth - label.length);
    for (const [offset, char] of [...label].entries()) {
      if (position + offset >= 0 && position + offset < chars.length)
        chars[position + offset] = char;
    }
  }
  return chars.join("");
}
function renderOverviewBody(
  state: ViewState,
  width: number,
  height: number,
  now: number,
): string[] {
  const lines: string[] = [];
  const add = (text: unknown, color = colors.white) => lines.push(cell(text, width, color));
  const addSection = (title: string, color = colors.accent) => {
    const label = ` ${title.toUpperCase()} `;
    add(`${label}${"─".repeat(Math.max(0, width - label.length))}`, color);
  };
  const snapshot = state.overview;
  if (!snapshot) {
    add(
      state.busy ? `${spinner(now)} Loading your challenges...` : "Waiting for challenges...",
      colors.white,
    );
    add("q exit", colors.dim);
    return lines;
  }
  const challenges = snapshot.challenges;
  const activeStatuses = new Set([
    "draft",
    "submitted",
    "pending_review",
    "revision_requested",
    "finalizing_review",
  ]);
  const active = challenges.filter((challenge) =>
    activeStatuses.has(challenge.status.toLowerCase()),
  ).length;
  const accepted = challenges.filter((challenge) =>
    ["accepted", "approved", "finalized"].includes(challenge.status.toLowerCase()),
  ).length;
  const attention = challenges.filter((challenge) => {
    const value = challenge.status.toLowerCase();
    return value.includes("reject") || value.includes("revision") || value.includes("fail");
  }).length;
  const tokenToneColor = snapshot.tokens.error
    ? colors.red
    : tokenTone(snapshot.tokens.balance, snapshot.tokens.cap);
  const tier = tokenTier(snapshot.tokens.tierName);
  add(
    ` HOME · ${challenges.length} visible · updated ${relativeTime(snapshot.fetchedAt, now)}`,
    colors.dim,
  );
  addSection("Summary", colors.blue);
  const visibleSummary =
    snapshot.totalChallenges === challenges.length
      ? `${challenges.length} challenges`
      : `${challenges.length}/${snapshot.totalChallenges} shown`;
  lines.push(
    `${colors.white} ${visibleSummary}${reset}`
      + `${accepted > 0 ? colors.green : colors.muted} · ${accepted} accepted${reset}`
      + `${active > 0 ? colors.blue : colors.muted} · ${active} active${reset}`
      + `${attention > 0 ? colors.amber : colors.green} · ${attention} attention${reset}`,
  );

  const wide = width >= 100 && height >= 32;
  const panelContentWidth = Math.max(1, width - 1);
  const acceptedTimeline = renderAcceptedTimeline(
    snapshot.acceptedTimeline,
    snapshot.tokens.acceptedInWindow,
    wide ? panelContentWidth : width,
  );
  const nextTier = renderNextTierDetails(snapshot.tokens);
  const account: string[] = [`${colors.amber}BALANCE${reset}`];
  if (snapshot.tokens.error) {
    account.push(`${colors.red}Tokens unavailable: ${snapshot.tokens.error}${reset}`);
  } else {
    account.push(
      `${tokenToneColor}Balance  ${tokenAmount(snapshot.tokens.balance)} / ${tokenAmount(snapshot.tokens.cap)}  ${tokenUsage(snapshot.tokens.balance, snapshot.tokens.cap)} · drip ${nextTokenDrip(snapshot.tokens.nextDripAt, now)}${reset}`,
    );
    account.push(`${tier.color}${renderTierDetails(snapshot.tokens)}${reset}`);
    if (nextTier) account.push(`${tier.color}Next ${nextTier}${reset}`);
  }
  if (
    !snapshot.tokens.revisionError
    && snapshot.tokens.revisionTokenBalance !== null
    && snapshot.tokens.revisionTokenBalance > 0
  ) {
    account.push(
      `${colors.purple}Revision tickets: ${tokenAmount(snapshot.tokens.revisionTokenBalance)}${reset}`,
    );
  }
  account.push("", `${colors.green}ACCEPTANCE${reset}`);
  if (acceptedTimeline.length > 0) {
    if (wide) account.push(...acceptedTimeline.map(styleOverviewRow));
    else
      account.push(
        `Accepted  last ${snapshot.acceptedTimeline?.windowDays ?? "—"}d · ${tokenAmount(snapshot.tokens.acceptedInWindow)} accepted · ${Math.max(0, (snapshot.acceptedTimeline?.marks.length ?? 0) - (snapshot.tokens.acceptedInWindow ?? 0))} aged out`,
      );
  } else if (!snapshot.tokens.error) {
    account.push(renderAcceptedDetails(snapshot.tokens));
  }

  const prestige: string[] = [
    `${colors.purple}PRESTIGE${reset}`,
    ...(snapshot.elo.available
      ? renderEloDetails(snapshot.elo, now).map(
          (line, index) => `${index === 0 ? colors.white : colors.dim}${line}${reset}`,
        )
      : [`${colors.dim}${snapshot.elo.note}${reset}`]),
  ];
  const prestigeChart = renderPrestigeUsageChart(
    snapshot.elo,
    now,
    wide ? panelContentWidth : width,
  );
  if (prestigeChart.length > 0) {
    if (wide) prestige.push(...prestigeChart.map(styleOverviewRow));
    else {
      const hours = Math.max(1, Math.round((snapshot.elo.usage.binMs ?? 21_600_000) / 3_600_000));
      prestige.push(
        `Usage  ${timelineBars(snapshot.elo.usage.bins, Math.max(0, ...snapshot.elo.usage.bins), 1)} · ${hours}h bins`,
      );
    }
  }

  if (wide) {
    lines.push(...panelRows("ACCOUNT", [...account, ...prestige], width));
  } else {
    addSection("Account", colors.accent);
    add(" BALANCE", colors.amber);
    if (snapshot.tokens.error) add(` Tokens unavailable: ${snapshot.tokens.error}`, colors.red);
    else {
      add(
        ` Balance  ${tokenAmount(snapshot.tokens.balance)} / ${tokenAmount(snapshot.tokens.cap)}  ${tokenUsage(snapshot.tokens.balance, snapshot.tokens.cap)} · next drip ${nextTokenDrip(snapshot.tokens.nextDripAt, now)}`,
        tokenToneColor,
      );
      add(` ${renderTierDetails(snapshot.tokens)}`, tier.color);
      if (nextTier) add(` Next ${nextTier}`, tier.color);
    }
    if (
      !snapshot.tokens.revisionError
      && snapshot.tokens.revisionTokenBalance !== null
      && snapshot.tokens.revisionTokenBalance > 0
    )
      add(` Revision tickets: ${tokenAmount(snapshot.tokens.revisionTokenBalance)}`, colors.purple);
    add(" ACCEPTANCE", colors.green);
    if (acceptedTimeline.length > 0) {
      const acceptedCount = tokenAmount(snapshot.tokens.acceptedInWindow);
      const agedOutCount = Math.max(
        0,
        (snapshot.acceptedTimeline?.marks.length ?? 0) - (snapshot.tokens.acceptedInWindow ?? 0),
      );
      lines.push(
        ` ${colors.dim}Accepted · last ${snapshot.acceptedTimeline?.windowDays ?? "—"}d · ${colors.green}${acceptedCount} accepted${reset} · ${colors.dim}${agedOutCount} aged out${reset}`,
      );
    } else if (!snapshot.tokens.error)
      add(` ${renderAcceptedDetails(snapshot.tokens)}`, colors.white);

    add(" PRESTIGE", colors.purple);
    for (const line of prestige) if (!line.includes("PRESTIGE")) lines.push(` ${line}`);
  }

  addSection("Challenges");
  add(` ${state.busy ? `${spinner(now)} ` : ""}Select a challenge to monitor`, colors.white);
  if (state.error) add(`! ${state.error}`, colors.red);
  if (challenges.length === 0) {
    add("No challenges found for this account.", colors.dim);
    add("q exit  r refresh", colors.accent);
    return lines;
  }
  const selectedIndex = Math.max(0, Math.min(state.overviewSelected, challenges.length - 1));
  const footerLines = 1;
  const detailLines = 3;
  const listRoom = Math.max(1, height - lines.length - footerLines - detailLines);
  const maxStart = Math.max(0, challenges.length - listRoom);
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(listRoom / 2), maxStart));
  if (start > 0) add(`  ↑ ${start} more above`, colors.dim);
  const titleWidth = Math.max(14, Math.min(42, Math.floor(width * 0.42)));
  const statusWidth = Math.min(12, Math.max(8, Math.floor(width * 0.18)));
  const runWidth = Math.max(12, width - titleWidth - statusWidth - 10);
  for (const [offset, challenge] of challenges.slice(start, start + listRoom).entries()) {
    const index = start + offset;
    const selected = index === selectedIndex;
    const status = overviewState(challenge.status);
    const meta = `${overviewRunCount(challenge)} · ${relativeTime(challenge.lastActivityAt, now)}`;
    add(
      ` ${selected ? "▸" : " "} ${fit(challenge.title, titleWidth)} ${cell(status.label, statusWidth, status.color)} ${fit(meta, runWidth)}`,
      selected ? colors.card : colors.white,
    );
  }
  if (start + listRoom < challenges.length)
    add(`  ↓ ${challenges.length - start - listRoom} more below`, colors.dim);
  const selected = challenges[selectedIndex];
  const selectedStatus = overviewState(selected.status);
  add(` SELECTED · ${selected.title}`, colors.accent);
  add(
    ` ID ${selected.id} · ${selectedStatus.label} · ${selected.language ?? "language unknown"} · ${selected.difficulty ?? "difficulty unknown"}`,
    colors.white,
  );
  add(
    ` Enter monitor this challenge · olympus dashboard ${selected.id} · updated ${relativeTime(snapshot.fetchedAt, now)}`,
    colors.dim,
  );
  add(" ↑↓ select   Enter monitor   r refresh   q exit", colors.accent);
  return lines;
}

export function renderDashboard(
  state: ViewState,
  columns: number,
  rowsCount: number,
  now = Date.now(),
  info?: { animating: boolean },
): string {
  const width = Math.max(1, Math.min(columns - 1, 400)),
    height = Math.max(1, Math.min(rowsCount - 1, 150));
  const lines: string[] = [];
  const animatedLines = new Set<string>();
  const put = (text: unknown, color = colors.white) => lines.push(cell(text, width, color));
  const snapshot = state.snapshot;
  put(" OLYMPUS", colors.accent);
  if (state.mode === "overview") {
    lines.push(...renderOverviewBody(state, width, height, now));
  } else if (snapshot) {
    if (height >= 18) put(` ${snapshot.title}`, colors.white);
    if (height >= 16)
      lines.push(
        cell(
          ` ${snapshot.status.toUpperCase()} `,
          Math.min(width, 22, snapshot.status.length + 2),
          snapshot.status === "accepted" ? colors.green : colors.blue,
        )
          + cell(
            `   v${snapshot.version ?? "—"}  ·  read only  ·  updated ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`,
            width - Math.min(width, 22, snapshot.status.length + 2),
            colors.dim,
          ),
      );
    if (state.rowCache?.snapshot !== snapshot)
      state.rowCache = { snapshot, rows: dashboardRows(snapshot) };
    const data = state.rowCache.rows;
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
    const tileHeight = dense ? 1 : 3;
    const cols = Math.max(1, Math.floor((width + 2) / (dense ? (width < 60 ? 28 : 25) : 28)));
    const showBudget = height >= 18 && budget?.data?.enabled === true;
    const showReady = height >= 18 && readinessKnown?.canSubmit === true;
    const footerSize = (height >= 5 ? 1 : 0) + Number(showBudget) + Number(showReady);
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
      const heading = ` ${focused ? "▸ " : "  "}${group.title} · ${group.items.length}${group.items.length > capacity ? `  ${start + 1}–${Math.min(start + capacity, group.items.length)} / ${group.items.length}` : ""} `;
      put(
        `${heading}${"─".repeat(Math.max(0, width - heading.length))}`,
        focused ? colors.accent : colors.dim,
      );
      const tileWidth = Math.floor((width - (cols - 1) * 3) / cols);
      for (let r = 0; r < rowCount; r++) {
        for (let lineIndex = 0; lineIndex < tileHeight; lineIndex++) {
          let line = "";
          let lineAnimates = false;
          for (let c = 0; c < cols; c++) {
            const item = group.items[start + r * cols + c];
            const badgeWidth = dense
              ? Math.min(Math.max(0, tileWidth - 2), 10)
              : Math.min(Math.max(0, tileWidth - 3), 10);
            if (
              item
              && (dense || lineIndex === Math.floor(tileHeight / 2))
              && badgeWidth > 0
              && animated(item)
            )
              lineAnimates = true;
            line += renderTile({
              item,
              tileWidth,
              dense,
              tileHeight,
              lineIndex,
              isSelected: focused && item === selectedItem,
              now,
            });
            if (c < cols - 1) line += "   ";
          }
          const renderedLine = line + cell("", width - tileWidth * cols - (cols - 1) * 3);
          lines.push(renderedLine);
          if (lineAnimates) animatedLines.add(renderedLine);
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
    if (showBudget)
      footer.push(
        cell(
          ` LOCAL BUDGET ${num(budgetData.remaining)} LEFT  /  ${num(budgetData.spent)} SPENT  /  ${num(budgetData.reserved)} RESERVED`,
          width,
          colors.dim,
        ),
      );
    if (showReady) footer.push(cell(" READY TO SUBMIT", width, colors.green));
    if (height >= 5)
      footer.push(
        cell(
          state.details
            ? " PgUp/PgDn details · Enter close · q exit"
            : width < 95
              ? " Tab/↑↓ select · Enter info · q exit"
              : " q exit  r refresh  Tab section  arrows select  Enter details  b overview  h history  PgUp/PgDn page",
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
    put(
      state.busy ? `${spinner(now)} Connecting to challenge...` : "Waiting for challenge · r retry",
      colors.white,
    );
    if (state.busy) animatedLines.add(lines[lines.length - 1]);
    put("q exit · r refresh · b overview", colors.dim);
  }
  while (lines.length < height) put("");
  const visibleLines = lines.slice(0, height);
  if (info) info.animating = visibleLines.some((line) => animatedLines.has(line));
  return `\x1b[H${visibleLines.map((line) => `${line + reset}\x1b[K`).join("\r\n")}\x1b[J`;
}
