import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { MAX_BUDGET_STATE_BYTES } from "../shared/limits.ts";
import { BudgetError } from "../shared/error-types.ts";
import { type BreakdownEntry, type BudgetFeedback } from "../shared/types.ts";

export type { BudgetFeedback };

// Re-exported so callers keep importing the error from the module that raises it.
export { BudgetError };

export type BudgetContext = {
  directory: string;
  scope: string;
  limit: number;
};
export type BudgetPart = {
  operation?: string;
  checkKey?: string;
  amount: number;
};
type Ledger = {
  schema: 1;
  scope: string;
  activatedAt: string;
  spent: number;
  reservations: Record<string, number>;
  breakdown?: { spent: BudgetPart[]; reservations: Record<string, BudgetPart[]> };
};

const amount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
export function sumBudgetAmounts(values: number[]): number {
  if (!values.every(amount))
    throw new BudgetError("Local budget amounts are invalid; dispatch blocked");
  const decimal = (value: number): [bigint, number] => {
    const [mantissa, exponent = "0"] = String(value).split("e");
    const [whole, fraction = ""] = mantissa.split(".");
    return [BigInt(whole + fraction), Number(exponent) - fraction.length];
  };
  const parts = values.map(decimal);
  const exponent = Math.min(0, ...parts.map(([, exponent]) => exponent));
  const exact = parts.reduce(
    (total, [digits, power]) => total + digits * 10n ** BigInt(power - exponent),
    0n,
  );
  let total = Number(`${exact}e${exponent}`);
  if (!amount(total)) throw new BudgetError("Local budget totals are invalid; dispatch blocked");
  const [digits, power] = decimal(total);
  const common = Math.min(power, exponent);
  if (digits * 10n ** BigInt(power - common) < exact * 10n ** BigInt(exponent - common)) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, total);
    view.setBigUint64(0, view.getBigUint64(0) + 1n);
    total = view.getFloat64(0);
    if (!amount(total)) throw new BudgetError("Local budget totals overflow; dispatch blocked");
  }
  return total;
}
const sum = sumBudgetAmounts;
export function budgetScope(backend: string, account: string, challenge: string): string {
  if (!account || !challenge)
    throw new BudgetError("Cannot identify the local budget account or challenge");
  const url = new URL(backend);
  if (url.username || url.password || url.search || url.hash)
    throw new BudgetError("Cannot establish a credential-free backend scope");
  return createHash("sha256")
    .update(JSON.stringify([url.href.replace(/\/$/, ""), account, challenge]))
    .digest("hex");
}
function validateContext(context: BudgetContext) {
  if (!/^[a-f0-9]{64}$/.test(context.scope) || !amount(context.limit))
    throw new BudgetError("Invalid local budget context");
}
async function readLedger(context: BudgetContext): Promise<Ledger | null> {
  let handle;
  try {
    handle = await open(
      join(context.directory, `${context.scope}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BUDGET_STATE_BYTES) {
      throw new Error("Budget state is not a regular file, or exceeds the size limit");
    }
    const data = JSON.parse(await handle.readFile("utf8"));
    if (
      !data
      || data.schema !== 1
      || data.scope !== context.scope
      || !amount(data.spent)
      || typeof data.activatedAt !== "string"
      || !Number.isFinite(Date.parse(data.activatedAt))
      || !data.reservations
      || typeof data.reservations !== "object"
      || Array.isArray(data.reservations)
      || Object.entries(data.reservations).some(
        ([key, value]) => !/^[a-f0-9-]{36}$/.test(key) || !amount(value),
      )
      || ![
        "activatedAt,reservations,schema,scope,spent",
        "activatedAt,breakdown,reservations,schema,scope,spent",
      ].includes(Object.keys(data).toSorted().join(","))
    )
      throw new Error("Budget state has an unexpected set of top-level keys");
    sum([data.spent, ...(Object.values(data.reservations) as number[])]);
    if (Object.hasOwn(data, "breakdown")) {
      const detail = data.breakdown;
      if (
        !detail
        || Object.keys(detail).toSorted().join(",") !== "reservations,spent"
        || !detail.reservations
        || Array.isArray(detail.reservations)
        || Object.keys(detail.reservations).toSorted().join(",")
          !== Object.keys(data.reservations).toSorted().join(",")
      )
        throw new Error("Budget breakdown does not match the recorded reservations");
      validateParts(detail.spent, data.spent);
      for (const [key, cost] of Object.entries(data.reservations))
        validateParts(detail.reservations[key], cost as number);
    }
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new BudgetError("Local budget state is unreadable or corrupt; dispatch blocked");
  } finally {
    await handle?.close();
  }
}
function feedback(
  context: BudgetContext,
  ledger: Ledger | null,
  cost: number | null = null,
): BudgetFeedback {
  const spent = ledger?.spent ?? 0;
  const reserved = sum(Object.values(ledger?.reservations ?? {}));
  return {
    scope: "local",
    scopeId: context.scope,
    accounting: "prospective-quotes",
    cost,
    spent,
    reserved,
    limit: context.limit,
    remaining: Math.max(0, context.limit - sum([spent, reserved])),
    activatedAt: ledger?.activatedAt ?? null,
    ...breakdownFeedback(ledger),
  };
}
function validateParts(parts: unknown, cost: number): asserts parts is BudgetPart[] {
  if (
    !Array.isArray(parts)
    || parts.some(
      (p) =>
        !p
        || typeof p !== "object"
        || Array.isArray(p)
        || !amount(p.amount)
        || Object.keys(p).some((k) => !["operation", "checkKey", "amount"].includes(k))
        || [p.operation, p.checkKey].some(
          (v) => v !== undefined && (typeof v !== "string" || !v.trim()),
        ),
    )
    || sum(parts.map((p) => p.amount)) !== cost
  )
    throw new BudgetError("Local budget attribution breakdown does not match its aggregate");
}
function breakdown(ledger: Ledger): NonNullable<Ledger["breakdown"]> {
  return (
    ledger.breakdown ?? {
      spent: ledger.spent ? [{ amount: ledger.spent }] : [],
      reservations: Object.fromEntries(
        Object.entries(ledger.reservations).map(([key, amount]) => [key, [{ amount }]]),
      ),
    }
  );
}
function breakdownFeedback(ledger: Ledger | null) {
  type Amounts = { spent: number[]; reserved: number[] };
  const byCheck = new Map<string, Amounts>();
  const byOperation = new Map<string, Amounts>();
  const unattributed: Amounts = { spent: [], reserved: [] };
  let partial = false;
  const group = (
    map: Map<string, Amounts>,
    key: string,
    state: "spent" | "reserved",
    amount: number,
  ) => {
    const entry = map.get(key) ?? { spent: [], reserved: [] };
    entry[state].push(amount);
    map.set(key, entry);
  };
  const detail = ledger ? breakdown(ledger) : { spent: [], reservations: {} };
  for (const [state, parts] of [
    ["spent", detail.spent],
    ["reserved", Object.values(detail.reservations).flat()],
  ] as const) {
    for (const part of parts) {
      if (part.checkKey) group(byCheck, part.checkKey, state, part.amount);
      if (part.operation) group(byOperation, part.operation, state, part.amount);
      if (!part.operation && !part.checkKey) {
        unattributed[state].push(part.amount);
        partial = true;
      }
    }
  }
  const totals = (entry: Amounts): BreakdownEntry => ({
    spent: sum(entry.spent),
    reserved: sum(entry.reserved),
  });
  const grouped = (map: Map<string, Amounts>) =>
    Object.fromEntries([...map].map(([key, entry]) => [key, totals(entry)]));
  return {
    byCheck: grouped(byCheck),
    byOperation: grouped(byOperation),
    unattributed: totals(unattributed),
    attribution: {
      source: "dispatch-arguments-and-prospective-quotes" as const,
      coverage: partial ? ("partial" as const) : ("complete" as const),
    },
  };
}
export async function readBudget(context: BudgetContext): Promise<BudgetFeedback> {
  validateContext(context);
  return feedback(context, await readLedger(context));
}
async function locked<T>(context: BudgetContext, operation: () => Promise<T>): Promise<T> {
  validateContext(context);
  try {
    await mkdir(context.directory, { recursive: true, mode: 0o700 });
    if (
      !(await lstat(context.directory)).isDirectory()
      || (await lstat(context.directory)).isSymbolicLink()
    )
      throw new Error("Budget directory is missing, or is a symlink");
  } catch {
    throw new BudgetError("Cannot open the local budget directory; dispatch blocked");
  }
  const lock = join(context.directory, `${context.scope}.lock`);
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new BudgetError("Cannot lock local budget state; dispatch blocked");
      if (Date.now() >= deadline)
        throw new BudgetError(
          "Local budget lock is busy; dispatch blocked. Inspect pending CLI processes before recovering an abandoned lock",
        );
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 25));
    }
  }
  try {
    return await operation();
  } finally {
    await rmdir(lock);
  }
}
async function writeLedger(context: BudgetContext, ledger: Ledger) {
  const temp = join(context.directory, `${context.scope}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(ledger)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, join(context.directory, `${context.scope}.json`));
    const directory = await open(context.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    throw new BudgetError(
      "Cannot persist local budget accounting; do not retry a dispatch with an uncertain outcome",
    );
  } finally {
    await handle?.close();
    await unlink(temp).catch(() => {});
  }
}
export async function reserveBudget(
  context: BudgetContext,
  cost: number,
  authorize: (state: BudgetFeedback) => void,
  parts: BudgetPart[] = [{ amount: cost }],
): Promise<{ id: string; feedback: BudgetFeedback }> {
  if (!amount(cost)) throw new BudgetError("Cannot reserve an unknown or invalid prospective cost");
  validateParts(parts, cost);
  parts = parts.map((part) => ({ ...part }));
  return locked(context, async () => {
    const ledger: Ledger = (await readLedger(context)) ?? {
      schema: 1,
      scope: context.scope,
      activatedAt: new Date().toISOString(),
      spent: 0,
      reservations: {},
    };
    const state = feedback(context, ledger, cost);
    authorize(state);
    ledger.breakdown = breakdown(ledger);
    const id = randomUUID();
    ledger.reservations[id] = cost;
    ledger.breakdown.reservations[id] = parts;
    await writeLedger(context, ledger);
    return { id, feedback: { ...feedback(context, ledger, cost), status: "reserved" } };
  });
}
export async function settleBudget(
  context: BudgetContext,
  reservation: string,
  outcome: "spent" | "released",
): Promise<BudgetFeedback> {
  return locked(context, async () => {
    const ledger = await readLedger(context);
    if (!ledger || !Object.hasOwn(ledger.reservations, reservation))
      throw new BudgetError("Local budget reservation is missing; accounting requires inspection");
    const cost = ledger.reservations[reservation];
    ledger.breakdown = breakdown(ledger);
    if (outcome === "spent") {
      ledger.breakdown.spent.push(...ledger.breakdown.reservations[reservation]);
      ledger.spent = sum(ledger.breakdown.spent.map((part) => part.amount));
    }
    delete ledger.breakdown.reservations[reservation];
    delete ledger.reservations[reservation];
    await writeLedger(context, ledger);
    return { ...feedback(context, ledger, cost), status: outcome };
  });
}
