import { emitKeypressEvents } from "node:readline";
import { renderDashboard } from "./dashboard-ui.ts";
import {
  clean,
  dashboardRows,
  observedChanges,
  type Snapshot,
  type Row,
} from "./dashboard.ts";

export type ViewState = {
  snapshot?: Snapshot;
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
export { fit, renderDashboard } from "./dashboard-ui.ts";

export async function runDashboard(
  load: (
    previous: Snapshot | undefined,
    signal: AbortSignal,
  ) => Promise<Snapshot>,
  intervalMs: number,
): Promise<void> {
  const state: ViewState = {
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
  let redraw: ReturnType<typeof setInterval> | undefined;
  let active: AbortController | undefined;
  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing === true;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const paint = () => {
    if (!stopped)
      process.stdout.write(
        renderDashboard(
          state,
          process.stdout.columns || 80,
          process.stdout.rows || 24,
        ),
      );
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearInterval(redraw);
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
      const snapshot = await load(state.snapshot, active.signal);
      if (stopped) return;
      for (const event of observedChanges(state.snapshot, snapshot))
        state.events.push(`${new Date().toLocaleTimeString()} ${event}`);
      state.events = state.events.slice(-100);
      state.snapshot = snapshot;
      state.error = undefined;
      const partial = Object.values(snapshot.sources).some(
        (source) => source.error,
      );
      failures = partial ? failures + 1 : 0;
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
          : Math.min(
              intervalMs * 2 ** Math.min(failures, 5),
              Math.max(intervalMs, 60000),
            );
        pending = false;
        state.nextAt = Date.now() + delay;
        timer = setTimeout(() => void refresh(), delay);
        paint();
      }
    }
  };
  const keypress = (_: string, key: { name?: string; ctrl?: boolean }) => {
    if (key?.name === "q" || (key?.ctrl && key.name === "c")) return stop();
    if (key?.name === "r") {
      void refresh();
      return;
    }
    if (state.details && ["pageup", "pagedown"].includes(key?.name ?? "")) {
      state.detailOffset = Math.max(
        0,
        (state.detailOffset ?? 0) +
          (key.name === "pageup" ? -1 : 1) * (state.detailPageSize ?? 1),
      );
      paint();
      return;
    }
    if (
      ["tab", "return", "h", "up", "down", "pageup", "pagedown"].includes(
        key?.name ?? "",
      )
    )
      state.detailOffset = 0;
    if (key?.name === "tab") state.section = (state.section + 1) % 3;
    if (key?.name === "return") state.details = !state.details;
    if (key?.name === "h") {
      state.history = !state.history;
      state.selected[1] = 0;
    }
    if (state.snapshot) {
      const rows = dashboardRows(state.snapshot);
      const size = [
        rows.checks,
        state.history
          ? rows.runs
          : rows.runs.filter((item) => item.freshness === "current"),
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
    redraw = setInterval(paint, 1000);
    void refresh();
    await done;
  } finally {
    stop();
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
