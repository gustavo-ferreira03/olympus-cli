import { createLogUpdate } from "log-update";
import { emitKeypressEvents } from "node:readline";
import { renderDashboard } from "./ui.ts";
import {
  clean,
  dashboardRows,
  observedChanges,
  type OverviewSnapshot,
  type Snapshot,
} from "./data.ts";

export type DashboardLoaders = {
  loadOverview: (
    previous: OverviewSnapshot | undefined,
    signal: AbortSignal,
  ) => Promise<OverviewSnapshot>;
  loadChallenge: (
    id: string,
    previous: Snapshot | undefined,
    signal: AbortSignal,
  ) => Promise<Snapshot>;
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
  polls: number;
  nextAt: number;
  section: number;
  selected: number[];
  details: boolean;
  detailOffset?: number;
  detailPageSize?: number;
  viewportTop?: number;
  history?: boolean;
  events: string[];
};

export async function runDashboard(loaders: DashboardLoaders, intervalMs: number): Promise<void> {
  const state: ViewState = {
    mode: loaders.initialId ? "challenge" : "overview",
    overviewSelected: 0,
    selectedChallengeId: loaders.initialId,
    busy: false,
    polls: 0,
    nextAt: Date.now(),
    section: 0,
    selected: [0, 0, 0],
    details: false,
    events: [],
  };
  let stopped = false,
    failures = 0,
    pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let animationTimer: ReturnType<typeof setTimeout> | undefined;
  let paintRequest: ReturnType<typeof setImmediate> | undefined;
  let active: AbortController | undefined;
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
    clearTimeout(timer);
    clearTimeout(animationTimer);
    clearImmediate(paintRequest);
    active?.abort();
    finish();
  };
  const refresh = async () => {
    if (stopped) return;
    if (state.busy) {
      pending = true;
      return;
    }
    clearTimeout(timer);
    state.busy = true;
    state.polls++;
    active = new AbortController();
    const timeout = setTimeout(() => active?.abort(), 15000);
    paint();
    try {
      const snapshot =
        state.mode === "overview"
          ? await loaders.loadOverview(state.overview, active.signal)
          : await loaders.loadChallenge(state.selectedChallengeId!, state.snapshot, active.signal);
      if (stopped) return;
      if (state.mode === "overview") {
        state.overview = snapshot as OverviewSnapshot;
        state.overviewSelected = Math.max(
          0,
          Math.min(state.overviewSelected, state.overview.challenges.length - 1),
        );
      } else {
        const challengeSnapshot = snapshot as Snapshot;
        for (const event of observedChanges(state.snapshot, challengeSnapshot))
          state.events.push(`${new Date().toLocaleTimeString()} ${event}`);
        state.events = state.events.slice(-100);
        state.snapshot = challengeSnapshot;
        state.error = undefined;
        const partial = Object.values(challengeSnapshot.sources).some((source) => source.error);
        failures = partial ? failures + 1 : 0;
      }
      state.error = undefined;
      if (state.mode === "overview") failures = 0;
    } catch (error) {
      if (!stopped) {
        state.error = clean(error instanceof Error ? error.message : error);
        failures++;
      }
    } finally {
      clearTimeout(timeout);
      state.busy = false;
      if (!stopped) {
        const delay = pending
          ? 0
          : Math.min(intervalMs * 2 ** Math.min(failures, 5), Math.max(intervalMs, 60000));
        pending = false;
        state.nextAt = Date.now() + delay;
        timer = setTimeout(() => void refresh(), delay);
        paint();
      }
    }
  };
  const switchToChallenge = () => {
    const selected = state.overview?.challenges[state.overviewSelected];
    if (!selected) return;
    state.mode = "challenge";
    state.selectedChallengeId = selected.id;
    state.snapshot = undefined;
    state.rowCache = undefined;
    state.error = undefined;
    state.details = false;
    state.detailOffset = 0;
    active?.abort();
    pending = true;
    void refresh();
    paint();
  };
  const switchToOverview = () => {
    if (!state.overview) return;
    state.mode = "overview";
    state.snapshot = undefined;
    state.rowCache = undefined;
    state.error = undefined;
    state.details = false;
    state.detailOffset = 0;
    active?.abort();
    pending = true;
    void refresh();
    paint();
  };
  const keypress = (_: string, key: { name?: string; ctrl?: boolean }) => {
    if (key?.name === "q" || (key?.ctrl && key.name === "c")) return stop();
    if (key?.name === "r") {
      void refresh();
      return;
    }
    if (state.mode === "overview") {
      const size = state.overview?.challenges.length ?? 0;
      const delta =
        key?.name === "down"
          ? 1
          : key?.name === "up"
            ? -1
            : key?.name === "pagedown"
              ? 10
              : key?.name === "pageup"
                ? -10
                : 0;
      if (delta !== 0 && size > 0)
        state.overviewSelected = Math.max(0, Math.min(size - 1, state.overviewSelected + delta));
      if (key?.name === "return") switchToChallenge();
      paint();
      return;
    }
    if ((key?.name === "b" || key?.name === "escape") && state.overview) {
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
    if (["tab", "return", "h", "up", "down", "pageup", "pagedown"].includes(key?.name ?? ""))
      state.detailOffset = 0;
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
      const delta =
        key?.name === "down"
          ? 1
          : key?.name === "up"
            ? -1
            : key?.name === "pagedown"
              ? 10
              : key?.name === "pageup"
                ? -10
                : 0;
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
    void refresh();
    await done;
  } finally {
    stop();
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
