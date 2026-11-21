// Launch Signal — model radar-2 for token-radar-01.
//
// One sealed snapshot in, one ranked board out. The value model is fitted from the
// snapshot's own traded protocols, never from a hand-kept list of names:
//
//   log(mcap) = a + b * log(TVL)          fitted by least squares on traded comps
//   implied   = exp(a + b*ln(TVL)) * growth * maturity * p_token
//
// growth follows the 7-day TVL change, maturity follows how long the protocol has
// run, and p_token is the shrunk share of protocols in the same category that
// already record a token. The program also validates the fit at run time: a
// deterministic hash split (held-out) and a walk-forward split by listing date,
// each scored against the flat 0.25 x TVL baseline, so the dashboard can show
// measured errors instead of a claim.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The fitted log-log line, plus how many comps fitted it. */
export interface LogLogFit {
  a: number;
  b: number;
  n: number;
  excluded_zero_mcap: number;
}

/** One validation split, measured at run time from the snapshot. */
export interface ValidationSplit {
  name: string;
  n_test: number;
  model_median_abs_log_err: number;
  baseline_median_abs_log_err: number;
}

export interface Validation {
  fit: LogLogFit;
  splits: ValidationSplit[];
  global_token_rate: number;
}

/** A farm plan's economics, all derived from the protocol's own record. */
export interface FarmPlan {
  deposit_usd: number;
  setup_gas_usd: number;
  weekly_gas_usd: number;
  hold_days: number;
  total_fees_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  watchlist: boolean;
  implied_value_usd: number;
  model: {
    loglog_base_usd: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    p_token: number;
    fit_a: number;
    fit_b: number;
  };
  farm: FarmPlan;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  scanned: number;
  traded_anchors: number;
  validation: Validation;
  rows: BoardRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const MODEL_VERSION = 'radar-2';
const LIVE_ROWS = 24;

/** Median of a non-empty list. */
function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

import { createHash } from 'node:crypto';

/** Deterministic 32-bit hash of a string (SHA-256, first 8 hex digits): the held-out split must not move. */
function hash32(text: string): number {
  return parseInt(createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8), 16);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token at all in DefiLlama's record. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The watchlist's own exclusion rule, applied to the whole board, not just the list. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  if (EXCHANGES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** Traded comps usable for the fit: a token that trades with a positive market cap. */
function comps(snapshot: Snapshot): { list: SnapshotProtocol[]; excludedZero: number } {
  const list: SnapshotProtocol[] = [];
  let excludedZero = 0;
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) {
      if (p.mcap_usd !== null && p.mcap_usd <= 0) excludedZero++;
      continue;
    }
    list.push(p);
  }
  return { list, excludedZero };
}

/** Least-squares fit of log(mcap) on log(TVL) over the given comps. */
function fitLogLog(pool: SnapshotProtocol[]): LogLogFit {
  const xs = pool.map((p) => Math.log(p.tvl_usd));
  const ys = pool.map((p) => Math.log(p.mcap_usd!));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const b = den === 0 ? 0 : num / den;
  return { a: my - b * mx, b, n: pool.length, excluded_zero_mcap: 0 };
}

/** Median |log(pred / actual)| for a predictor over a test set. */
function medianAbsLogErr(pool: SnapshotProtocol[], predict: (p: SnapshotProtocol) => number): number {
  return median(pool.map((p) => Math.abs(Math.log(predict(p) / p.mcap_usd!))));
}

/**
 * The validation, measured at run time. Held-out: hash split 70/30 by slug.
 * Walk-forward: fit on the older half by listing date, test on the newer half.
 * Both are scored against the flat 0.25 x TVL baseline.
 */
export function validate(snapshot: Snapshot): Validation {
  const { list, excludedZero } = comps(snapshot);
  const full = fitLogLog(list);
  full.excluded_zero_mcap = excludedZero;
  const splits: ValidationSplit[] = [];

  const fitSet = list.filter((p) => hash32(p.slug) % 100 < 70);
  const testSet = list.filter((p) => hash32(p.slug) % 100 >= 70);
  if (fitSet.length >= 10 && testSet.length >= 5) {
    const f = fitLogLog(fitSet);
    splits.push({
      name: 'held-out (hash split 70/30)',
      n_test: testSet.length,
      model_median_abs_log_err: round3(medianAbsLogErr(testSet, (p) => Math.exp(f.a + f.b * Math.log(p.tvl_usd)))),
      baseline_median_abs_log_err: round3(medianAbsLogErr(testSet, (p) => p.tvl_usd * 0.25)),
    });
  }

  const dated = list.filter((p) => p.listed_at !== null).sort((x, y) => (x.listed_at! < y.listed_at! ? -1 : 1));
  if (dated.length >= 20) {
    const half = Math.floor(dated.length / 2);
    const older = dated.slice(0, half);
    const newer = dated.slice(half);
    const f = fitLogLog(older);
    splits.push({
      name: `walk-forward (fit listed to ${older[older.length - 1]!.listed_at}, test newer)`,
      n_test: newer.length,
      model_median_abs_log_err: round3(medianAbsLogErr(newer, (p) => Math.exp(f.a + f.b * Math.log(p.tvl_usd)))),
      baseline_median_abs_log_err: round3(medianAbsLogErr(newer, (p) => p.tvl_usd * 0.25)),
    });
  }

  const globalTokenRate = snapshot.protocols.filter((p) => !isPreToken(p)).length / snapshot.protocols.length;
  return { fit: full, splits, global_token_rate: round3(globalTokenRate) };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Shrunk token odds for a category: its traded share, pulled toward the global rate. */
function tokenOdds(snapshot: Snapshot, category: string | null, globalRate: number): number {
  const cat = category ?? 'Uncategorised';
  let total = 0;
  let traded = 0;
  for (const p of snapshot.protocols) {
    if ((p.category ?? 'Uncategorised') !== cat) continue;
    total++;
    if (!isPreToken(p)) traded++;
  }
  if (total === 0) return globalRate;
  return (traded + 8 * globalRate) / (total + 8);
}

/** The implied value and its four factors, from the snapshot's own figures. */
export function impliedValue(
  p: SnapshotProtocol,
  snapshot: Snapshot,
  fit: LogLogFit,
  globalRate: number,
): { implied: number; base: number; growthMult: number; maturityMult: number; pToken: number; age: number | null } {
  const age = ageDays(snapshot.as_of, p.listed_at);
  const base = Math.exp(fit.a + fit.b * Math.log(p.tvl_usd));
  const growth = Math.min(120, Math.max(-60, finite(p.change_7d, 0)));
  const growthMult = 1 + (growth / 100) * 0.5;
  const ageForModel = age ?? 365;
  const maturityMult = 0.6 + (Math.min(Math.max(ageForModel, 0), 1095) / 1095) * 0.4;
  const pToken = tokenOdds(snapshot, p.category, globalRate);
  return { implied: Math.max(1, Math.round(base * growthMult * maturityMult * pToken)), base, growthMult, maturityMult, pToken, age };
}

function depositFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  return 100;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Verdict from the implied value alone, with the rule stated in the dashboard. */
export function verdictFor(implied: number): FarmPlan['verdict'] {
  if (implied >= 10_000_000) return 'FARM';
  if (implied >= 2_000_000) return 'THIN';
  return 'SKIP';
}

export function farmPlan(p: SnapshotProtocol, age: number | null, implied: number): FarmPlan {
  const hold = holdDaysFor(age);
  const weeks = Math.ceil(hold / 7);
  const totalFees = 6 + 2 * weeks;
  return {
    deposit_usd: depositFor(p),
    setup_gas_usd: 6,
    weekly_gas_usd: 2,
    hold_days: hold,
    total_fees_usd: totalFees,
    verdict: verdictFor(implied),
  };
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's one action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, deposit: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${deposit} of USDC on ${name} (${chain}) and leave the position open.`;
  if (c.includes('dex') || c.includes('swap') || c.includes('leveraged farm')) return `Add $${deposit} of liquidity to the main pool of ${name} on ${chain} and leave it in place.`;
  if (c.includes('bridge')) return `Bridge $${deposit} of USDC through ${name} to ${chain} and use the funds inside its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${deposit} through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${deposit} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${deposit} on ${name} and take one market position.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return `Deposit $${deposit} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${deposit} through ${name} on ${chain} and hold the position.`;
  if (c.includes('rwa') || c.includes('yield')) return `Mint $${deposit} of the yield asset of ${name} on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${deposit} of cover from ${name} on ${chain} and keep the policy active.`;
  return `Deposit $${deposit} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** Seven steps, each an action with its cost and time, inside the gate's 20..600 chars. */
export function farmSteps(p: SnapshotProtocol, age: number | null, plan: FarmPlan): string[] {
  const chain = chainOf(p);
  const steps = [
    `Open a fresh wallet holding only the funds you plan to farm, and store its seed phrase offline, never in a screenshot or chat. Cost: nothing but the wallet. Time: 5 minutes.`,
    `${actionFor(p, plan.deposit_usd, chain)} Cost: $${plan.deposit_usd} of capital plus about $${plan.setup_gas_usd} of gas. Time: 15 minutes to set up.`,
    `Do one qualifying action each week — a deposit, a swap, a borrow, or a vote — so the wallet stays active. Cost: about $${plan.weekly_gas_usd} of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${plan.hold_days} days so the activity lands in more than one snapshot window. Cost: the $${plan.deposit_usd} stays in the position. Time: ${plan.hold_days} days.`,
    `Check the protocol's own points or rewards page from its official site before you withdraw, and claim only from a link it publishes. Cost: nothing to check, and never pay to claim. Time: 10 minutes.`,
    `Log the wallet, the dates, and every transaction hash, so you can repeat the position or unwind it without guessing. Cost: nothing but the log. Time: 5 minutes.`,
    `Verdict ${plan.verdict}: deposit $${plan.deposit_usd}, total fees about $${plan.total_fees_usd} over ${plan.hold_days} days. ${plan.verdict === 'FARM' ? 'This is one of the board’s strongest launches — farm it first.' : plan.verdict === 'THIN' ? 'Worth a small position only — keep the deposit modest and do not chase it.' : 'Not worth farming on value alone — skip it unless you already use the protocol.'} Cost: about $${plan.total_fees_usd} of fees in all. Time: ${plan.hold_days} days.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

/** The board: every rankable pre-token protocol, watchlist first in coverage, ranked by implied value. */
export function buildBoard(snapshot: Snapshot, validation: Validation): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => {
      const v = impliedValue(p, snapshot, validation.fit, validation.global_token_rate);
      const plan = farmPlan(p, v.age, v.implied);
      return { p, v, plan };
    })
    .sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : 1));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.v.age,
    token_status: 'pre-token' as const,
    watchlist: watch.has(s.p.slug),
    implied_value_usd: s.v.implied,
    model: {
      // Full precision: the dashboard recomputes the implied value from these
      // four factors, so rounding them here made its "matches the board" check
      // fail on 197 of 198 rows. fit_a/fit_b stay rounded; they are display only.
      loglog_base_usd: s.v.base,
      growth_multiplier: s.v.growthMult,
      maturity_multiplier: s.v.maturityMult,
      p_token: s.v.pToken,
      fit_a: round4(validation.fit.a),
      fit_b: round4(validation.fit.b),
    },
    farm: s.plan,
    farm_steps: farmSteps(s.p, s.v.age, s.plan),
  }));
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
    }));
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const validation = validate(snapshot);
  const board = buildBoard(snapshot, validation);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    scanned: snapshot.protocols.length,
    traded_anchors: snapshot.protocols.filter((p) => !isPreToken(p)).length,
    validation,
    rows: board,
    live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, fewer than 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  return null;
}

/** The dashboard's dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
