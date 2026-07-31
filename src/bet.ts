import { Futuur } from "futuur";
import type {
  CreateOrderBody,
  Currency,
  EventListParams,
  FuturEvent,
  Market,
  Position,
} from "futuur";

import { recordBet } from "./store.js";

/** Ceiling on a single order, whatever FUTUUR_BET_AMOUNT says. */
export const HARD_CAP = 1000;

/** Share of the budget actually spent on shares; the rest absorbs taker fees. */
const FEE_HEADROOM = 0.95;

/** Outcome statuses that can no longer be traded. */
const CLOSED_STATUSES = new Set(["closed", "resolved", "cancelled", "disabled"]);

export type Direction = "up" | "down";

/**
 * One side of one market. An hourly event may expose its two sides as two
 * markets, or as the long and short position of a single market, so a bet is
 * always a (market, position) pair rather than just a market.
 */
export interface Outcome {
  market: Market;
  position: Position;
  label: string;
  /** Why this side was chosen, for the log line and the API response. */
  reason: string;
  spot?: { price: number; source: string; priceToBeat: number; direction: Direction };
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing env var ${name}`);
  return value;
}

export const sdk = new Futuur({
  publicKey: env("FUTUUR_PUBLIC_KEY"),
  privateKey: env("FUTUUR_PRIVATE_KEY"),
  timeout: 15_000,
});

/** Per-call overrides for the env-var defaults. Anything omitted falls back to env. */
export interface BetOverrides {
  currency?: string;
  strategy?: string;
  amount?: number;
  dryRun?: boolean;
  /**
   * Defaults to a key derived from the event, so scheduler retries replay one bet.
   * Pass a fresh value to deliberately place another bet on the same market.
   */
  idempotencyKey?: string;
}

export async function placeBet(overrides: BetOverrides = {}) {
  const currency = (overrides.currency ?? env("FUTUUR_CURRENCY", "OOM")) as Currency;
  const strategy = overrides.strategy ?? env("FUTUUR_STRATEGY", "spot");
  const dryRun = overrides.dryRun ?? env("FUTUUR_DRY_RUN", "false") === "true";

  const balance = await walletBalance(currency);
  const stake = stakeFor(balance, overrides.amount);

  const event = await resolveEvent(currency);
  const outcome = await pickOutcome(event, currency, strategy);
  const sized = await sizeOrder(outcome, currency, stake.amount);

  // The API wants `shares`, not `amount` — an amount-only body comes back as
  // `KeyError: 'shares'`. And `price` is either a real number or absent: sending
  // `price: null` answers 401, because the SDK drops null params when building
  // the HMAC while axios still puts `"price": null` on the wire, so the server
  // signs one parameter more than the client did.
  const order: CreateOrderBody = {
    market: outcome.market.id,
    side: "bid",
    position: outcome.position,
    currency,
    shares: sized.shares,
    ...(sized.price === undefined ? {} : { price: sized.price }),
  };

  const context = {
    event: { id: event.id, slug: event.slug, betEndDate: event.bet_end_date },
    outcome: {
      id: outcome.market.id,
      title: outcome.market.title,
      label: outcome.label,
      position: outcome.position,
      price: priceOf(outcome, currency),
    },
    reason: outcome.reason,
    ...(outcome.spot ? { spot: outcome.spot } : {}),
    currency,
    balance,
    budget: stake.amount,
    staking: stake.reason,
    shares: sized.shares,
    limitPrice: sized.price ?? null,
    estimatedCost: sized.estimatedCost,
    strategy,
  };

  if (dryRun) {
    console.log("dry run, order not sent", { ...context, order });
    return { dryRun: true, ...context };
  }

  // bet_end_date is unique per hourly market, so a scheduler retry replays the
  // same bet instead of stacking a second one on top.
  const idempotencyKey =
    overrides.idempotencyKey ??
    `${event.id}:${outcome.market.id}:${outcome.position}:${event.bet_end_date}`;
  const created = await sdk.createOrder(order, { idempotencyKey });

  // Recording is best-effort: the bet is already placed, and losing the row is
  // worth less than throwing an error that makes a caller retry the order.
  const recorded = await recordBet({
    orderId: created.id,
    eventId: event.id,
    eventSlug: event.slug,
    betEndDate: event.bet_end_date!,
    marketId: outcome.market.id,
    position: outcome.position,
    label: outcome.label,
    strategy,
    reason: outcome.reason,
    spot: outcome.spot,
    currency,
    shares: sized.shares,
    limitPrice: sized.price ?? null,
    estimatedCost: sized.estimatedCost,
    budget: stake.amount,
    balanceBefore: balance,
  }).catch((error: unknown) => {
    console.error("bet placed but not recorded", error);
    return null;
  });

  console.log("order placed", { ...context, orderId: created.id, status: created.status });
  return {
    dryRun: false,
    orderId: created.id,
    status: created.status,
    recorded: recorded !== null,
    ...context,
  };
}

export type BetResult = Awaited<ReturnType<typeof placeBet>>;

/**
 * `futuur.com/markets/bitcoin-hourly` is a category page, not an event — and each
 * hourly edition is a separate event with its own ID. So the event is discovered at
 * run time: query by category, then by tag, then by free-text search, keeping the
 * first bettable Bitcoin event that closes inside the hourly window.
 */
export async function resolveEvent(currency: Currency): Promise<FuturEvent> {
  const categories = numberList(process.env.FUTUUR_CATEGORY_IDS);
  const tag = process.env.FUTUUR_EVENT_TAG?.trim();
  const search = env("FUTUUR_SEARCH", "bitcoin hourly");

  const queries: EventListParams[] = [
    ...(categories.length > 0 ? [{ categories }] : []),
    ...(tag ? [{ tag }] : []),
    { search },
  ];

  // Queries widen from precise to loose; keep everything seen so a later, looser
  // query can still be satisfied by an earlier, better-targeted result.
  const seen = new Map<number, FuturEvent>();

  for (const query of queries) {
    const { results } = await sdk.listEvents({
      ...query,
      currency_mode: currency === "OOM" ? "play_money" : "real_money",
      ordering: "bet_end_date",
      limit: 50,
    });
    for (const event of results) seen.set(event.id, event);

    const hit = pickHourlyEvent([...seen.values()]);
    if (hit) return hit;
  }

  // Nothing matched: log what the API actually returned so the filters can be
  // tuned from one log line instead of a second deploy.
  console.error("no hourly event matched", {
    queries,
    candidates: [...seen.values()].map((e) => ({
      id: e.id,
      slug: e.slug,
      title: e.title,
      status: e.status,
      betEndDate: e.bet_end_date,
    })),
  });
  throw new Error(`No open hourly event found (searched ${seen.size} candidates)`);
}

/** Soonest-closing bettable event that looks like the Bitcoin hourly market. */
function pickHourlyEvent(events: FuturEvent[]): FuturEvent | undefined {
  const titleMatch = new RegExp(env("FUTUUR_TITLE_MATCH", "bitcoin|btc"), "i");
  const windowMinutes = Number(env("FUTUUR_WINDOW_MINUTES", "70"));
  const deadline = Date.now() + windowMinutes * 60_000;

  return events
    .filter(isBettable)
    .filter((e) => titleMatch.test(e.title) || titleMatch.test(e.slug))
    // Hourly editions resolve on the hour, so a later close means a different market.
    .filter((e) => Date.parse(e.bet_end_date!) <= deadline)
    .sort((a, b) => Date.parse(a.bet_end_date!) - Date.parse(b.bet_end_date!))
    .at(0);
}

function isBettable(event: FuturEvent): boolean {
  if (event.status !== "open" || event.is_wagerable === false) return false;
  if (!event.bet_end_date) return false;
  return Date.parse(event.bet_end_date) > Date.now();
}

function numberList(value: string | undefined): number[] {
  if (!value?.trim()) return [];
  const ids = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id));
  return ids;
}

async function pickOutcome(
  event: FuturEvent,
  currency: Currency,
  strategy: string,
): Promise<Outcome> {
  const sides = listSides(event.markets, currency);
  if (sides.length === 0) {
    throw new Error(`No outcome priced in ${currency} on this event`);
  }

  if (strategy === "spot") return pickBySpot(event, sides, currency);
  return pickByPrice(sides, currency, strategy);
}

/**
 * Every tradable (market, position) pair on the event. Both shapes an hourly
 * event can take are covered: two markets each bet long, or one market bet long
 * for up and short for down.
 */
export function listSides(markets: Market[], currency: Currency): Omit<Outcome, "reason">[] {
  const sides: Omit<Outcome, "reason">[] = [];
  for (const market of markets) {
    if (typeof market.price?.[currency] !== "number") continue;
    if (CLOSED_STATUSES.has(market.status ?? "")) continue;

    sides.push({ market, position: "long", label: market.long_label ?? market.title });
    if (market.short_label) {
      sides.push({ market, position: "short", label: market.short_label });
    }
  }
  return sides;
}

/**
 * Bets the direction the spot price already points at: above the event's price to
 * beat means up, below means down. This deliberately ignores the odds — the point
 * is to fade a favourite that disagrees with the current price.
 */
async function pickBySpot(
  event: FuturEvent,
  sides: Omit<Outcome, "reason">[],
  currency: Currency,
): Promise<Outcome> {
  const priceToBeat = parsePriceToBeat(event);
  const { price, source } = await fetchBtcSpot();
  const direction: Direction = price >= priceToBeat ? "up" : "down";
  const spot = { price, source, priceToBeat, direction };

  const comparison = direction === "up" ? "above" : "below";
  const reason = `spot ${price} (${source}) is ${comparison} the ${priceToBeat} price to beat`;

  const named = sides.find((side) => labelMeans(side.label, direction));
  if (named) return { ...named, reason, spot };

  // The labels do not name a direction — the hourly market's title covers both
  // sides at once. Futuur's convention is that long is the event happening, so
  // long is up and short is down.
  const side = sides[0]!;
  console.log("no directional label, falling back to long=up / short=down", {
    labels: sides.map((s) => `${s.position}:${s.label}`),
  });
  return {
    market: side.market,
    position: direction === "up" ? "long" : "short",
    label: direction,
    reason: `${reason}; label fallback long=up/short=down`,
    spot,
  };
}

/** `favorite` / `underdog` pick by price; anything else matches a side's label. */
function pickByPrice(
  sides: Omit<Outcome, "reason">[],
  currency: Currency,
  strategy: string,
): Outcome {
  if (strategy !== "favorite" && strategy !== "underdog") {
    const wanted = strategy.trim().toLowerCase();
    const named = sides.find((side) =>
      [side.label, side.market.title].some((l) => l?.trim().toLowerCase() === wanted),
    );
    if (!named) {
      const labels = sides.map((s) => s.label).join(", ");
      throw new Error(`No outcome named "${strategy}". Available: ${labels}`);
    }
    return { ...named, reason: `label match "${strategy}"` };
  }

  const byPrice = [...sides].sort(
    (a, b) => priceOf(b, currency) - priceOf(a, currency),
  );
  const picked = strategy === "favorite" ? byPrice[0]! : byPrice[byPrice.length - 1]!;
  return { ...picked, reason: `${strategy} at ${priceOf(picked, currency)}` };
}

/** A short position is priced as the complement of the market's long price. */
export function priceOf(side: Omit<Outcome, "reason">, currency: Currency): number {
  const long = side.market.price[currency]!;
  return side.position === "long" ? long : round2(1 - long);
}

/** True when the label names this direction and only this direction. */
export function labelMeans(label: string, direction: Direction): boolean {
  const up = /\bup\b/i.test(label);
  const down = /\bdown\b/i.test(label);
  // "Bitcoin Up or Down: ..." mentions both, so it identifies neither side.
  if (up === down) return false;
  return direction === "up" ? up : down;
}

/** "Bitcoin Up or Down: Price to beat $64,702.80 - 1 hr" → 64702.8 */
export function parsePriceToBeat(event: FuturEvent): number {
  const fromTitle = /price to beat\s*\$?\s*([\d,]+(?:\.\d+)?)/i.exec(event.title);
  if (fromTitle) {
    const value = Number(fromTitle[1]!.replaceAll(",", ""));
    if (Number.isFinite(value) && value > 0) return value;
  }

  // The slug carries the same figure in cents: `…-price-to-beat-6470280-1-hr`.
  const fromSlug = /price-to-beat-(\d+)/.exec(event.slug);
  if (fromSlug) {
    const value = Number(fromSlug[1]) / 100;
    if (Number.isFinite(value) && value > 0) return value;
  }

  throw new Error(`Cannot read a price to beat from "${event.title}" (${event.slug})`);
}

/**
 * Public spot quotes, tried in order. They disagree by tens of dollars, so a spot
 * that sits within that of the price to beat makes the direction a coin flip —
 * the source is logged with every bet for exactly that reason.
 */
const SPOT_SOURCES: { name: string; url: string; read: (body: unknown) => number }[] = [
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    read: (body) => toNumber(dig(body, "data", "amount")),
  },
  {
    name: "binance",
    url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
    read: (body) => toNumber(dig(body, "price")),
  },
  {
    name: "kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    read: (body) => toNumber(dig(body, "result", "XXBTZUSD", "c", 0)),
  },
];

export async function fetchBtcSpot(): Promise<{ price: number; source: string }> {
  const failures: string[] = [];

  for (const source of SPOT_SOURCES) {
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const price = source.read(await response.json());
      if (!Number.isFinite(price) || price <= 0) throw new Error(`unusable price ${price}`);

      return { price, source: source.name };
    } catch (error) {
      failures.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`No BTC spot price available — ${failures.join("; ")}`);
}

function dig(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function toNumber(value: unknown): number {
  return typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
}

/**
 * Turns a budget into a share count. Walks the ask side of the book taking what
 * the budget affords at each level, and prices the order at the deepest level
 * touched so it crosses the spread and fills right away. Falls back to a market
 * order — no `price` key — when the book is empty or unreadable.
 */
export async function sizeOrder(
  outcome: Outcome,
  currency: Currency,
  budget: number,
): Promise<{ shares: number; price?: number; estimatedCost: number }> {
  const quoted = priceOf(outcome, currency);
  // Leave room for taker fees, which are charged on top of the share cost.
  const spendable = budget * FEE_HEADROOM;

  // The book is per position, so a short bet has to read the short side of it.
  const book = await sdk
    .getOrderBook(outcome.market.id, {
      currency_mode: currency === "OOM" ? "play_money" : "real_money",
      position: outcome.position,
    })
    .catch((error: unknown) => {
      console.warn("order book unavailable, sizing off the quoted price", error);
      return null;
    });

  let shares = 0;
  let spent = 0;
  let limit: number | undefined;

  for (const level of book?.ask ?? []) {
    const affordable = Math.floor((spendable - spent) / level.price);
    const take = Math.min(affordable, Math.floor(level.total_shares));
    if (take < 1) break;

    shares += take;
    spent += take * level.price;
    limit = level.price;
  }

  if (shares >= 1 && limit !== undefined) {
    return { shares, price: limit, estimatedCost: round2(spent) };
  }

  // Nothing on the book to cross: send a market order sized off the quoted price.
  const marketShares = Math.floor(spendable / quoted);
  if (marketShares < 1) {
    throw new Error(`Budget ${budget} ${currency} buys less than one share at ${quoted}`);
  }
  return { shares: marketShares, estimatedCost: round2(marketShares * quoted) };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function walletBalance(currency: Currency): Promise<number> {
  const balances = await sdk.balances({ currency });
  const match = balances.find((b) => b.currency.toUpperCase() === currency.toUpperCase());
  const available = Number(match?.amount ?? 0);

  if (!Number.isFinite(available) || available <= 0) {
    throw new Error(`No ${currency} balance to bet with (available ${available})`);
  }
  return round2(available);
}

/**
 * Stake is a fixed fraction of the bankroll, so it grows as the wallet grows and
 * shrinks after a losing run without any manual step. Clamped between
 * FUTUUR_MIN_STAKE and FUTUUR_MAX_STAKE, and never above HARD_CAP or the balance.
 *
 * An explicit `amount` override skips the fraction but keeps every clamp.
 */
export function stakeFor(balance: number, override?: number): { amount: number; reason: string } {
  const fraction = Number(env("FUTUUR_STAKE_FRACTION", "0.02"));
  const min = Number(env("FUTUUR_MIN_STAKE", "10"));
  // The ceiling is a share of the bankroll, not a fixed number, so it grows with
  // winnings and shrinks after losses. A fixed cap set above half the bankroll is a
  // ruin risk: two bad calls at the cap and there is nothing left to bet with.
  const maxFraction = Number(env("FUTUUR_MAX_STAKE_FRACTION", "0.05"));
  const max = Math.min(
    balance * maxFraction,
    Number(env("FUTUUR_MAX_STAKE", String(HARD_CAP))),
    HARD_CAP,
  );

  if (!(fraction > 0 && fraction <= 1)) {
    throw new Error(`FUTUUR_STAKE_FRACTION must be in (0, 1], got "${fraction}"`);
  }
  if (!(min > 0) || !(max >= min)) {
    throw new Error(`Stake bounds are unusable: min ${min}, max ${max}`);
  }

  if (override !== undefined) {
    if (!Number.isFinite(override) || override <= 0) {
      throw new Error(`Bet amount must be a positive number, got "${override}"`);
    }
    const amount = clampStake(override, min, max, balance);
    return { amount, reason: `override ${override} clamped to ${amount}` };
  }

  const target = balance * fraction;
  const amount = clampStake(target, min, max, balance);
  return {
    amount,
    reason:
      `${fraction} of ${balance} = ${round2(target)}, clamped to ${amount} ` +
      `(min ${min}, max ${round2(max)} = ${maxFraction} of bankroll)`,
  };
}

function clampStake(target: number, min: number, max: number, balance: number): number {
  const amount = Math.floor(Math.min(Math.max(target, min), max, balance) * 100) / 100;
  if (amount < min) {
    throw new Error(`Balance ${balance} cannot cover the ${min} minimum stake`);
  }
  return amount;
}
