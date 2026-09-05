import { defineCommand } from "citty";
import { api, getClient } from "../convex.ts";
import { printJson } from "../format.ts";
import { omitEmpty } from "../output.ts";
import { resolveCommandContext } from "../command-utils.ts";

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function compactBalance(balance: any, revisionTokens: any[]) {
  const totalRevision = revisionTokens.reduce((sum, item) => sum + (number(item?.balance) ?? 0), 0);
  return omitEmpty({
    balance: balance?.balance,
    cap: balance?.cap,
    tierName: balance?.tierName,
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
  return number(item?.amount ?? item?.tokens ?? item?.delta) ?? 0;
}

function transactionChallengeId(item: any): string | undefined {
  return item?.challengeId ?? item?.problemId ?? item?.itemId;
}

function summarizeTransactions(transactions: any[]) {
  const byReason = new Map<string, { count: number; spent: number; granted: number }>();
  const byChallenge = new Map<string, { count: number; spent: number; granted: number }>();
  let spent = 0;
  let granted = 0;
  for (const item of transactions) {
    const amount = transactionAmount(item);
    const spentAmount = amount < 0 ? Math.abs(amount) : 0;
    const grantedAmount = amount > 0 ? amount : 0;
    spent += spentAmount;
    granted += grantedAmount;
    const reason = String(item?.reason ?? "unknown");
    const reasonEntry = byReason.get(reason) ?? { count: 0, spent: 0, granted: 0 };
    reasonEntry.count += 1;
    reasonEntry.spent += spentAmount;
    reasonEntry.granted += grantedAmount;
    byReason.set(reason, reasonEntry);
    const challengeId = transactionChallengeId(item);
    if (challengeId) {
      const challengeEntry = byChallenge.get(challengeId) ?? { count: 0, spent: 0, granted: 0 };
      challengeEntry.count += 1;
      challengeEntry.spent += spentAmount;
      challengeEntry.granted += grantedAmount;
      byChallenge.set(challengeId, challengeEntry);
    }
  }
  return {
    transactionCount: transactions.length,
    spent,
    granted,
    byReason: Object.fromEntries(byReason),
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
    challenge: { type: "string", description: "Filter usage to one challenge ID" },
    from: { type: "string", description: "Include transactions from this ISO date" },
    to: { type: "string", description: "Include transactions through this ISO date" },
    json: { type: "boolean", description: "Output compact JSON" },
    full: { type: "boolean", description: "Include complete backend payloads" },
  },
  run: async ({ args }) => {
    const client = await getClient();
    let transactions: any[] = await client.query(api.contributorTokens.getTransactions, {});
    if (!Array.isArray(transactions)) transactions = [];
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
      scope: args.challenge ? { challengeId: args.challenge, source: "ledger-filter" } : { source: "ledger" },
      ...summarizeTransactions(transactions),
    };
    if (args.full) (result as any).raw = transactions;
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

const costs = defineCommand({
  meta: { name: "tokens costs", description: "Show token costs returned by current challenge records" },
  args: {
    id: { type: "positional", description: "Challenge ID", required: true },
    version: { type: "string", description: "Version number (default: latest)" },
    json: { type: "boolean", description: "Output compact JSON" },
  },
  run: async ({ args }) => {
    const { client, version, versionNumber } = await resolveCommandContext(args);
    const [runs, dynamic, fp] = await Promise.all([
      client.query(api.runAgentRuns.getAgentRuns, { versionId: version._id }),
      client.query(api.runDynamicChecks.getDynamicChecks, { versionId: version._id }),
      client.query(api.fpReview.getFpCheckForVersion, { versionId: version._id }),
    ]);
    const runCosts = (Array.isArray(runs) ? runs : []).map((run: any) => ({
      type: "run",
      id: run.id,
      costTokens: number(run.costTokens ?? run.output?.costTokens ?? run.output?.tokenCost),
    })).filter((item) => item.costTokens !== undefined);
    const checkCosts = Object.entries(dynamic && typeof dynamic === "object" ? dynamic : {}).map(([key, value]: [string, any]) => ({
      type: "check",
      key,
      costTokens: number(value?.costTokens ?? value?.tokenCost),
    })).filter((item) => item.costTokens !== undefined);
    const fpCost = number((fp as any)?.tokenCost);
    const items = [...runCosts, ...checkCosts, ...(fpCost === undefined ? [] : [{ type: "fp-check", costTokens: fpCost }])];
    const result = { version: versionNumber, estimated: true, items, totalCostTokens: items.reduce((sum, item) => sum + (item.costTokens ?? 0), 0) };
    if (args.json) return printJson(result);
    console.log(JSON.stringify(result, null, 2));
  },
});

export default defineCommand({
  meta: { name: "tokens", description: "View token balances, usage, and challenge costs" },
  subCommands: { balance, usage, costs },
});
