import { defineCommand } from "citty";
import { getClient, installPolicyGuards } from "../convex.ts";
import { ConvexHttpClient } from "convex/browser";
import { requireAuth } from "../auth.ts";
import { printJson } from "../format.ts";
import { CliError } from "../errors.ts";
import { readDashboard, type Snapshot } from "../dashboard.ts";
import { runDashboard } from "../dashboard-tui.ts";

export default defineCommand({
  meta: {
    name: "dashboard",
    description: "Live read-only challenge dashboard with continuous polling",
  },
  args: {
    id: {
      type: "positional",
      description: "Challenge ID; follows the latest version",
      required: true,
    },
    interval: {
      type: "string",
      description: "Polling interval in seconds (1-300)",
      default: "5",
    },
    json: {
      type: "boolean",
      description:
        "Return one read-only snapshot instead of opening the live terminal dashboard",
    },
  },
  run: async ({ args }) => {
    const interval = Number(args.interval);
    if (!Number.isFinite(interval) || interval < 1 || interval > 300)
      throw new CliError("--interval must be between 1 and 300 seconds", {
        kind: "usage",
        code: "dashboard.invalid_interval",
        retryable: false,
        hint: "Use --interval 5.",
      });
    if (!args.json && (!process.stdin.isTTY || !process.stdout.isTTY))
      throw new CliError("Dashboard requires an interactive terminal", {
        kind: "usage",
        code: "dashboard.tty_required",
        retryable: false,
        hint: "Run in a terminal, or use --json for one snapshot.",
      });
    const base = await getClient();
    const { token, identity } = requireAuth();
    let requestSignal: AbortSignal;
    const client = new ConvexHttpClient(base.url, {
      auth: token,
      logger: false,
      fetch: (input, init) => fetch(input, { ...init, signal: requestSignal }),
    });
    installPolicyGuards(client, base.url, identity.sub);
    const load = async (
      previous: Snapshot | undefined,
      signal: AbortSignal,
    ) => {
      requestSignal = signal;
      return readDashboard(client, args.id, previous);
    };
    if (args.json) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const snapshot = await load(undefined, controller.signal);
        printJson(snapshot);
        if (Object.values(snapshot.sources).some((source) => source.error))
          process.exitCode = 1;
      } finally {
        clearTimeout(timeout);
      }
      return;
    }
    await runDashboard(load, interval * 1000);
  },
});
