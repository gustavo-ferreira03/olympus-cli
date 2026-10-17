import { cellWidth, fit, fitAnsi, graphemes, wrap } from "./text.ts";
import {
  dashboardRows,
  dashboardSections,
  deliveryFailure,
  inOverviewTab,
  OVERVIEW_TABS,
  STATUS_LABELS,
  visibleChallenges,
  type OverviewSnapshot,
  type Row,
} from "./data.ts";
import { type ViewState } from "./tui.ts";

export { fit } from "./text.ts";

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
    let color = statusColors.red;
    if (band === 2) color = statusColors.amber;
    else if (band >= 3) color = statusColors.green;
    return {
      text: `${band}/3`,
      color,
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

const SHORT_LABELS: Array<[string, string]> = [
  ["Verify ", ""],
  ["Task Prompt Quality", "Task prompt"],
  ["Solution Quality", "Solution quality"],
  ["Test Quality", "Test quality"],
  ["Task Quality", "Task quality"],
  ["Verifier Completeness Audit", "Verifier audit"],
  ["Problem Description & Tests", "Description & tests"],
  ["GitHub Repository", "GitHub repo"],
  ["Delivery Verification", "Delivery"],
  [" · re-eval ", " / RE "],
];
const shortLabel = (label: string) => abbreviate(label, SHORT_LABELS);

/** Label abbreviations used when a tile is too narrow for the full name. */
const DENSE_LABEL_ABBREVIATIONS: Array<[string, string]> = [
  ["Test quality", "Test Q."],
  ["Task quality", "Task Q."],
  ["Solution quality", "Sol. Q."],
  ["Task prompt", "Prompt Q."],
  ["Description & tests", "Desc+tests"],
  ["Plagiarism Review", "Plagiarism"],
  ["Solution Patch", "Sol. patch"],
  ["Verifier audit", "Verifier"],
  ["Rollout Coach", "Coach"],
  ["Effective scope", "Scope"],
  ["Image / Build", "Image"],
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
  const label = item.label.length + 3 <= tileWidth ? item.label : shortLabel(item.label);
  return cell(` ${marker} ${label}`, tileWidth, colors.card);
}

function statusStyle(status: string): { label: string; color: string } {
  const value = status.toLowerCase();
  const label = STATUS_LABELS[value] ?? (value.replaceAll("_", " ") || "unknown");
  if (value === "accepted") return { label, color: colors.green };
  if (value === "rejected") return { label, color: colors.red };
  if (value === "revision_requested") return { label, color: colors.amber };
  if (value === "pending_review" || value === "pending_solution" || value === "finalizing_review")
    return { label, color: colors.blue };
  return { label, color: colors.muted };
}
function relativeTime(timestamp: number | null, now: number): string {
  if (timestamp === null) return "—";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return shortDate(timestamp);
}
const shortDate = (timestamp: number | null): string =>
  timestamp === null
    ? "—"
    : new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
function tokenAmount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function countdown(timestamp: number | null, now: number): string | null {
  if (timestamp === null) return null;
  const minutes = Math.floor((timestamp - now) / 60_000);
  if (minutes <= 0) return "now";
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
function tokenTier(name: string | null): { label: string; color: string } {
  const normalized = name?.trim().toLowerCase() ?? "";
  const label = name ?? "Unknown";
  if (normalized.includes("platinum")) return { label, color: colors.platinum };
  if (normalized.includes("gold")) return { label, color: colors.gold };
  if (normalized.includes("silver")) return { label, color: colors.silver };
  if (normalized.includes("bronze")) return { label, color: colors.bronze };
  return { label, color: colors.muted };
}
function tokenTone(balance: number | null, cap: number | null): string {
  if (balance === null) return colors.muted;
  if (cap === null || cap <= 0) return colors.blue;
  const ratio = balance / cap;
  if (ratio <= 0.1) return colors.red;
  if (ratio <= 0.3) return colors.amber;
  return colors.green;
}
function meter(ratio: number, width: number): string {
  const filled = Math.round(width * Math.max(0, Math.min(1, ratio)));
  return `${"▰".repeat(filled)}${"▱".repeat(width - filled)}`;
}
const join = (parts: Array<string | null | false | undefined>) =>
  parts.filter((part): part is string => Boolean(part)).join(" · ");

function tokenLines(snapshot: OverviewSnapshot, now: number): string[] {
  const tokens = snapshot.tokens;
  if (tokens.error) return [`${colors.red} Tokens unavailable: ${tokens.error}${reset}`];
  const tier = tokenTier(tokens.tierName);
  const ratio = tokens.balance !== null && tokens.cap ? tokens.balance / tokens.cap : 0;
  const revision =
    !tokens.revisionError && tokens.revisionTokenBalance
      ? `${colors.purple}✦ ${tokenAmount(tokens.revisionTokenBalance)} revision${reset}  `
      : "";
  const balance = tokens.dripUnlimited
    ? `${colors.amber}∞${reset}`
    : `${tokenTone(tokens.balance, tokens.cap)}${tokenAmount(tokens.balance)}${colors.dim} / ${tokenAmount(tokens.cap)}${reset}`;
  const lines = [
    ` ${balance}  ${revision}${tier.color}${tier.label.toUpperCase()}${reset}  ${tokenTone(tokens.balance, tokens.cap)}${meter(ratio, 10)}${colors.dim} ${Math.round(ratio * 100)}%${reset}`,
  ];
  const nextDrip =
    tokens.balance !== null && tokens.cap !== null && tokens.balance < tokens.cap
      ? countdown(tokens.nextDripAt, now)
      : null;
  let drip: string | null = null;
  if (tokens.dripPaused) drip = "drip paused";
  else if (!tokens.dripUnlimited && tokens.tierDripAmount)
    drip = `drip +${tokenAmount(tokens.tierDripAmount)}/hr`;
  lines.push(
    `${colors.dim} ${
      join([
        drip,
        nextDrip && `next drip ${nextDrip}`,
        tokens.tierAcceptanceBonusUsd
          ? `accepted bonus +$${tokenAmount(tokens.tierAcceptanceBonusUsd)}`
          : null,
      ]) || "drip —"
    }${reset}`,
  );
  const accepted = tokens.acceptedInWindow ?? 0;
  const rejected = tokens.rejectedInWindow ?? 0;
  const decided = accepted + rejected;
  const window = tokens.tierWindowDays === null ? "" : ` · ${tokenAmount(tokens.tierWindowDays)}d`;
  const rate = decided > 0 ? `${Math.round((accepted / decided) * 100)}%` : "--";
  const breakdown =
    decided > 0
      ? `${colors.dim}  ${colors.green}${accepted} accepted${colors.dim} · ${colors.red}${rejected} rejected${colors.dim} · ${decided} total${reset}`
      : "";
  lines.push(` Approval rate ${colors.white}${rate}${colors.dim}${window}${reset}${breakdown}`);
  const next = tokens.nextTierRequirement;
  const nextTier = next?.tierName
    ? `Next ${tokenTier(next.tierName).color}${next.tierName}${colors.dim} ${tokenAmount(tokens.acceptedInWindow)}/${tokenAmount(next.requiredAccepted)} accepted${next.discounted ? " (discounted)" : ""}`
    : null;
  const lifetime = `lifetime accepted ${colors.green}${tokenAmount(tokens.lifetimeAccepted)}${colors.dim}`;
  lines.push(`${colors.dim} ${join([lifetime, nextTier])}${reset}`);
  return lines;
}

const TOKEN_REASON_LABELS: Record<string, string> = {
  initial_grant: "Initial grant",
  precheck_spent: "Ran checks",
  submission_approved: "Submission approved",
  drip_grant: "Hourly refill",
  admin_grant: "Admin grant",
  revert_compensation: "Revert compensation",
  stale_run_refund: "Rollout refund",
  agent_run_refund: "Agent run refunded",
};
const BOOST_CATEGORY_LABELS: Record<string, string> = {
  bugfix: "Bugfix",
  refactor: "Refactor",
  enhancement: "Enhancement",
  optimization: "Optimization",
};
const PAUSED_NOTE = "Quest paused — the window is frozen; nothing ages out until it resumes.";

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
    .join("");
}

function renderEloDetails(elo: OverviewSnapshot["elo"], now: number): string[] {
  if (!elo.available) return [elo.note];
  const toPrestige =
    elo.seatCutElo === null || elo.value === null ? null : Math.max(0, elo.seatCutElo - elo.value);
  const rotation = countdown(elo.nextRotationAt, now);
  const lines = [
    join([
      `Elo ${tokenAmount(elo.value)}`,
      elo.projectedValue !== null && `est. ${tokenAmount(elo.projectedValue)} at rotation`,
      rotation && `rotates in ${rotation}`,
    ]),
    join([
      `To Prestige ${toPrestige === null ? "—" : tokenAmount(toPrestige)}`,
      elo.seatCutElo !== null && `seat cut ${tokenAmount(elo.seatCutElo)}`,
      elo.windowDays !== null && `${tokenAmount(elo.windowDays)}d window`,
    ]),
  ];
  if (elo.questPaused) lines.push(PAUSED_NOTE);
  for (const boost of elo.boosts)
    lines.push(
      `${BOOST_CATEGORY_LABELS[boost.category] ?? boost.category} submissions from ${shortDate(boost.startsAt)} gives ${boost.multiplier}x elo score${boost.endsAt === null ? "" : ` · ends ${shortDate(boost.endsAt)}`}`,
    );
  return lines;
}
function chartLine(cells: Array<{ text: string; color: string }>, width: number): string {
  const text = cells.map((item) => item.text).join("");
  const visible = [...graphemes.segment(text)].reduce(
    (sum, part) => sum + cellWidth(part.segment),
    0,
  );
  return (
    cells.map((item) => item.color + item.text + reset).join("")
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
    let markerColor = colors.muted;
    if (mark.inWindow) markerColor = colors.amber;
    if (mark.countsAtRotation) markerColor = colors.green;
    markerCells[position] = { text: "◆", color: markerColor };
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
    { text: ` Token usage · ${hours}h bins · ${elo.windowDays}d window`, color: colors.white },
    chartRow("token usage", usageCells, colors.amber),
    chartRow("cumulative usage", trendCells, colors.white),
    chartRow("accepted markers", markerCells, colors.dim),
    { text: axis, color: colors.dim },
    {
      text: ` ${colors.green}${tokenAmount(elo.acceptedAtRotation)} count at rotation${colors.dim}${elo.agingOutByRotation ? ` · ${colors.amber}${tokenAmount(elo.agingOutByRotation)} aging out${colors.dim}` : ""}${reset}`,
      color: colors.dim,
    },
    ...(elo.agingOutByRotation
      ? [
          {
            text: ` ${elo.agingOutByRotation} accepted age${elo.agingOutByRotation === 1 ? "s" : ""} out of the window before the next rotation`,
            color: colors.amber,
          },
        ]
      : []),
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
    cells[position] = { text: "◆", color: counts ? laneColor(mark.lane) : colors.muted };
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
    .map(([lane, count]) => `${laneColor(lane)}■${colors.dim} ${count} ${lane}`)
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
    ...(timeline.paused ? [{ text: ` ${PAUSED_NOTE}`, color: colors.dim }] : []),
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
function laneColor(lane: string): string {
  if (lane === "mars") return colors.red;
  if (lane === "diamond") return colors.purple;
  return colors.bronze;
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

function homeSummary(snapshot: OverviewSnapshot, width: number, now: number, level: 0 | 1 | 2) {
  const lines: string[] = [];
  const wide = level === 2 && width >= 100;
  const chartWidth = Math.max(1, width - 1);
  const push = (line: string) => lines.push(fitAnsi(line, width));
  const add = (text: unknown, color = colors.white) => lines.push(cell(text, width, color));
  const section = (title: string, color = colors.accent) => {
    const label = ` ${title} `;
    add(`${label}${"─".repeat(Math.max(0, width - label.length))}`, color);
  };
  section("TOKENS", colors.amber);
  tokenLines(snapshot, now).forEach(push);
  const accepted = renderAcceptedTimeline(
    snapshot.acceptedTimeline,
    snapshot.tokens.acceptedInWindow,
    wide ? chartWidth : width,
  );
  if (accepted.length > 0 && level > 0) {
    if (wide) for (const row of accepted) push(` ${styleOverviewRow(row)}`);
    else {
      const timeline = snapshot.acceptedTimeline;
      const agedOut = timeline
        ? timeline.marks.filter((mark) => timeline.now - mark.at > timeline.windowDays * 86_400_000)
            .length
        : 0;
      push(
        `${colors.dim} Accepted · last ${snapshot.acceptedTimeline?.windowDays ?? "—"}d · ${colors.green}${tokenAmount(snapshot.tokens.acceptedInWindow)} accepted${colors.dim} · ${agedOut} aged out${reset}`,
      );
    }
  }

  const history = snapshot.tokens.history;
  if (history.length > 0 && level === 2) {
    section("TOKEN HISTORY", colors.amber);
    for (const entry of history.slice(0, 3)) {
      const amount = `${entry.amount > 0 ? "+" : ""}${tokenAmount(entry.amount)}`;
      const when = new Date(entry.at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      push(
        ` ${entry.amount > 0 ? colors.green : colors.red}${fit(amount, 7)}${colors.white}${fit(TOKEN_REASON_LABELS[entry.reason] ?? entry.reason, 22)}${colors.dim}${fit(when, 18)}bal: ${tokenAmount(entry.balance)}${reset}`,
      );
    }
  }

  section("PRESTIGE", colors.purple);
  if (snapshot.elo.available) {
    for (const [index, line] of renderEloDetails(snapshot.elo, now).entries()) {
      let color = index === 0 ? colors.white : colors.dim;
      if (line.includes("elo score")) color = colors.red;
      push(` ${color}${line}${reset}`);
    }
    const chart = renderPrestigeUsageChart(snapshot.elo, now, wide ? chartWidth : width);
    if (chart.length > 0 && level > 0) {
      if (wide) for (const row of chart) push(` ${styleOverviewRow(row)}`);
      else {
        const hours = Math.max(1, Math.round((snapshot.elo.usage.binMs ?? 21_600_000) / 3_600_000));
        const suffix = ` · ${hours}h bins`;
        const bins = snapshot.elo.usage.bins.slice(-Math.max(1, width - 16 - suffix.length));
        push(
          `${colors.dim} Token usage ${colors.amber}${timelineBars(bins, Math.max(0, ...bins), 1)}${colors.dim}${suffix}${reset}`,
        );
      }
    }
  } else push(`${colors.dim} ${snapshot.elo.note}${reset}`);

  const requests = snapshot.revisionRequests.items;
  if (requests.length > 0) {
    section(`CHANGES REQUESTED · ${requests.length} pending`, colors.amber);
    const shown = level === 0 ? 1 : 3;
    for (const request of requests.slice(0, shown)) {
      const title = fit(
        request.title,
        Math.min(request.title.length, Math.floor(width * 0.4)),
      ).trimEnd();
      const suffix = ` · ${join([request.reviewerName, relativeTime(request.reviewedAt, now)])}`;
      const room = width - title.length - suffix.length - 8;
      const feedback =
        request.feedback && room > 8
          ? ` — "${request.feedback.length > room ? `${fit(request.feedback, room - 1).trimEnd()}…` : request.feedback}"`
          : "";
      add(` • ${title}${feedback}${suffix}`);
    }
    if (requests.length > shown) add(`   +${requests.length - shown} more`, colors.dim);
  }

  return lines;
}

const SHORT_TAB_LABELS: Record<string, string> = {
  pending_review: "Pending",
  revision_requested: "Revision",
  finalizing_review: "Final",
};

function renderOverviewBody(
  state: ViewState,
  width: number,
  height: number,
  now: number,
): string[] {
  const lines: string[] = [];
  const add = (text: unknown, color = colors.white) => lines.push(cell(text, width, color));
  const section = (title: string, color = colors.accent) => {
    const label = ` ${title} `;
    add(`${label}${"─".repeat(Math.max(0, width - label.length))}`, color);
  };
  const snapshot = state.overview;
  if (!snapshot) {
    add(` ${state.busy ? `${spinner(now)} ` : ""}Loading your challenges...`);
    if (state.error) add(` ! ${state.error}`, colors.red);
    add(" q quit", colors.dim);
    return lines;
  }
  const connection = state.connected === false ? "reconnecting…" : "live";
  add(` HOME · updated ${relativeTime(snapshot.fetchedAt, now)} · ${connection}`, colors.dim);

  const listReserve = 10;
  let summary = homeSummary(snapshot, width, now, 0);
  for (const level of [2, 1] as const) {
    const candidate = homeSummary(snapshot, width, now, level);
    if (lines.length + candidate.length + listReserve <= height) {
      summary = candidate;
      break;
    }
  }
  lines.push(...summary);

  const tab = state.overviewTab ?? "all";
  const all = snapshot.challenges;
  section(
    `MY CHALLENGES · ${all.length} total${snapshot.archivedHidden ? ` · ${snapshot.archivedHidden} archived hidden` : ""}`,
  );
  const tabs = OVERVIEW_TABS.map((item) => ({
    id: item.id,
    label: item.label,
    count: all.filter((challenge) => inOverviewTab(item.id, challenge.status)).length,
  }));
  const fullTabs = tabs.map((item) => `${item.label} ${item.count}`).join("  ").length + 3;
  lines.push(
    fitAnsi(
      ` ${tabs
        .map((item) => {
          const label = fullTabs > width ? (SHORT_TAB_LABELS[item.id] ?? item.label) : item.label;
          const text = `${label} ${item.count}`;
          return item.id === tab
            ? `${colors.accent}[${text}]${reset}`
            : `${colors.dim}${text}${reset}`;
        })
        .join(fullTabs > width ? " " : "  ")}`,
      width,
    ),
  );
  if (state.error) add(` ! ${state.error}`, colors.red);
  const challenges = visibleChallenges(snapshot, tab);
  if (challenges.length === 0) {
    add(all.length === 0 ? " No challenges yet." : " No matching challenges.", colors.dim);
    add(" ←→ status  r reload  q quit", colors.accent);
    return lines;
  }
  const statusWidth = 18,
    createdWidth = 7,
    difficultyWidth = 10,
    languageWidth = width >= 90 ? 12 : 0;
  const columnGap = languageWidth ? 1 : 0;
  const titleWidth = Math.max(
    12,
    width - statusWidth - createdWidth - languageWidth - columnGap - difficultyWidth - 7,
  );
  const languageColumn = (text: string) => (languageWidth ? `${fit(text, languageWidth)} ` : "");
  add(
    `   ${fit("Title", titleWidth)} ${languageColumn("Language")}${fit("Difficulty", difficultyWidth)} ${fit("Status", statusWidth)} Created`,
    colors.dim,
  );
  const selectedIndex = Math.max(0, Math.min(state.overviewSelected, challenges.length - 1));
  const room = Math.max(1, height - lines.length - 3);
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(room / 2), challenges.length - room),
  );
  for (const [offset, challenge] of challenges.slice(start, start + room).entries()) {
    const selected = start + offset === selectedIndex;
    const status = statusStyle(challenge.status);
    lines.push(
      `${selected ? colors.accent : colors.white} ${selected ? "▸" : " "} ${fit(challenge.title, titleWidth)} ${languageColumn(challenge.language ?? "—")}${fit(challenge.difficulty ?? "—", difficultyWidth)}${reset} ${cell(status.label, statusWidth, status.color)} ${cell(shortDate(challenge.createdAt), createdWidth, colors.dim)}`,
    );
  }
  const below = challenges.length - start - room;
  add(
    ` ${join([start > 0 && `↑ ${start} more`, below > 0 && `↓ ${below} more`]) || " "}`,
    colors.dim,
  );
  add(" ↑↓ select  ←→ status  Enter open  r reload  q quit", colors.accent);
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
  let autoScrolling = false;
  const put = (text: unknown, color = colors.white) => lines.push(cell(text, width, color));
  const snapshot = state.snapshot;
  if (height >= 3) put(" OLYMPUS", colors.accent);
  if (state.mode === "overview") {
    lines.push(...renderOverviewBody(state, width, height, now));
  } else if (snapshot) {
    if (height >= 18) put(` ${snapshot.title}`, colors.white);
    if (height >= 16) {
      const status = statusStyle(snapshot.status);
      const statusWidth = Math.min(width, status.label.length + 2);
      const connection = state.connected === false ? "reconnecting…" : "live";
      lines.push(
        cell(` ${status.label} `, statusWidth, status.color)
          + cell(
            `   v${snapshot.version ?? "—"}${snapshot.submissionType ? `  ·  ${snapshot.submissionType.toUpperCase()}` : ""}  ·  read only  ·  ${connection}  ·  updated ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`,
            width - statusWidth,
            colors.dim,
          ),
      );
    }
    const delivery = deliveryFailure(snapshot);
    if (delivery) put(` ✗ Delivery verification failed: ${delivery}`, colors.red);
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
    const stages = data.checks.filter(
      (item) => item.key.startsWith("stage:") && item.key !== "stage:summary",
    );
    const stagesPassing = stages.filter((item) => /pass|warn/i.test(item.status)).length;
    const cards = [
      tokens,
      stages.length > 0 ? `PRECHECKS ${stagesPassing}/${stages.length}` : "PRECHECKS —",
      `RUNS ${passing.length}/${current.length} PASS${running.length > 0 ? ` · ${running.length} RUN` : ""}`,
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
    const denseColumnWidth = width < 60 ? 24 : 25;
    const columnWidth = dense ? denseColumnWidth : 28;
    const cols = Math.max(1, Math.floor((width + 2) / columnWidth));
    const showBudget = height >= 18 && budget?.data?.enabled === true;
    const showReady = height >= 18 && readinessKnown?.canSubmit === true;
    const footerSize = (height >= 5 ? 1 : 0) + Number(showBudget) + Number(showReady);
    const sections = dashboardSections(data, Boolean(state.history), state.section === 2);
    const bodyStart = lines.length;
    let focusStart = bodyStart,
      focusEnd = bodyStart;
    for (const group of sections) {
      let original = data.readiness;
      if (group.section === 0) original = data.checks;
      else if (group.section === 1) original = displayRuns;
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
    let footerHint =
      " q exit  r refresh  Tab section  arrows select  Enter details  b overview  h history  PgUp/PgDn page";
    if (state.details) footerHint = " PgUp/PgDn details · Enter close · q exit";
    else if (width < 95) footerHint = " Tab/↑↓ select · Enter info · q exit";
    if (height >= 5) footer.push(cell(footerHint, width, colors.accent));
    const body = lines.splice(bodyStart);
    const room = Math.max(1, height - bodyStart - footer.length - details.length);
    let top = Math.max(0, Math.min(state.viewportTop ?? 0, body.length - room));
    const start = focusStart - bodyStart,
      end = focusEnd - bodyStart;
    if (end > top + room) top = end - room;
    if (start < top && end - start <= room) top = start;
    if (end - tileHeight < top) top = Math.max(0, end - tileHeight);
    top = Math.max(0, Math.min(top, body.length - room));
    if (
      (width < 80 || height < 24)
      && body.length > room
      && !state.details
      && now >= (state.autoPausedUntil ?? 0)
    ) {
      state.autoPageStartedAt ??= now;
      const page =
        Math.floor(Math.max(0, now - state.autoPageStartedAt) / 6000)
        % Math.ceil(body.length / room);
      top = Math.min(body.length - room, page * room);
      autoScrolling = true;
    }
    state.viewportTop = top;
    if (body.length > room && bodyStart > 0)
      lines[0] = cell(
        ` OLYMPUS · ${autoScrolling ? "auto" : "view"} ${top + 1}–${Math.min(top + room, body.length)}/${body.length} ${top ? "↑" : ""}${top + room < body.length ? "↓" : ""}`,
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
  if (info) info.animating = autoScrolling || visibleLines.some((line) => animatedLines.has(line));
  return `\x1b[H${visibleLines.map((line) => `${line + reset}\x1b[K`).join("\r\n")}\x1b[J`;
}
