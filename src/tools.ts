import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Currency, FuturEvent, Position } from "futuur";

import {
  fetchBtcSpot,
  listSides,
  parsePriceToBeat,
  priceOf,
  resolveEvent,
  sdk,
  stakeFor,
  walletBalance,
} from "./bet.js";
import type { Direction, Outcome } from "./bet.js";
import { listBets, putNote, recordBet, summarise } from "./store.js";

/** Everything the tools need that is fixed for one run of the agent. */
export interface AgentContext {
  currency: Currency;
  /** Wall-clock ms after which the agent must stop working. */
  deadline: number;
  event: FuturEvent;
  /** Orders the agent placed this run, so the handler knows whether to fall back. */
  placed: { orderId: number; direction: Direction; shares: number; cost: number }[];
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** Seconds until the market stops accepting bets. */
function secondsToClose(event: FuturEvent): number {
  return Math.round((Date.parse(event.bet_end_date!) - Date.now()) / 1000);
}

/**
 * Maps a direction onto a (market, position) pair. Hourly events use one market
 * with `long_label: "Up"` / `short_label: "Down"`, but the label match is kept so
 * a two-market edition also works.
 */
function sideFor(
  event: FuturEvent,
  currency: Currency,
  direction: Direction,
): Omit<Outcome, "reason"> {
  const sides = listSides(event.markets, currency);
  if (sides.length === 0) throw new Error(`No outcome priced in ${currency}`);

  const named = sides.find((side) => {
    const up = /\bup\b/i.test(side.label);
    const down = /\bdown\b/i.test(side.label);
    if (up === down) return false;
    return direction === "up" ? up : down;
  });
  if (named) return named;

  // No directional label: Futuur's convention is long = the event happening.
  const side = sides[0]!;
  return {
    market: side.market,
    position: direction === "up" ? "long" : "short",
    label: direction,
  };
}

/** Wagers reference their market by URL, so the id has to be pulled out of it. */
function marketIdOf(marketUrl: string): number | undefined {
  const match = /\/markets\/(\d+)/.exec(marketUrl);
  return match ? Number(match[1]) : undefined;
}

export function buildTools(context: AgentContext) {
  const { currency } = context;
  const currencyMode = currency === "OOM" ? "play_money" : "real_money";

  /** Re-reads the event so prices are current rather than from the run's start. */
  const freshEvent = async () => {
    context.event = await resolveEvent(currency).catch(() => context.event);
    return context.event;
  };

  const getMarket = betaZodTool({
    name: "get_market",
    description:
      "Current state of the hourly Bitcoin market: the price to beat, both sides with " +
      "their prices, and how many seconds remain before betting closes. Prices move, so " +
      "re-read this before deciding rather than relying on an earlier call.",
    inputSchema: z.object({}),
    run: async () => {
      const event = await freshEvent();
      const sides = listSides(event.markets, currency).map((side) => ({
        direction: /\bdown\b/i.test(side.label) ? "down" : "up",
        label: side.label,
        position: side.position,
        marketId: side.market.id,
        price: priceOf(side, currency),
      }));

      return json({
        eventId: event.id,
        title: event.title,
        priceToBeat: parsePriceToBeat(event),
        closesAt: event.bet_end_date,
        secondsToClose: secondsToClose(event),
        secondsOfBudgetLeft: Math.round((context.deadline - Date.now()) / 1000),
        sides,
      });
    },
  });

  const getSpot = betaZodTool({
    name: "get_spot",
    description:
      "Current BTC/USD spot price from Coinbase, Binance and Kraken, with each one's gap " +
      "against the market's price to beat. The sources disagree by tens of dollars, so a " +
      "gap smaller than that spread is not a signal.",
    inputSchema: z.object({}),
    run: async () => {
      const priceToBeat = parsePriceToBeat(context.event);
      const primary = await fetchBtcSpot();

      const all = await Promise.all(
        [
          ["coinbase", "https://api.coinbase.com/v2/prices/BTC-USD/spot"],
          ["binance", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"],
          ["kraken", "https://api.kraken.com/0/public/Ticker?pair=XBTUSD"],
        ].map(async ([name, url]) => {
          try {
            const body = (await (
              await fetch(url!, { signal: AbortSignal.timeout(5_000) })
            ).json()) as Record<string, any>;
            const price = Number(
              name === "coinbase"
                ? body.data?.amount
                : name === "binance"
                  ? body.price
                  : body.result?.XXBTZUSD?.c?.[0],
            );
            return { source: name, price, gap: round2(price - priceToBeat) };
          } catch (error) {
            return { source: name, error: String(error) };
          }
        }),
      );

      return json({ priceToBeat, primary, sources: all });
    },
  });

  const getOrderBook = betaZodTool({
    name: "get_order_book",
    description:
      "Order book for one side. `ask` levels are what you pay to buy; `bid` levels are " +
      "what you receive when selling. Use it to check there is enough depth before sizing.",
    inputSchema: z.object({
      direction: z.enum(["up", "down"]).describe("Which side of the market to read"),
    }),
    run: async ({ direction }) => {
      const side = sideFor(context.event, currency, direction as Direction);
      const book = await sdk.getOrderBook(side.market.id, {
        currency_mode: currencyMode,
        position: side.position,
      });
      return json({
        direction,
        position: side.position,
        ask: book.ask?.slice(0, 8),
        bid: book.bid?.slice(0, 8),
      });
    },
  });

  const getPositions = betaZodTool({
    name: "get_positions",
    description:
      "Your wallet balance, the shares you already hold on this event, and any orders " +
      "still sitting unfilled on the book.",
    inputSchema: z.object({}),
    run: async () => {
      const [balance, wagers, orders] = await Promise.all([
        walletBalance(currency),
        sdk
          .listWagers({ event: context.event.id, currency_mode: "", limit: 50 })
          .then((r) => r.results)
          .catch(() => []),
        sdk
          .listOrders({ event: context.event.id, status: "open", limit: 50 })
          .then((r) => r.results)
          .catch(() => []),
      ]);

      return json({
        balance,
        currency,
        placedThisRun: context.placed,
        holdings: wagers.map((w) => ({
          wagerId: w.id,
          marketId: marketIdOf(w.market),
          position: w.position,
          status: w.status,
          shares: w.shares,
          amountOnSell: w.amount_on_sell,
          amountOnWin: w.amount_on_win,
          roi: w.roi,
        })),
        openOrders: orders.map((o) => ({
          orderId: o.id,
          position: o.position,
          side: o.side,
          price: o.price,
          shares: o.shares,
          sharesFilled: o.shares_filled,
        })),
      });
    },
  });

  const getHistory = betaZodTool({
    name: "get_history",
    description:
      "Your own past bets and their settled results, plus win rate and net earnings " +
      "broken down by strategy and by direction. This is the only evidence you have " +
      "about what actually works — read it before your first bet of the run.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).optional().describe("How many bets, newest first"),
    }),
    run: async ({ limit }) => {
      // The default is deliberately small: this is the largest tool result in the
      // run, and it is carried in every later turn's input.
      const bets = await listBets(limit ?? 20);
      return json({
        stats: summarise(bets),
        bets: bets.map((b) => ({
          placedAt: b.placedAt,
          status: b.status,
          label: b.label,
          position: b.position,
          strategy: b.strategy,
          shares: b.shares,
          limitPrice: b.limitPrice,
          cost: b.estimatedCost,
          earnings: b.earnings,
          spot: b.spot,
          reason: b.reason,
        })),
      });
    },
  });

  const placeBetTool = betaZodTool({
    name: "place_bet",
    description:
      "Buy shares on one side. `amount` is the budget in wallet currency; the actual " +
      "share count is derived by walking the ask book so the cost stays inside it. The " +
      "amount is clamped by the configured minimum, maximum, hard cap, and your balance " +
      "— asking for more than the cap silently gets you the cap, not an error. You may " +
      "call this more than once in a run to add to a position.",
    inputSchema: z.object({
      direction: z.enum(["up", "down"]),
      amount: z.number().positive().describe("Budget to stake, in wallet currency"),
      reasoning: z
        .string()
        .min(1)
        .describe("Why this side and this size, in one or two sentences. Stored with the bet."),
    }),
    run: async ({ direction, amount, reasoning }) => {
      const event = await freshEvent();
      const remaining = secondsToClose(event);
      if (remaining <= 5) {
        return json({ placed: false, error: `market closes in ${remaining}s — too late` });
      }

      const balance = await walletBalance(currency);
      const stake = stakeFor(balance, amount);
      const side = sideFor(event, currency, direction as Direction);
      const sized = await sizeOrderFor(side, currency, stake.amount);

      const created = await sdk.createOrder(
        {
          market: side.market.id,
          side: "bid",
          position: side.position,
          currency,
          shares: sized.shares,
          ...(sized.price === undefined ? {} : { price: sized.price }),
        },
        // Direction plus a per-call counter, so a second deliberate bet on the same
        // side is not swallowed as a replay of the first.
        { idempotencyKey: `${event.id}:${side.position}:${context.placed.length}` },
      );

      context.placed.push({
        orderId: created.id,
        direction: direction as Direction,
        shares: sized.shares,
        cost: sized.estimatedCost,
      });

      await recordBet({
        orderId: created.id,
        eventId: event.id,
        eventSlug: event.slug,
        betEndDate: event.bet_end_date!,
        marketId: side.market.id,
        position: side.position,
        label: side.label,
        strategy: "claude",
        reason: reasoning,
        spot: await spotSnapshot(event, direction as Direction),
        currency,
        shares: sized.shares,
        limitPrice: sized.price ?? null,
        estimatedCost: sized.estimatedCost,
        budget: stake.amount,
        balanceBefore: balance,
      }).catch((error: unknown) => {
        console.error("bet placed but not recorded", error);
      });

      return json({
        placed: true,
        orderId: created.id,
        status: created.status,
        direction,
        position: side.position,
        shares: sized.shares,
        limitPrice: sized.price ?? null,
        estimatedCost: sized.estimatedCost,
        requestedAmount: amount,
        clamped: stake.reason,
        secondsToClose: secondsToClose(event),
      });
    },
  });

  const sellTool = betaZodTool({
    name: "sell",
    description:
      "Sell shares you already hold, priced against the bid book so it fills. Use it to " +
      "cut a position the price has moved against, or to take profit before resolution. " +
      "Check get_positions for the share count you actually hold.",
    inputSchema: z.object({
      direction: z.enum(["up", "down"]).describe("Which side you are selling out of"),
      shares: z.number().positive().describe("How many shares to sell"),
      reasoning: z.string().min(1).describe("Why you are selling. Stored as a note."),
    }),
    run: async ({ direction, shares, reasoning }) => {
      const side = sideFor(context.event, currency, direction as Direction);
      const book = await sdk.getOrderBook(side.market.id, {
        currency_mode: currencyMode,
        position: side.position,
      });

      // Walk down the bid side until the requested size is covered; the deepest
      // level touched becomes the limit so the whole order crosses.
      let covered = 0;
      let limit: number | undefined;
      for (const level of book.bid ?? []) {
        covered += Math.floor(level.total_shares);
        limit = level.price;
        if (covered >= shares) break;
      }
      if (limit === undefined) {
        return json({ sold: false, error: "no bids to sell into" });
      }

      const sellable = Math.min(Math.floor(shares), covered);
      if (sellable < 1) return json({ sold: false, error: "bid depth below one share" });

      const created = await sdk.createOrder(
        {
          market: side.market.id,
          side: "ask",
          position: side.position,
          currency,
          shares: sellable,
          price: limit,
        },
        { idempotencyKey: `sell:${context.event.id}:${side.position}:${Date.now()}` },
      );

      await putNote(`Sold ${sellable} ${direction} shares @ ${limit}: ${reasoning}`, [
        "sell",
        direction,
      ]).catch(() => undefined);

      return json({
        sold: true,
        orderId: created.id,
        status: created.status,
        shares: sellable,
        limitPrice: limit,
        requestedShares: shares,
      });
    },
  });

  const cancelOrders = betaZodTool({
    name: "cancel_open_orders",
    description:
      "Cancel every order of yours still unfilled on this event. Orders that were " +
      "mid-fill come back as `processing` and may still complete.",
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("Why you are cancelling"),
    }),
    run: async ({ reasoning }) => {
      const result = await sdk.cancelAllOrders({ event: context.event.id });
      console.log("cancelled open orders", { reasoning, result });
      return json(result);
    },
  });

  const writeNote = betaZodTool({
    name: "write_note",
    description:
      "Save a lesson for future runs. Future you reads these before betting, so write " +
      "what you would want to know: a rule that held, a threshold that turned out to be " +
      "noise, a pattern in the settled results. One lesson per note, and say why it " +
      "mattered. Do not restate what get_history already shows.",
    inputSchema: z.object({
      text: z.string().min(1),
      tags: z.array(z.string()).optional(),
    }),
    run: async ({ text, tags }) => json(await putNote(text, tags ?? [])),
  });

  const wait = betaZodTool({
    name: "wait",
    description:
      "Pause, then continue. Use it to let the price move before committing, or to hold " +
      "a position and re-check closer to resolution. Capped so it never runs past your " +
      "budget — the result tells you how long you actually waited and what is left.",
    inputSchema: z.object({
      seconds: z.number().int().min(1).max(600),
      reasoning: z.string().min(1).describe("What you are waiting for"),
    }),
    run: async ({ seconds, reasoning }) => {
      // Keep a floor of headroom so a wait can never eat the time needed to act.
      const headroom = Math.max(0, context.deadline - Date.now() - 30_000);
      const slept = Math.min(seconds * 1000, headroom);

      if (slept <= 0) {
        return json({ waited: 0, reason: "no budget left to wait — act or finish now" });
      }
      await new Promise((resolve) => setTimeout(resolve, slept));

      const event = await freshEvent();
      return json({
        waited: Math.round(slept / 1000),
        requested: seconds,
        reasoning,
        secondsToClose: secondsToClose(event),
        secondsOfBudgetLeft: Math.round((context.deadline - Date.now()) / 1000),
      });
    },
  });

  return [
    getMarket,
    getSpot,
    getOrderBook,
    getPositions,
    getHistory,
    placeBetTool,
    sellTool,
    cancelOrders,
    writeNote,
    wait,
  ];
}

/** Same book-walking sizer as the deterministic path, but for a bare side. */
async function sizeOrderFor(
  side: Omit<Outcome, "reason">,
  currency: Currency,
  budget: number,
): Promise<{ shares: number; price?: number; estimatedCost: number }> {
  const { sizeOrder } = await import("./bet.js");
  return sizeOrder({ ...side, reason: "agent" }, currency, budget);
}

async function spotSnapshot(
  event: FuturEvent,
  direction: Direction,
): Promise<{ price: number; source: string; priceToBeat: number; direction: Direction }> {
  const priceToBeat = parsePriceToBeat(event);
  const { price, source } = await fetchBtcSpot();
  return { price, source, priceToBeat, direction };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type { Position };
