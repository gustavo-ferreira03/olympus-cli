export type TokenUsageBin = {
  from: number;
  to: number;
  spent: number;
  granted: number;
  net: number;
  transactionCount: number;
};

export type TokenUsageSnapshot = {
  source: "contributorTokens.getTransactions";
  completeness: "unknown";
  from: number;
  to: number;
  windowHours: 24;
  binHours: 6;
  transactionCount: number;
  inWindowTransactionCount: number;
  invalidAmountCount: number;
  invalidTimestampCount: number;
  spent: number;
  granted: number;
  net: number;
  bins: TokenUsageBin[];
  error: string | null;
};

const WINDOW_MS = 24 * 60 * 60 * 1000;
const BIN_MS = 6 * 60 * 60 * 1000;
const BIN_COUNT = WINDOW_MS / BIN_MS;

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

function transactionTimestamp(item: any): number | null {
  return numberValue(item?.createdAt ?? item?.timestamp ?? item?._creationTime);
}

function emptyBins(from: number, to: number): TokenUsageBin[] {
  return Array.from({ length: BIN_COUNT }, (_, index) => {
    const start = from + index * BIN_MS;
    return {
      from: start,
      to: index === BIN_COUNT - 1 ? to : start + BIN_MS,
      spent: 0,
      granted: 0,
      net: 0,
      transactionCount: 0,
    };
  });
}

/**
 * Aggregate the returned contributor-token ledger into the web UI's 24h/6h
 * shape. The backend query is currently not paginated, so completeness stays
 * explicitly unknown instead of being inferred from the returned row count.
 */
export function summarizeTokenUsage(transactions: unknown, now = Date.now()): TokenUsageSnapshot {
  const from = now - WINDOW_MS;
  const bins = emptyBins(from, now);
  if (!Array.isArray(transactions)) {
    return {
      source: "contributorTokens.getTransactions",
      completeness: "unknown",
      from,
      to: now,
      windowHours: 24,
      binHours: 6,
      transactionCount: 0,
      inWindowTransactionCount: 0,
      invalidAmountCount: 0,
      invalidTimestampCount: 0,
      spent: 0,
      granted: 0,
      net: 0,
      bins,
      error: "Backend token transactions response is unavailable",
    };
  }

  let inWindowTransactionCount = 0;
  let invalidAmountCount = 0;
  let invalidTimestampCount = 0;
  let spent = 0;
  let granted = 0;
  for (const item of transactions) {
    const amount = numberValue(item?.amount);
    const timestamp = transactionTimestamp(item);
    if (amount === null) {
      invalidAmountCount++;
      continue;
    }
    if (timestamp === null) {
      invalidTimestampCount++;
      continue;
    }
    if (timestamp < from || timestamp > now) continue;
    inWindowTransactionCount++;
    const spentAmount = amount < 0 ? Math.abs(amount) : 0;
    const grantedAmount = amount > 0 ? amount : 0;
    spent += spentAmount;
    granted += grantedAmount;
    const index = Math.min(BIN_COUNT - 1, Math.floor((timestamp - from) / BIN_MS));
    const bin = bins[index];
    bin.spent += spentAmount;
    bin.granted += grantedAmount;
    bin.net = bin.granted - bin.spent;
    bin.transactionCount++;
  }

  return {
    source: "contributorTokens.getTransactions",
    completeness: "unknown",
    from,
    to: now,
    windowHours: 24,
    binHours: 6,
    transactionCount: transactions.length,
    inWindowTransactionCount,
    invalidAmountCount,
    invalidTimestampCount,
    spent,
    granted,
    net: granted - spent,
    bins,
    error: null,
  };
}
