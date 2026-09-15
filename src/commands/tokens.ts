import { defineCommand } from "citty";
import { api, getClient, localBudgetStatus } from "../platform/convex.ts";
import { printJson } from "../terminal/format.ts";
import { omitEmpty } from "../terminal/output.ts";
import { resolveCommandContext } from "./command-utils.ts";
import { resolveCostCatalog } from "../core/pricing.ts";
import { toPublicCheckKey } from "../core/expected.ts";
import { sumBudgetAmounts } from "../core/budget.ts";
import { summarizeTokenUsage } from "../core/token-telemetry.ts";

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

function compactBalance(balance: any, revisionTokens: any[]) {
  const totalRevision = revisionTokens.reduce((sum, item) => sum + (number(item?.balance) ?? 0), 0);
  return omitEmpty({
    balance: balance?.balance,
    cap: balance?.cap,
    tierName: balance?.tierName,
    tierOrder: balance?.tierOrder,
    tierColor: balance?.tierColor,
    tierWindowDays: balance?.tierWindowDays,
    tierDripAmount: balance?.tierDripAmount,
    tierAcceptanceBonusUsd: balance?.tierAcceptanceBonusUsd,
    tierFeatures: balance?.tierFeatures,
    nextTierRequirement: balance?.nextTierRequirement,
    acceptedInWindow: balance?.acceptedInWindow,
    olympusAcceptedInWindow: balance?.olympusAcceptedInWindow,
    lifetimeAccepted: balance?.lifetimeAccepted,
    pendingDrip: balance?.pendingDrip,
    dripPaused: balance?.dripPaused,
    dripUnlimited: balance?.dripUnlimited,
    nextDripAt: balance?.nextDripAt,
    revisionTokenBalance: balance?.revisionTokenBalance ?? totalRevision,
    generalTokenBalance: balance?.generalTokenBalance,
    totalRevisionTokenBalance: totalRevision || undefined,
    tokenCap: balance?.tokenCap,
  });
}

function transactionDate(item: any): number | undefined {
  return number(item?.createdAt ?? item?.timestamp ?? item?._creationTime);
}

function transactionAmount(item: any): number {
  const value = number(item?.amount);
  if (value === undefined)
    throw new Error("Backend transaction amount is missing or invalid; usage cannot be summarized");
  return value;
}

function transactionChallengeId(item: any): string | undefined {
  return item?.challengeId ?? item?.problemId ?? item?.itemId;
}

function summarizeTransactions(transactions: any[], full = false) {
  if (!Array.isArray(transactions))
    throw new Error("Backend transactions response is not an array; usage is unavailable");
  const byReason = new Map<string, { count: number; spent: number; granted: number }>();
  const byChallenge = new Map<string, { count: number; spent: number; granted: number }>();
  type Entry = { count: number; spent: number; granted: number };
  const byCheck = new Map<string, Entry>();
  const byOperation = new Map<string, Entry>();
  const unclassifiedReasons = new Map<string, Entry>();
  let unclassifiedCount = 0;
  const group = (map: Map<string, Entry>, key: string, spent: number, granted: number) => {
    const entry = map.get(key) ?? { count: 0, spent: 0, granted: 0 };
    entry.count++;
    entry.spent = sumBudgetAmounts([entry.spent, spent]);
    entry.granted = sumBudgetAmounts([entry.granted, granted]);
    map.set(key, entry);
  };
  const label = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  let spent = 0;
  let granted = 0;
  for (const item of transactions) {
    const amount = transactionAmount(item);
    const spentAmount = amount < 0 ? Math.abs(amount) : 0;
    const grantedAmount = amount > 0 ? amount : 0;
    spent = sumBudgetAmounts([spent, spentAmount]);
    granted = sumBudgetAmounts([granted, grantedAmount]);
    const check = label(item?.checkKey) ? toPublicCheckKey(item.checkKey) : undefined;
    const knownReasons: Record<string, string> = {
      agent_reeval_spent: "runs:reEvaluation",
      fp_check_spent: "reviews:fpCheck",
    };
    const operation = label(item?.operation)
      ? item.operation
      : Object.hasOwn(knownReasons, item?.reason)
        ? knownReasons[item.reason]
        : undefined;
    if (check) group(byCheck, check, spentAmount, grantedAmount);
    if (operation) group(byOperation, operation, spentAmount, grantedAmount);
    if (!check && !operation) {
      unclassifiedCount++;
      group(
        unclassifiedReasons,
        label(item?.reason) ? item.reason : "unknown",
        spentAmount,
        grantedAmount,
      );
    }
    const reason = String(item?.reason ?? "unknown");
    const reasonEntry = byReason.get(reason) ?? { count: 0, spent: 0, granted: 0 };
    reasonEntry.count += 1;
    reasonEntry.spent = sumBudgetAmounts([reasonEntry.spent, spentAmount]);
    reasonEntry.granted = sumBudgetAmounts([reasonEntry.granted, grantedAmount]);
    byReason.set(reason, reasonEntry);
    const challengeId = transactionChallengeId(item);
    if (challengeId) {
      const challengeEntry = byChallenge.get(challengeId) ?? { count: 0, spent: 0, granted: 0 };
      challengeEntry.count += 1;
      challengeEntry.spent = sumBudgetAmounts([challengeEntry.spent, spentAmount]);
      challengeEntry.granted = sumBudgetAmounts([challengeEntry.granted, grantedAmount]);
      byChallenge.set(challengeId, challengeEntry);
    }
  }
  return {
    transactionCount: transactions.length,
    spent,
    granted,
    byCheck: Object.fromEntries(byCheck),
    byOperation: Object.fromEntries(byOperation),
    attribution: {
      source: "explicit-backend-metadata-or-unambiguous-reason",
      coverage: unclassifiedCount ? "partial" : "complete",
      classifiedCount: transactions.length - unclassifiedCount,
      note: "Counts are backend transactions, not executions. Raw reasons are not check identities. No attribution is inferred from prices, timestamps or job IDs. Local prospective quotes are separate from backend charges.",
    },
    historyCoverage: { scope: "returned-transactions", completeness: "unknown" },
    unclassified: {
      count: unclassifiedCount,
      spent: sumBudgetAmounts([...unclassifiedReasons.values()].map((entry) => entry.spent)),
      granted: sumBudgetAmounts([...unclassifiedReasons.values()].map((entry) => entry.granted)),
      ...(full ? { backendReasons: Object.fromEntries(unclassifiedReasons) } : {}),
    },
    ...(full ? { backendReasons: Object.fromEntries(byReason) } : {}),
    byChallenge: Object.fromEntries(byChallenge),
  };
}

const balance = defineCommand({
  meta: { name: "tokens balance", description: "Show the current token balances" },
  args: {
    json: { type: "boolean", description: "Output compact JSON" },
    full: { type: "boolean", description: "Include complete backend payloads" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    const [balanceData, revisionTokens] = await Promise.all([
      client.query(api.contributorTokens.getBalance, {}),
      client.query(api.contributorTokens.getAllRevisionTokens, {}),
    ]);
    const result = args.full
      ? { balance: balanceData, revisionTokens }
      : compactBalance(balanceData, Array.isArray(revisionTokens) ? revisionTokens : []);
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

const usage = defineCommand({
  meta: { name: "tokens usage", description: "Show token grants and spending history" },
  args: {
    challenge: {
      type: "string",
      description: "Filter backend usage and show separate local budget for one challenge",
    },
    from: { type: "string", description: "Include transactions from this ISO date" },
    to: { type: "string", description: "Include transactions through this ISO date" },
    json: { type: "boolean", description: "Output compact JSON" },
    full: { type: "boolean", description: "Include complete backend payloads" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    let transactions: any[] = await client.query(api.contributorTokens.getTransactions, {});
    if (!Array.isArray(transactions))
      throw new Error("Backend transactions response is not an array; usage is unavailable");
    const from = args.from ? Date.parse(args.from) : undefined;
    const to = args.to ? Date.parse(args.to) + 86_399_999 : undefined;
    if (args.from && !Number.isFinite(from)) throw new Error("--from must be a valid ISO date");
    if (args.to && !Number.isFinite(to)) throw new Error("--to must be a valid ISO date");
    transactions = transactions.filter((item) => {
      const timestamp = transactionDate(item);
      if (from !== undefined && (timestamp === undefined || timestamp < from)) return false;
      if (to !== undefined && (timestamp === undefined || timestamp > to)) return false;
      if (args.challenge && transactionChallengeId(item) !== args.challenge) return false;
      return true;
    });
    const result: any = {
      scope: args.challenge
        ? { challengeId: args.challenge, source: "ledger-filter" }
        : { source: "ledger" },
      ...summarizeTransactions(transactions, args.full),
      tokenUsage: summarizeTokenUsage(transactions),
    };
    if (args.full) (result as any).raw = transactions;
    if (args.challenge) result.localBudget = await localBudgetStatus(client, args.challenge);
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

const costs = defineCommand({
  meta: {
    name: "tokens costs",
    description: "Show live official prospective tariffs and version offers",
  },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    version: { type: "string", description: "Version number (default: latest)" },
    json: { type: "boolean", description: "Output compact JSON" },
  },
  run: async ({ args }) => {
    const { client, version, versionNumber } = await resolveCommandContext(args);
    const catalog = await resolveCostCatalog(client, version._id);
    const result = { version: versionNumber, ...catalog };
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

export default defineCommand({
  meta: { name: "tokens", description: "View token balances, usage, and challenge costs" },
  subCommands: { balance, usage, costs },
});
