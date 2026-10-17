import { createLogUpdate } from "log-update";
import { emitKeypressEvents } from "node:readline";
import { renderDashboard } from "./ui.ts";
import { dashboardRows, observedChanges, type OverviewSnapshot, type Snapshot } from "./data.ts";

/** Live data behind the dashboard; see LiveDashboard. */
export type DashboardFeed = {
  showOverview(): void;
  showChallenge(id: string): void;
  overview(): OverviewSnapshot | undefined;
  snapshot(): Snapshot | undefined;
  error(): string | undefined;
  connected(): boolean;
  /** Re-read local state that has no subscription (the token budget file). */
  tick(): Promise<void>;
  resubscribe(): void;
  /** Register the callback invoked whenever subscribed data changes. */
  onChange(listener: () => void): void;
  close(): Promise<void>;
  initialId?: string;
};

export type ViewState = {
  mode: "overview" | "challenge";
  overview?: OverviewSnapshot;
  overviewSelected: number;
  selectedChallengeId?: string;
  snapshot?: Snapshot;
  rowCache?: { snapshot: Snapshot; rows: ReturnType<typeof dashboardRows> };
  error?: string;
  busy: boolean;
  /** False while the live connection is down; data shown is the last received. */
  connected?: boolean;
  polls: number;
  nextAt: number;
  section: number;
  selected: number[];
  details: boolean;
  autoPageStartedAt?: number;
  autoPausedUntil?: number;
  detailOffset?: number;
  detailPageSize?: number;
  viewportTop?: number;
  history?: boolean;
  events: string[];
};

function keyDelta(name: string | undefined): number {
  if (name === "down") return 1;
  if (name === "up") return -1;
  if (name === "pagedown") return 10;
  if (name === "pageup") return -10;
  return 0;
}

export async function runDashboard(feed: DashboardFeed, intervalMs: number): Promise<void> {
  const state: ViewState = {
    mode: feed.initialId ? "challenge" : "overview",
    overviewSelected: 0,
    selectedChallengeId: feed.initialId,
    busy: true,
    polls: 0,
    nextAt: Date.now(),
    section: 0,
    selected: [0, 0, 0],
    details: false,
    events: [],
  };
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let animationTimer: ReturnType<typeof setTimeout> | undefined;
  let paintRequest: ReturnType<typeof setImmediate> | undefined;
  let syncRequest: ReturnType<typeof setImmediate> | undefined;
  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing === true;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const update = createLogUpdate(process.stdout, { showCursor: true });
  let lastFrame: string | undefined;
  let lastColumns = 0,
    lastRows = 0;
  const flushPaint = () => {
    paintRequest = undefined;
    clearTimeout(animationTimer);
    animationTimer = undefined;
    if (stopped) return;
    const columns = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const info = { animating: false };
    const frame = renderDashboard(state, columns, rows, Date.now(), info)
      // eslint-disable-next-line no-control-regex -- Strip terminal escapes for width measurement.
      .replaceAll(/\x1b\[(?:H|K|J)/g, "")
      .replaceAll("\r\n", "\n");
    if (frame !== lastFrame || columns !== lastColumns || rows !== lastRows) {
      update(frame);
      lastFrame = frame;
      lastColumns = columns;
      lastRows = rows;
    }
    if (info.animating) animationTimer = setTimeout(paint, 300);
  };
  const paint = () => {
    if (!stopped && !paintRequest) paintRequest = setImmediate(flushPaint);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(animationTimer);
    clearImmediate(paintRequest);
    clearImmediate(syncRequest);
    finish();
  };
  /** Pull the feed's current data into the view state; data arrives by subscription. */
  const sync = () => {
    syncRequest = undefined;
    if (stopped) return;
    state.connected = feed.connected();
    state.error = feed.error();
    if (state.mode === "overview") {
      const overview = feed.overview();
      if (overview) {
        state.overview = overview;
        state.overviewSelected = Math.max(
          0,
          Math.min(state.overviewSelected, overview.challenges.length - 1),
        );
      }
      state.busy = !state.overview;
    } else {
      const next = feed.snapshot();
      if (next && next !== state.snapshot) {
        const rows = dashboardRows(next);
        const before =
          state.rowCache?.snapshot === state.snapshot ? state.rowCache?.rows : undefined;
        for (const event of observedChanges(state.snapshot, next, { before, after: rows }))
          state.events.push(`${new Date().toLocaleTimeString()} ${event}`);
        if (state.events.length > 100) state.events.splice(0, state.events.length - 100);
        state.snapshot = next;
        state.rowCache = { snapshot: next, rows };
      }
      state.busy = !state.snapshot;
    }
    paint();
  };
  // Subscription updates arrive in bursts; one sync per turn of the event loop is enough.
  const scheduleSync = () => {
    if (!stopped && !syncRequest) syncRequest = setImmediate(sync);
  };
  const resetChallengeView = () => {
    state.snapshot = undefined;
    state.rowCache = undefined;
    state.error = undefined;
    state.details = false;
    state.autoPageStartedAt = undefined;
    state.autoPausedUntil = undefined;
    state.detailOffset = 0;
  };
  const switchToChallenge = () => {
    const selected = state.overview?.challenges[state.overviewSelected];
    if (!selected) return;
    state.mode = "challenge";
    state.selectedChallengeId = selected.id;
    state.events = [];
    resetChallengeView();
    feed.showChallenge(selected.id);
    sync();
  };
  const switchToOverview = () => {
    state.mode = "overview";
    resetChallengeView();
    feed.showOverview();
    sync();
  };
  const keypress = (_: string, key: { name?: string; ctrl?: boolean }) => {
    if (key?.name === "q" || (key?.ctrl && key.name === "c")) return stop();
    if (key?.name === "r") {
      feed.resubscribe();
      if (state.mode === "challenge") resetChallengeView();
      sync();
      return;
    }
    if (state.mode === "overview") {
      const size = state.overview?.challenges.length ?? 0;
      const delta = keyDelta(key?.name);
      if (delta !== 0 && size > 0)
        state.overviewSelected = Math.max(0, Math.min(size - 1, state.overviewSelected + delta));
      if (key?.name === "return") switchToChallenge();
      paint();
      return;
    }
    if (key?.name === "escape" && state.details) {
      state.details = false;
      state.detailOffset = 0;
      paint();
      return;
    }
    if (key?.name === "b" || key?.name === "escape") {
      switchToOverview();
      return;
    }
    if (state.details && ["pageup", "pagedown"].includes(key?.name ?? "")) {
      state.detailOffset = Math.max(
        0,
        (state.detailOffset ?? 0) + (key.name === "pageup" ? -1 : 1) * (state.detailPageSize ?? 1),
      );
      paint();
      return;
    }
    if (["tab", "return", "h", "up", "down", "pageup", "pagedown"].includes(key?.name ?? "")) {
      state.detailOffset = 0;
      state.autoPausedUntil = Date.now() + 15000;
      state.autoPageStartedAt = undefined;
    }
    if (key?.name === "tab") state.section = (state.section + 1) % 3;
    if (key?.name === "return") state.details = !state.details;
    if (key?.name === "h") {
      state.history = !state.history;
      state.selected[1] = 0;
    }
    if (state.snapshot) {
      const rows =
        state.rowCache?.snapshot === state.snapshot
          ? state.rowCache.rows
          : dashboardRows(state.snapshot);
      const size = [
        rows.checks,
        state.history ? rows.runs : rows.runs.filter((item) => item.freshness === "current"),
        rows.readiness,
      ][state.section].length;
      const delta = keyDelta(key?.name);
      state.selected[state.section] = Math.max(
        0,
        Math.min(size - 1, state.selected[state.section] + delta),
      );
    }
    paint();
  };
  try {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", keypress);
    process.stdout.on("resize", paint);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    feed.onChange(scheduleSync);
    if (state.mode === "challenge") feed.showChallenge(state.selectedChallengeId!);
    else feed.showOverview();
    // No network polling: the interval only re-reads local state and refreshes relative times.
    timer = setInterval(() => {
      state.polls++;
      state.nextAt = Date.now() + intervalMs;
      void (async () => {
        try {
          await feed.tick();
        } finally {
          scheduleSync();
        }
      })();
    }, intervalMs);
    sync();
    await done;
  } finally {
    stop();
    await feed.close().catch(() => {});
    update.done();
    process.stdin.off("keypress", keypress);
    process.stdout.off("resize", paint);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
    process.stdin.setRawMode(Boolean(wasRaw));
    if (!wasFlowing) process.stdin.pause();
    process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  }
}
