import { defineCommand } from "citty";
import { api, getClient, installPolicyGuards, localBudgetStatus } from "../platform/convex.ts";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { requireAuth } from "../platform/auth.ts";
import { printJson } from "../terminal/format.ts";
import { CliError } from "../shared/errors.ts";
import {
  readDashboard,
  readDashboardOverview,
  type DashboardOverviewFilters,
} from "../dashboard/data.ts";
import { LiveDashboard } from "../dashboard/live.ts";
import { runDashboard } from "../dashboard/tui.ts";

export default defineCommand({
  meta: {
    name: "dashboard",
    description: "Live read-only challenge dashboard with continuous polling",
  },
  args: {
    id: {
      type: "positional",
      description: "Optional challenge ID; omit to choose from the general dashboard",
      required: false,
    },
    interval: {
      type: "string",
      description: "Local refresh interval in seconds (1-300); remote data streams live",
      default: "5",
    },
    json: {
      type: "boolean",
      description: "Return one read-only snapshot instead of opening the live terminal dashboard",
    },
    status: {
      type: "string",
      description: "Overview filter: status value, or all",
    },
    language: {
      type: "string",
      description: "Overview filter: language value, or all",
    },
    difficulty: {
      type: "string",
      description: "Overview filter: difficulty value, or all",
    },
    category: {
      type: "string",
      description: "Overview filter: category value, or all",
    },
    "include-archived": {
      type: "boolean",
      description: "Include archived challenges (hidden by default)",
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
    const overviewFilters: DashboardOverviewFilters = {
      includeArchived: args["include-archived"],
      status: args.status,
      language: args.language,
      difficulty: args.difficulty,
      category: args.category,
    };
    const hasOverviewFilter =
      args["include-archived"] === true
      || [args.status, args.language, args.difficulty, args.category].some(
        (value) => value !== undefined,
      );
    if (args.id && hasOverviewFilter)
      throw new CliError("Overview filters require dashboard without a challenge ID", {
        kind: "usage",
        code: "dashboard.filters_with_id",
        retryable: false,
        hint: "Run olympus dashboard --status <status> to filter the overview.",
      });
    const base = await getClient();
    const { token, identity } = requireAuth();
    let requestSignal: AbortSignal | undefined;
    const client = new ConvexHttpClient(base.url, {
      auth: token,
      logger: false,
      fetch: (input, init) => fetch(input, { ...init, signal: requestSignal }),
    });
    installPolicyGuards(client, base.url, identity.sub);
    if (args.json) {
      const controller = new AbortController();
      requestSignal = controller.signal;
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        if (args.id) {
          const snapshot = await readDashboard(client, args.id);
          printJson(snapshot);
          if (Object.values(snapshot.sources).some((source) => source.error)) process.exitCode = 1;
        } else {
          printJson(await readDashboardOverview(client, overviewFilters));
        }
      } finally {
        clearTimeout(timeout);
      }
      return;
    }
    const subscriptions = new ConvexClient(base.url, { logger: false });
    subscriptions.setAuth(async () => token);
    let listener = () => {};
    const live = new LiveDashboard(
      subscriptions,
      {
        refreshBalance: async () => {
          await client.mutation(api.contributorTokens.refreshBalance, {});
        },
        readBudget: (id) => localBudgetStatus(client, id),
      },
      () => listener(),
    );
    await runDashboard(
      {
        initialId: args.id,
        showOverview: () => live.showOverview(),
        showChallenge: (id) => live.showChallenge(id),
        overview: () => live.overview(overviewFilters),
        snapshot: () => live.snapshot(),
        error: () => live.error(),
        connected: () => live.connected(),
        tick: () => live.tick(),
        resubscribe: () => live.resubscribe(),
        onChange: (next) => {
          listener = next;
        },
        close: () => live.close(),
      },
      interval * 1000,
    );
  },
});
