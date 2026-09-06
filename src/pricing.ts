import { parse } from "acorn";
import { createHash } from "node:crypto";
import { anyApi } from "convex/server";
import { getBaseUrl } from "./config.ts";

// Data retrieval only. Budget enforcement and operation selection live in policy.ts.
type Node = any;
type Scope = { parent?: Scope; bindings: Map<string, Node | null> };
export interface OfficialPrices {
  checks: Record<string, number>;
  scopeGate: number;
  bundledPrechecks: number;
  build: number;
  finalQaPerItem: number;
  diamond: Record<string, number>;
}
const object = (v: any): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const fail = (detail: string): never => { throw new Error(`Official pricing unavailable: ${detail}`); };
const key = (n: Node): string | undefined => n?.type === "Identifier" ? n.name : n?.type === "Literal" && typeof n.value === "string" ? n.value : undefined;
const props = (n: Node): Map<string, Node> => new Map(n?.type === "ObjectExpression" ? n.properties.filter((p: Node) => p.type === "Property" && !p.computed && p.kind === "init").map((p: Node) => [key(p.key), p.value]) : []);
const member = (n: Node, name: string) => n?.type === "MemberExpression" && !n.computed && key(n.property) === name;

/** Parse a limited static subset; never eval/import/execute downloaded JavaScript.
 * Anchors are public property names, spend-dialog labels and API members, not
 * generated symbols. Unrecognized expressions and non-unique anchors fail closed.
 */
export function parseOfficialPrices(source: string): OfficialPrices {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const scopes = new WeakMap<Node, Scope>();
  const parents = new WeakMap<Node, Node>();
  const nodes: Node[] = [];
  const bindPattern = (n: Node, scope: Scope) => {
    if (!n) return;
    if (n.type === "Identifier") scope.bindings.set(n.name, null);
    else if (n.type === "ObjectPattern") n.properties.forEach((p: Node) => bindPattern(p.value ?? p.argument, scope));
    else if (n.type === "ArrayPattern") n.elements.forEach((p: Node) => bindPattern(p, scope));
    else if (n.type === "AssignmentPattern") bindPattern(n.left, scope);
    else if (n.type === "RestElement") bindPattern(n.argument, scope);
  };
  const walk = (n: Node, scope: Scope, parent?: Node) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "FunctionDeclaration" && n.id) scope.bindings.set(n.id.name, n);
    if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|BlockStatement|CatchClause)$/.test(n.type)) {
      scope = { parent: scope, bindings: new Map() };
      n.params?.forEach((p: Node) => bindPattern(p, scope));
      if (n.type === "CatchClause") bindPattern(n.param, scope);
    }
    scopes.set(n, scope);
    if (parent) parents.set(n, parent);
    nodes.push(n);
    if (n.type === "VariableDeclaration") for (const d of n.declarations) {
      bindPattern(d.id, scope);
      if (d.id.type === "Identifier" && n.kind === "const") scope.bindings.set(d.id.name, d.init);
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(c => { if (c?.type) walk(c, scope, n); });
      else if (v && typeof v === "object" && "type" in v) walk(v, scope, n);
    }
  };
  walk(ast, { bindings: new Map() });
  const binding = (n: Node): Node | null | undefined => {
    for (let s = scopes.get(n); s; s = s.parent) if (s.bindings.has(n.name)) return s.bindings.get(n.name);
  };
  const mutated = new Set<Node>();
  for (const n of nodes) {
    let target = n.type === "AssignmentExpression" ? n.left : n.type === "UpdateExpression" || (n.type === "UnaryExpression" && n.operator === "delete") ? n.argument : undefined;
    while (target?.type === "MemberExpression") target = target.object;
    if (target?.type === "Identifier") {
      const b = binding(target);
      if (b) mutated.add(b);
    }
  }
  const strictProps = (n: Node) => {
    const p = props(n);
    if (n?.type !== "ObjectExpression" || p.size !== n.properties.length || mutated.has(n)) fail("unsupported, duplicate or mutated constant object");
    return p;
  };
  const resolve = (n: Node, seen = new Set<Node>()): Node => {
    if (!n || seen.has(n) || mutated.has(n)) return fail("unresolved, cyclic or mutated constant");
    seen.add(n);
    if (n.type === "Identifier") return resolve(binding(n), seen);
    if (n.type === "MemberExpression" && !n.computed) return resolve(strictProps(resolve(n.object, seen)).get(key(n.property)!), seen);
    return n;
  };
  const value = (n: Node): number => {
    const r = resolve(n);
    if (r.type !== "Literal" || !amount(r.value)) return fail("price is not a finite non-negative static number");
    return r.value;
  };
  const one = <T>(items: T[], label: string): T => items.length === 1 ? items[0] : fail(`missing or ambiguous ${label} (${items.length} matches)`);
  const objects = nodes.filter(n => n.type === "ObjectExpression");
  const base = one(objects.filter(n => ["verifyBuild", "verifyTests", "verifySolution", "verifyFairness", "taskQuality", "solutionQuality", "descriptionQuality", "crossRunAnalysis", "autoReview", "verifierIncompleteness"].every(k => props(n).has(k))), "base check catalog");
  strictProps(base);
  const checks = Object.fromEntries([...props(base)].map(([k, n]) => [k, value(n)]));
  const containsLabel = (n: Node, label: string): boolean => n?.type === "Literal" ? n.value === label : n?.type === "ConditionalExpression" && (containsLabel(n.consequent, label) || containsLabel(n.alternate, label));
  const dialog = (label: string) => {
    const result = one(objects.filter(n => props(n).has("cost") && containsLabel(props(n).get("label"), label)), label);
    strictProps(result);
    return result;
  };
  const scopeGate = value(props(dialog("Run Scope Gate")).get("cost"));
  const finalQaPerItem = value(props(dialog("Rerun this item")).get("cost"));
  const precheck = one(objects.filter(n => {
    const k = props(n).get("key");
    if (!k || !props(n).has("defaultCostTokens")) return false;
    try { return resolve(k).value === "bundled_prechecks"; } catch { return false; }
  }), "bundled prechecks");
  const bundledPrechecks = value(strictProps(precheck).get("defaultCostTokens"));
  const preDialog = props(dialog("Run Prechecks"));
  const pcost = preDialog.get("cost"), plabel = preDialog.get("label");
  if (pcost?.type !== "ConditionalExpression" || plabel?.type !== "ConditionalExpression" || source.slice(pcost.test.start, pcost.test.end) !== source.slice(plabel.test.start, plabel.test.end)) fail("unsupported precheck spend formula");
  if (value(plabel.consequent.value === "Run Prechecks" ? pcost.consequent : pcost.alternate) !== bundledPrechecks) fail("conflicting precheck prices");
  const buildMembers = nodes.filter(n => member(n, "buildVersionImage") && member(n.object, "dockerImage"));
  const buildFunctions = new Set<Node>();
  for (const m of buildMembers) {
    let n = parents.get(m);
    while (n && n.type !== "FunctionDeclaration") n = parents.get(n);
    if (n && n.params?.some((p: Node) => p.type === "ObjectPattern" && p.properties.some((q: Node) => key(q.key) === "cost"))) buildFunctions.add(n);
  }
  const buildFunction = one([...buildFunctions], "build component");
  const calls = nodes.filter(n => n.type === "CallExpression" && n.arguments[0]?.type === "Identifier" && binding(n.arguments[0]) === buildFunction && props(n.arguments[1]).has("cost"));
  const build = value(strictProps(one(calls, "build cost prop").arguments[1]).get("cost"));
  const diamond: Record<string, number> = {};
  for (const field of ["diamondChecksCostNewSession", "diamondChecksCostAppendJob", "diamondChecksCostCodeValidation", "diamondChecksCostFullEnvQa"]) {
    const matches = nodes.filter(n => n.type === "LogicalExpression" && n.operator === "??" && member(n.left?.type === "ChainExpression" ? n.left.expression : n.left, field));
    diamond[field] = value(one(matches, field).right);
  }
  return { checks, scopeGate, bundledPrechecks, build, finalQaPerItem, diamond };
}

async function readText(url: URL, limit: number): Promise<string> {
  const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000), headers: { "Cache-Control": "no-cache" } });
  if (!response.ok || !response.body) return fail(`HTTP ${response.status} reading frontend`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail("frontend response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchOfficialPrices() {
  const pageUrl = new URL(getBaseUrl().replace(/\/$/, ""));
  const html = await readText(pageUrl, 2 * 1024 * 1024);
  // Only the module entry actually referenced by HTML, not a guessed hashed URL.
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map(m => {
    const attrs = new Map([...m[1].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(a => [a[1].toLowerCase(), a[2] ?? a[3]]));
    return attrs.get("type") === "module" ? attrs.get("src") : undefined;
  }).filter((s): s is string => Boolean(s));
  if (scripts.length !== 1) return fail("expected one HTML module entry");
  const assetUrl = new URL(scripts[0], `${pageUrl.href}/`);
  if (assetUrl.origin !== pageUrl.origin || !assetUrl.pathname.startsWith(`${pageUrl.pathname}/`) || assetUrl.username || assetUrl.password || assetUrl.search || !["http:", "https:"].includes(assetUrl.protocol)) return fail("frontend asset is not same-origin HTTP(S)");
  const source = await readText(assetUrl, 16 * 1024 * 1024);
  return { ...parseOfficialPrices(source), source: { pageUrl: pageUrl.href, assetUrl: assetUrl.href, sha256: createHash("sha256").update(source).digest("hex"), fetchedAt: new Date().toISOString() } };
}

export interface Price { tokens: number | null; source: string; baseTokens?: number; reason?: string }
const known = (tokens: unknown, source: string, baseTokens?: number): Price => amount(tokens) ? { tokens, source, ...(baseTokens === undefined ? {} : { baseTokens }) } : { tokens: null, source, reason: "No valid prospective price returned" };
export type PricingReader = { query: (ref: any, args: any) => Promise<any> };
export async function resolveCostCatalog(client: PricingReader, versionId?: string) {
  const [ui, config, fp, reeval] = await Promise.all([
    fetchOfficialPrices(),
    client.query(anyApi.questConfig.getConfig, { slug: "olympus" }),
    versionId ? client.query(anyApi.fpReview.getFpCheckForVersion, { versionId }) : undefined,
    versionId ? client.query(anyApi.reEvalRuns.getReEvalOffer, { versionId }) : undefined,
  ]);
  if (!object(config)) return fail("quest config is missing");
  const overrides = config.checkTokenCostOverrides;
  if (overrides != null && !object(overrides)) return fail("invalid check override map");
  const checks: Record<string, Price> = {};
  for (const [k, base] of Object.entries(ui.checks)) {
    const override = object(overrides) && Object.hasOwn(overrides, k) ? overrides[k] : undefined;
    // Official check override contract: invalid entries retain the live UI base.
    const accepted = amount(override) && override <= 500;
    checks[k] = known(accepted ? override : base, accepted ? `questConfig.checkTokenCostOverrides.${k}` : "official-ui:check-base", base);
  }
  const runs = Object.fromEntries(["claude_code", "codex_cli", "gemini_cli", "taiga"].map(k => [k, known(object(config.agentRunPricing) && Object.hasOwn(config.agentRunPricing, k) ? config.agentRunPricing[k] : undefined, `questConfig.agentRunPricing.${k}`)]));
  const diamond = Object.fromEntries(Object.entries(ui.diamond).map(([field, base]) => [field, known(config[field] ?? base, config[field] == null ? "official-ui:diamond-default" : `questConfig.${field}`, base)]));
  const unknown = { tokens: null, source: "unknown", reason: "No official prospective tariff established; not assumed free" } satisfies Price;
  return {
    source: ui.source, unit: "contributor tokens", prospective: true,
    checks, runs,
    actions: {
      scopeGate: known(ui.scopeGate, "official-ui:scope-spend-dialog"),
      bundledPrechecks: known(ui.bundledPrechecks, "official-ui:bundled-prechecks"),
      build: known(ui.build, "official-ui:build-cost-prop"),
      finalQaPerItem: known(ui.finalQaPerItem, "official-ui:final-qa-rerun-item"),
    }, diamond,
    offers: {
      fp: { ...known(fp?.tokenCost, "fpReview:getFpCheckForVersion.tokenCost"), versionId: versionId ?? null, canRun: fp?.canRun ?? null },
      reevaluation: { ...known(reeval?.eligible === true ? reeval.tokenCost : undefined, "reEvalRuns:getReEvalOffer.tokenCost"), versionId: versionId ?? null, eligible: reeval?.eligible ?? null, runCount: reeval?.runCount ?? null },
    },
    formulas: { runs: "sum(solver price per requested run)", finalQa: "finalQaPerItem * selected or default eligible item count", finalQaRetry: "finalQaPerItem * failed/cancelled/stale-success item count", reevaluation: "total version offer, not a per-run tariff", bundledPrechecks: "one charge per bundled dispatch, not per stage" },
    unknown: Object.fromEntries(["orchestratorReview:triggerOrchestratorReview", "fairnessContest:contestVerifyFairness", "solutionQualityContest:contestSolutionQuality", "systemComments:contestDescriptionQuality", "taskQualityContest:contestTaskQualityAsMars", "fpReview:contestFpCheck", "verifierIncompleteness:submitVerifierIncompletenessDecision", "dockerImage:cancelBuildJob", "runAgentRuns:cancelRun", "runAgentRuns:scratchRun"].map(k => [k, unknown])),
    notes: ["Live frontend tariffs and backend offers are prospective, not a server reservation or invoice.", "No historical ledger inference, persistent price cache, or stale fallback.", "Administrative and contest prices are unknown, not zero."],
  };
}
