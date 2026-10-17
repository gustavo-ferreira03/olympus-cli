import { defineCommand } from "citty";
import { printJson } from "../terminal/format.ts";
import { api, getClient } from "../platform/convex.ts";

const iso = (ms: number | null | undefined) =>
  typeof ms === "number" ? new Date(ms).toISOString() : null;

const EXACT_FIELDS = ["currentElo", "seatCutElo", "acceptedNow", "isMember"] as const;

async function readOutlook(client: any, exact: boolean) {
  const outlook: any = await client.query(api.tierRotation.getMyPrestigeOutlook, {});
  if (!exact) return { outlook, exact: null };
  try {
    const precise: any = await client.action(api.tierRotation.getMyPrestigeOutlookExact, {});
    const merged = { ...outlook };
    for (const field of EXACT_FIELDS)
      if (precise?.[field] !== undefined) merged[field] = precise[field];
    return { outlook: merged, exact: { source: "getMyPrestigeOutlookExact" } };
  } catch (error) {
    return {
      outlook,
      exact: {
        source: "getMyPrestigeOutlook",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

const activeBoost = (b: any, now: number) =>
  b.startsAt <= now && (b.endsAt == null || b.endsAt > now);

const outlook = defineCommand({
  meta: {
    name: "prestige outlook",
    description: "Show your prestige ELO, seat cut and rotation outlook",
  },
  args: {
    exact: { type: "boolean", description: "Use the precise ELO computation (slower)" },
    json: { type: "boolean", description: "Output compact JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const { outlook: data, exact } = await readOutlook(client, Boolean(args.exact));
    const result = exact ? { ...data, exactSource: exact } : data;
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

const leaderboard = defineCommand({
  meta: { name: "prestige leaderboard", description: "Show the prestige leaderboard" },
  args: {
    json: { type: "boolean", description: "Output compact JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const board: any = await client.query(api.tierRotation.getPrestigeLeaderboard, {});
    const now = Date.now();
    const result = {
      topN: board?.topN ?? null,
      windowDays: board?.windowDays ?? null,
      updatedAt: iso(board?.updatedAt),
      nextRotationAt: iso(board?.nextRotationAt),
      entries: (Array.isArray(board?.entries) ? board.entries : []).map((entry: any) => ({
        rank: entry.rank,
        username: entry.username ?? entry.discordUsername ?? null,
        elo: entry.elo,
        seated: Boolean(entry.seated),
      })),
      unrankedMembers: board?.unrankedMembers ?? null,
      activeBoosts: (Array.isArray(board?.boosts) ? board.boosts : [])
        .filter((b: any) => activeBoost(b, now))
        .map((b: any) => ({
          category: b.category,
          multiplier: b.multiplier,
          title: b.title ?? null,
          endsAt: iso(b.endsAt),
        })),
    };
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

const boosts = defineCommand({
  meta: {
    name: "prestige boosts",
    description: "Show the category ELO boosts active now (and upcoming ones)",
  },
  args: {
    json: { type: "boolean", description: "Output compact JSON" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const outlook: any = await client.query(api.tierRotation.getMyPrestigeOutlook, {});
    const now = typeof outlook?.now === "number" ? outlook.now : Date.now();
    const all: any[] = Array.isArray(outlook?.boosts) ? outlook.boosts : [];
    const shape = (b: any) => ({
      category: b.category,
      multiplier: b.multiplier,
      title: b.title ?? null,
      startsAt: iso(b.startsAt),
      endsAt: iso(b.endsAt),
    });
    const result = {
      now: iso(now),
      active: all.filter((b) => activeBoost(b, now)).map(shape),
      upcoming: all.filter((b) => b.startsAt > now).map(shape),
    };
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

export default defineCommand({
  meta: {
    name: "prestige",
    description: "View prestige information: ELO outlook, leaderboard and category boosts",
  },
  subCommands: { outlook, leaderboard, boosts },
});
