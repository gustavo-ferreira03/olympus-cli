import { api } from "../platform/convex.ts";
import {
  buildOverview,
  buildSnapshot,
  challengeQueries,
  clean,
  failedSource,
  headFromProblem,
  overviewValue,
  OVERVIEW_QUERIES,
  PRECHECK_FALLBACK,
  sourceFromResult,
  type DashboardOverviewFilters,
  type OverviewRaw,
  type OverviewSnapshot,
  type Snapshot,
  type Source,
  type SourceQuery,
} from "./data.ts";

export type SubscriptionClient = {
  onUpdate(
    query: any,
    args: Record<string, unknown>,
    callback: (value: any) => void,
    onError?: (error: Error) => void,
  ): () => void;
  connectionState(): { isWebSocketConnected: boolean };
  close(): Promise<void>;
};

export type LiveOptions = {
  refreshBalance: () => Promise<void>;
  readBudget: (id: string) => Promise<unknown>;
};

const BALANCE_REFRESH_INTERVAL_MS = 60_000;
const errorMessage = (error: unknown) =>
  clean(error instanceof Error ? error.message : error).slice(0, 300);

export class LiveDashboard {
  private subscriptions: Array<() => void> = [];
  private sourceSubscriptions: Array<() => void> = [];
  private view: { mode: "overview" } | { mode: "challenge"; id: string } | undefined;
  private overviewRaw: OverviewRaw = {};
  private head: ReturnType<typeof headFromProblem> | undefined;
  private sources: Record<string, Source> = {};
  private failure: string | undefined;
  private cached: Snapshot | undefined;
  private cachedOverview: OverviewSnapshot | undefined;
  private lastBalanceRefresh = 0;

  constructor(
    private client: SubscriptionClient,
    private options: LiveOptions,
    private onChange: () => void,
  ) {}

  connected(): boolean {
    try {
      return this.client.connectionState().isWebSocketConnected;
    } catch {
      return false;
    }
  }

  error(): string | undefined {
    return this.failure;
  }

  showOverview(): void {
    if (this.view?.mode === "overview") return;
    this.reset({ mode: "overview" });
    for (const { name, reference, args } of OVERVIEW_QUERIES)
      this.subscriptions.push(
        this.client.onUpdate(
          reference,
          args,
          (value) => {
            if (name === "balance") this.maybeRefreshBalance(value);
            this.overviewRaw[name] = overviewValue(name, value);
            this.cachedOverview = undefined;
            if (name === "problems") this.failure = undefined;
            this.onChange();
          },
          (error) => {
            if (name === "problems") this.failure = errorMessage(error);
            else this.overviewRaw[name] = { error: errorMessage(error) };
            this.cachedOverview = undefined;
            this.onChange();
          },
        ),
      );
  }

  overview(filters: DashboardOverviewFilters): OverviewSnapshot | undefined {
    if (!Array.isArray(this.overviewRaw.problems)) return undefined;
    this.cachedOverview ??= buildOverview(this.overviewRaw, filters);
    return this.cachedOverview;
  }

  showChallenge(id: string): void {
    if (this.view?.mode === "challenge" && this.view.id === id) return;
    this.reset({ mode: "challenge", id });
    this.subscriptions.push(
      this.client.onUpdate(
        api.problems.getWithLatestVersion,
        { problemId: id },
        (value) => {
          try {
            const head = headFromProblem(value);
            const versionChanged = head.versionId !== this.head?.versionId;
            this.head = head;
            this.failure = undefined;
            if (versionChanged) this.subscribeSources(id, head.versionId);
            this.cached = undefined;
          } catch (error) {
            this.failure = errorMessage(error);
          }
          this.onChange();
        },
        (error) => {
          this.failure = errorMessage(error);
          this.onChange();
        },
      ),
    );
    void this.tick();
  }

  snapshot(): Snapshot | undefined {
    if (this.view?.mode !== "challenge" || !this.head) return undefined;
    this.cached ??= buildSnapshot(this.view.id, this.head, { ...this.sources });
    return this.cached;
  }

  async tick(): Promise<void> {
    if (this.view?.mode !== "challenge") return;
    const { id } = this.view;
    try {
      const budget = await this.options.readBudget(id);
      if (this.view?.mode === "challenge" && this.view.id === id)
        this.setSource("budget", sourceFromResult("budget", budget));
    } catch (error) {
      this.setSource("budget", failedSource(error, this.sources.budget));
    }
  }

  resubscribe(): void {
    const view = this.view;
    this.reset(undefined);
    if (view?.mode === "overview") this.showOverview();
    else if (view) this.showChallenge(view.id);
  }

  async close(): Promise<void> {
    this.reset(undefined);
    await this.client.close();
  }

  private setSource(name: string, source: Source): void {
    this.sources[name] = source;
    this.cached = undefined;
    this.onChange();
  }

  private subscribeSources(id: string, versionId: string | null): void {
    for (const unsubscribe of this.sourceSubscriptions.splice(0)) unsubscribe();
    const budget = this.sources.budget;
    this.sources = budget ? { budget } : {};
    for (const query of challengeQueries(id, versionId)) this.subscribeSource(id, versionId, query);
  }

  private subscribeSource(id: string, versionId: string | null, query: SourceQuery): void {
    const { name, reference, args } = query;
    let unsubscribe = this.client.onUpdate(
      reference,
      args,
      (value) => {
        if (name === "balance") this.maybeRefreshBalance(value);
        try {
          this.setSource(name, sourceFromResult(name, value));
        } catch (error) {
          this.setSource(name, failedSource(error, this.sources[name]));
        }
      },
      (error) => {
        if (name === "prechecks" && versionId) {
          unsubscribe();
          unsubscribe = this.client.onUpdate(
            PRECHECK_FALLBACK.reference,
            PRECHECK_FALLBACK.args(id, versionId),
            (value) =>
              this.setSource(name, sourceFromResult(name, PRECHECK_FALLBACK.transform(value))),
            (fallbackError) =>
              this.setSource(name, failedSource(fallbackError, this.sources[name])),
          );
          return;
        }
        this.setSource(name, failedSource(error, this.sources[name]));
      },
    );
    this.sourceSubscriptions.push(() => unsubscribe());
  }

  private maybeRefreshBalance(balance: any): void {
    if (balance?.needsRefresh !== true) return;
    if (Date.now() - this.lastBalanceRefresh < BALANCE_REFRESH_INTERVAL_MS) return;
    this.lastBalanceRefresh = Date.now();
    void (async () => {
      try {
        await this.options.refreshBalance();
      } catch {}
    })();
  }

  private reset(view: LiveDashboard["view"]): void {
    for (const unsubscribe of [...this.subscriptions, ...this.sourceSubscriptions]) unsubscribe();
    this.subscriptions = [];
    this.sourceSubscriptions = [];
    this.view = view;
    this.overviewRaw = {};
    this.cachedOverview = undefined;
    this.head = undefined;
    this.sources = {};
    this.failure = undefined;
    this.cached = undefined;
  }
}
