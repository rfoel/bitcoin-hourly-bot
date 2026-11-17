# bitcoin-hourly

Bets the Futuur [Bitcoin Up or Down — 5 min](https://futuur.com/q/254977/bitcoin-up-or-down-price-to-beat-6516700-5-min)
market — and its Ethereum and Solana twins — with play money, in the last seconds of
each window, and records every round so the run can be audited afterwards.

Live at **[bitcoin.rfoel.dev](https://bitcoin.rfoel.dev)**.

This repo started as a Claude agent trading the hourly market. That agent's code and
history are still here (the old dashboard is at `/hourly`), but nothing schedules it any
more — see [The hourly agent](#the-hourly-agent) below.

## The 5-minute bot

`src/fivemin.ts`, on `cron(4/5 * * * ? *)` — minute 4 of every 5-minute window, one
minute before the close. Each run:

1. **Settles** every pending round that has resolved, with Futuur's own P&L off the wager,
   and credits it back to the ledger. Pending rounds are found through a marker item
   per round (`pk PENDING#<rounds pk>`), not by filtering days of rounds.
2. **Finds** the open event in the asset's category closing within the window, and
   **splits the wallet** between the assets in proportion to their ledgers.
3. **Warms up** 3 seconds before deciding: fetches volatility and touches both books,
   which also opens the TLS connections to Binance and Futuur.
4. **Reads**, at `FIVEMIN_DECIDE_AT` (15) seconds before the close and in one round
   trip, the pair's Binance 5m candle in progress — the exact candle Futuur settles
   on — and the book of both sides. The candle's open must equal the event's price to
   beat (the line check, within 0.0015% of the price), and its latest close is where
   the market would settle right now.
5. **Decides**: the side spot is on, with a probability from a driftless walk over the
   seconds left (`src/edge.ts`, volatility from 5-second returns over the last 15
   minutes × `FIVEMIN_VOL_MULT`). Below `FIVEMIN_MIN_PROB` it skips.
6. **Sizes** by walking the ask ladder (`src/plan.ts`): only levels at least
   `FIVEMIN_MIN_EDGE` below the probability, capped by half Kelly on the running
   average price. That is about half the bankroll near certainty and under a third at
   80% — in practice the ladder's depth binds long before Kelly does once the bankroll
   has grown.
7. **Bets** with one limit order at the deepest level touched, and **records** the round,
   including `readMs`, `orderMs` and `secondsLeftAtOrder` — the numbers to tune
   `FIVEMIN_DECIDE_AT` with.

### Assets

The same product exists for three pairs, and the bot plays all of them (`src/assets.ts`):

| Asset | Futuur category | Binance pair | Ledger (`pk FIVEMIN`) | Rounds | Dashboard |
| --- | --- | --- | --- | --- | --- |
| Bitcoin | 3728 `bitcoin-5min` | BTCUSDT | `sk STATE` | `pk ROUND5` | `/` |
| Ethereum | 3729 `ethereum-5min` | ETHUSDT | `sk STATE#ETH` | `pk ROUND5#ETH` | `/eth` |
| Solana | 3731 `solana-5min` | SOLUSDT | `sk STATE#SOL` | `pk ROUND5#SOL` | `/sol` |

Their windows close at the same instant, so **one invocation plays them all side by
side** — the waits overlap, and there is one Lambda run per window instead of three. Each
asset is isolated: its own ledger, its own rounds, and a failure in one does not cost the
others their round. They share the Futuur wallet and bet at the same instant, so the
wallet is split between them in proportion to their ledgers (`allocate` in
`src/plan.ts`): each round stakes at most `min(its ledger's bankroll, its slice)`, and
no two assets can count the same money.

`FIVEMIN_ASSETS` (`btc,eth,sol`) picks which ones run. Every other setting below is
shared by all of them.

### Why the end of the window

Watched live, Futuur's book on this market is a static ladder centred on 0.50 —
`0.51 × 577`, `0.52 × 1155`, … up to `0.99` — that does not reprice as BTC moves. With
10 seconds left and spot $62 above the line it was still selling "Up" at 0.51. There are
no fees (`get_tax` is null). Events open about a minute into their window and resolve
about a minute after the close.

### Budget

Each asset keeps its own ledger (`pk FIVEMIN`, `sk STATE` for Bitcoin — see
[Assets](#assets)), seeded once from `FIVEMIN_BUDGET` = **10,000 OOM**. A bet's cost is held out of the bankroll until it
settles, then the cost plus Futuur's P&L comes back. A round never stakes more than
`min(ledger bankroll, wallet slice) × FIVEMIN_MAX_FRACTION` — `1`, so all-in is allowed.

To start an asset over with a fresh budget, delete its ledger item; the next run
re-seeds it.

### Checking progress

Every round is written to the asset's rounds partition, `sk <close time>` — bets and skips alike, with
the line, spot, gap, seconds left, probability, plan, order id, fill, P&L and bankroll
after.

| Where | What |
| --- | --- |
| `GET /`, `/eth`, `/sol` | One asset's ledger and every round, refreshing every 30s |
| `GET /rounds?asset=eth&limit=N` | The same as JSON (default Bitcoin, 288 = one day) |
| CloudWatch, `FiveMinuteBitcoinBet` | `bet placed` / `skipped` / `settled` log lines per run, for every asset |

### Configuration

| Var | Default | Meaning |
| --- | --- | --- |
| `FIVEMIN_ASSETS` | `btc,eth,sol` | Which assets to play |
| `FIVEMIN_BUDGET` | `10000` | Starting bankroll of each asset, only read when its ledger is created |
| `FIVEMIN_DECIDE_AT` | `15` | Seconds before the close to decide |
| `FIVEMIN_LATEST_AT` | `4` | Skip if fewer seconds than this are left |
| `FIVEMIN_MIN_PROB` | `0.7` | Skip below this probability for the favoured side |
| `FIVEMIN_MIN_EDGE` | `0.05` | Only buy levels at least this far below the probability |
| `FIVEMIN_MAX_FRACTION` | `1` | Share of the bankroll one round may stake |
| `FIVEMIN_KELLY` | `0.5` | Kelly multiplier; `1` is full Kelly |
| `FIVEMIN_VOL_MULT` | `1.5` | Safety factor on realised volatility |

### Calibrating the model

`node scripts/backtest-5min.mjs <btc|eth|sol> [limit]` re-prices every recorded round
with the old (1h of 1m) and new (15 min of 1s) volatility under several multipliers, and
checks each against the real 5m close: Brier score, log loss, and predicted vs observed
win rate per probability bucket. A bucket that wins less often than predicted is where
the bot overbets.

`pnpm test` runs the unit tests (`test/`, Node's built-in runner) for the order planner,
the wallet split and the probability model.
| `FIVEMIN_DRY_RUN` | `false` | Record what it would bet without placing an order |

## The hourly agent

Everything from here down describes the earlier hourly agent. Its crons
(`HourlyBitcoinBet`, `SettleBets`, `CompactNotes`) were removed from `sst.config.ts`
when the bot moved to the 5-minute market; the code is kept for its history.

Every hour at `:53` a Lambda woke Claude with tools for the market, both order books,
the spot price, Polymarket's real-money price for the same hour, its own settled results
and its notes. It had the rest of the hour to work: read, wait, bet, add, sell, or pass.
At `:06` a second Lambda reconciled the previous hour's bets against Futuur and wrote
the results back. At `:20` a third rewrote the notes into a shorter set.

## Architecture

```
:53  HourlyBitcoinBet ──▶ Claude agent loop ───────────┐
                          10 tools, bets/sells/passes  │
                                                       ├──▶ DynamoDB "Memory"
:06  SettleBets ──────▶ reconcile wagers → win/loss ───┤     BET / RUN / NOTE
                                                       │
:20  CompactNotes ────▶ rewrite notes, archive old ────┤
                                                       │
     bitcoin.rfoel.dev ──▶ dashboard + JSON ───────────┘
```

| File | Role |
| --- | --- |
| `src/agent.ts` | The agent loop: system prompt, token budget, usage accounting |
| `src/tools.ts` | The 10 tools Claude drives the market with |
| `src/bet.ts` | Futuur mechanics — event discovery, sizing, order placement |
| `src/polymarket.ts` | The same hour priced in real money on Polymarket, plus the line check |
| `src/settle.ts` | Hourly reconciliation of placed bets against their wagers |
| `src/compact.ts` | Rewrites the notes into a shorter set, with a validation gate |
| `src/store.ts` | DynamoDB access, cost model, stats |
| `src/ui.ts` | Server-rendered dashboard |
| `src/api.ts` | HTTP routing for the dashboard and the JSON endpoints |

Lambda `nodejs24.x` on arm64, region `sa-east-1`.

## Setup

```bash
pnpm install
pnpm sst secret set FutuurPublicKey  <your-public-key>  --stage production
pnpm sst secret set FutuurPrivateKey <your-private-key> --stage production
pnpm sst secret set ApiToken "$(openssl rand -hex 32)"  --stage production
pnpm sst secret set Domain           <dashboard-hostname>  --stage production
pnpm sst deploy --stage production
```

Secrets are per stage. Without `ApiToken` the two write endpoints reject everything;
the dashboard and the read endpoints do not need it.

### Domain

The dashboard's hostname is the `Domain` value — not a secret, but SST's mechanism for a
per-stage config value. It has no default, so every stage states its own and a deploy can
never inherit another stage's DNS record:

```bash
pnpm sst secret set Domain bitcoin.example.com --stage production
```

`sst deploy` fails with `Set a value for Domain` until it is set. The hosted zone must
already exist in Route 53 on the same AWS account; SST issues the certificate and writes
the records.

## How the agent decides

Claude gets `claude-opus-5` with adaptive thinking, an `effort` setting, and a **task
budget** — a token ceiling it can see counting down, so it paces itself across the window
instead of being cut off mid-thought.

| Tool | What it gives Claude |
| --- | --- |
| `get_market` | Price to beat, both sides with prices, seconds to close |
| `get_spot` | BTC/USD from Coinbase, Binance and Kraken, each one's gap vs the price to beat |
| `get_order_book` | Ask and bid depth for one side |
| `get_positions` | Balance, shares held on this event, unfilled orders |
| `get_history` | Its own settled bets, win rate by direction and by strategy |
| `place_bet` | Buy a side; callable more than once to add to a position |
| `sell` | Sell into the bid book to cut a position or take profit |
| `cancel_open_orders` | Drop anything that never filled |
| `write_note` | Save a one-sentence lesson the next run will read (240 char cap) |
| `wait` | Sleep, then re-read — capped so it can never run past the deadline |

`wait` is what makes the window worth having: the agent can watch the gap at `:46`, hold,
and act at `:58` where the same gap is far more decisive. Passing is an explicit, allowed
outcome — the system prompt says so, because a bet at fair odds pays a fee for zero edge.

### Guard rails

The model proposes; the code clamps.

- **Stake** goes through the same sizing function as the deterministic path: floor, a
  ceiling that is a share of the bankroll, and the balance. Asking for more than the
  ceiling returns the ceiling, not an error.
- **`retries: 0`** on the cron. A retry would re-enter a window the first attempt may
  already have bet in.
- **No fallback bet.** `AGENT_FALLBACK` is off: the deterministic spot rule it used to
  fall back to has run **-19% ROI over 38 bets**, so a failed agent betting anyway costs
  more than a skipped hour, which costs nothing.
- **`fallbacks: "default"`** only on models that accept it. Sonnet 5 rejects the
  parameter with a 400 — sending it unconditionally failed every run for two days.
- **Failures are recorded**, so a broken run shows as `FAILED` rather than `PASSED`, and
  a streak of identical outcomes raises a banner. A fault that renders as normal
  operation is the expensive kind.

## Bankroll sizing

Stake is a fraction of the wallet, so it grows with winnings and shrinks after losses
with no manual step:

| | Value | On a 1,839 OOM bankroll |
| --- | --- | --- |
| Default stake | 2% of balance | ~37 |
| Ceiling | 5% of balance | ~92 |
| Floor | `FUTUUR_MIN_STAKE` | 10 |
| Absolute backstop | `HARD_CAP` in `src/bet.ts` | 1000 |

The ceiling is deliberately a *fraction* rather than a fixed number. A fixed cap set
above half the bankroll is a ruin risk: two bad calls at the cap and there is nothing
left to bet with.

## Cost

Deciding costs real dollars; the winnings are play money. Every run records its token
usage and the USD cost, priced with cache reads at 0.1× input and cache writes at 1.25×
— a run's bill is not `tokens × base rate`.

Measured over the first runs on `claude-opus-5` at `effort: high`: **$0.33 per run**,
~14 turns, 87% cache hit rate. The split is not what you would guess:

| Line | Share |
| --- | --- |
| Cache writes | 38% |
| Output tokens | 36% |
| Cache reads | 26% |

Cache *writes* being the largest line is why the growing conversation is worth caching
anyway — without it those 180k cached-read tokens would bill at full input rate, which is
several times worse. The lever that moves all three at once is the model, so `AGENT_MODEL`
is config rather than code and every run records which model produced it. Running
`claude-sonnet-5` at ~$0.14/run today.

`GET /stats` reports measured `spend` — `avgCostPerRun`, `avgCostPerBet`, and the cache
hit rate, which is the number to watch if cost drifts up.

### The chart

One round is one hourly market. Per-round result and running total are **two panels, not
two lines**: both are OOMs, but per-round swings ±200 while the total climbs past 900, so
one shared axis flattens the per-round line into noise — and a second y-scale would be a
dual-axis chart, which invents a correlation that is not in the data.

Colour encodes polarity, not identity: each line is green above zero and red below,
split by two clipped copies of the same path so it changes exactly at the crossing.

That pair is a measured trade-off, not a default. Green and red at the *same* lightness
are the same colour under deuteranopia — six lightness-band-compliant pairs came back at
ΔE 0.4 to 4.9, under the floor of 6. The pair in use separates at **ΔE 10.6 deutan**,
above the target of 8, precisely because the two differ in lightness, which is what puts
them outside the band. Real separation beats band conformance here, and both clear 3:1
contrast on this surface.

Colour is never the only cue regardless: sign is also position against the dashed zero
line, and each line ends in a signed label. One series per panel, so neither needs a
legend — the caption names it. Every point carries a tooltip, hit target wider than the
mark.

## Reading the numbers

**ROI on stake, not win rate.** In a market where a 0.95 favourite pays 5%, win rate is
not a result. The spot rule went 8W-1L on the Up side for **+1.6%** — 89% right and
barely above break-even, because winning at 0.95 earns 0.05 and losing costs 0.95. The
dashboard leads with ROI for that reason and keeps win rate as a sub-line.

## Dashboard

`GET /` is server-rendered HTML with no JavaScript, refreshing itself every 30 seconds.
It shows the bankroll, net settled, ROI and decision cost, then **P&L by round** — two
line panels, x is the round number and y is OOMs — then results broken down by direction
and strategy, then a timeline of receipts — each run with its cost, turn
count and summary, and each bet nested underneath with the reasoning that produced it.
Runs where Claude passed appear too, so you can see what it decided *not* to do.

| Route | Auth |
| --- | --- |
| `GET /` · `/state` · `/bets` · `/stats` · `/runs` · `/notes` · `/health` | public |
| `POST /bet` · `POST /notes` | `Authorization: Bearer $TOKEN` |

```bash
curl -sX POST https://bitcoin.rfoel.dev/bet \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"dryRun": true}' | jq
```

`POST /bet` runs the deterministic `spot` strategy, not the agent — it is for testing the
Futuur path without waiting for the hour.

## Configuration

Environment defaults live in `sst.config.ts`.

| Var | Default | Meaning |
| --- | --- | --- |
| `FUTUUR_CATEGORY_IDS` | `3702` | Category to discover the hourly event in |
| `FUTUUR_SEARCH` | `bitcoin` | Free-text fallback. One word on purpose — see below |
| `FUTUUR_WINDOW_MINUTES` | `70` | Candidate must close within this many minutes |
| `FUTUUR_CURRENCY` | `OOM` | `OOM` = play money, `USDC` = real money |
| `FUTUUR_STAKE_FRACTION` | `0.02` | Default stake as a share of the bankroll |
| `FUTUUR_MAX_STAKE_FRACTION` | `0.05` | Ceiling as a share of the bankroll |
| `FUTUUR_MIN_STAKE` | `10` | Floor |
| `FUTUUR_STRATEGY` | `spot` | Used by `POST /bet` and the fallback, not the agent |
| `AGENT_MODEL` | `claude-sonnet-5` | Recorded per run, so models stay comparable |
| `AGENT_EFFORT` | `high` | `low` … `max`; the cost lever after the model |
| `AGENT_TOKEN_BUDGET` | `80000` | Task budget the model paces itself against |
| `AGENT_BUDGET_MS` | `840000` | Working time inside the invocation |
| `AGENT_MAX_ITERATIONS` | `40` | Hard stop on loop turns |
| `AGENT_FALLBACK` | `true` | Deterministic bet if the loop fails |

## Finding the market

`futuur.com/markets/bitcoin-hourly` is **category 3702**, not an event — each hourly
edition is its own event with its own ID, and they carry no tags. So the event is
discovered per run, widening from precise to loose: `categories` → `tag` → `search`,
keeping the soonest-closing bettable candidate inside the window.

The category filter is load-bearing, not an optimisation. Category **3689** is
`bitcoin-daily`, whose event closes at 16:00 UTC — a title-and-window match alone would
bet on the daily market during the 15:45 run.

An hourly event is a **single market** with `long_label: "Up"` and `short_label: "Down"`,
so up is `position: "long"` and down is `position: "short"` on the same market. The code
matches those labels rather than assuming the mapping, and falls back to long=up with a
warning if a future event stops labelling its sides.

## Two Futuur SDK signing bugs found here

Both surfaced as `401 authentication_failed`, which reads like bad credentials but is
really a client/server disagreement about the signed parameter set. `me()` succeeding
while a parameterised call fails is the tell.

1. **A space in any signed param.** The SDK built its HMAC with `encodeURIComponent`
   (`%20`) where the server signs with Python's `urlencode` (`+`). That is why
   `FUTUUR_SEARCH` is one word.
2. **`price: null`.** The signature builder skipped null params, but axios still put
   `"price": null` on the wire, so the server signed one parameter more than the client
   did. The server renders it as the string `"None"`.

Both are fixed in [`futuur@2.1.1`](https://github.com/rfoel/futuur), which this project
pins. Orders also need `shares`, not `amount` — an amount-only body is rejected with
`KeyError: 'shares'` — so `sizeOrder` walks the ask book to turn a budget into a share
count at a price that will fill.

The scripts that found them are kept for the next 401:

| Script | Question it answers |
| --- | --- |
| `scripts/check-auth.mjs` | Credentials, or param signing? Tries `me()` first |
| `scripts/check-encoding.mjs` | Does the server sign a space as `+` or `%20`? |
| `scripts/check-order.mjs` | Which order body does `POST /orders/` accept? |
| `scripts/check-spot.mjs` | Which side would the spot rule bet now, and how is the event shaped? |

Each reads the keys from the environment and prints only call outcomes:

```bash
FUTUUR_PUBLIC_KEY=… FUTUUR_PRIVATE_KEY=… node scripts/check-auth.mjs
```

`check-order.mjs` places one real 2-share OOM bet when a variant succeeds.
