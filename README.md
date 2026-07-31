# bitcoin-hourly

Claude trades the Futuur [Bitcoin Up or Down](https://futuur.com/markets/bitcoin-hourly)
hourly market with play money, and a dashboard shows what it did and what deciding cost.

Live at **[bitcoin.rfoel.dev](https://bitcoin.rfoel.dev)**.

Every hour at `:45` a Lambda wakes Claude with tools for the market, the order book, the
spot price, its own settled results and its notes. It has the last 15 minutes of the hour
to work: read, wait, bet, add, sell, or pass. At `:06` a second Lambda reconciles the
previous hour's bets against Futuur and writes the results back, which is what the next
run reads as evidence.

## Architecture

```
:45  HourlyBitcoinBet ──▶ Claude agent loop (15 min) ──┐
                          10 tools, bets/sells/passes  │
                                                       ├──▶ DynamoDB "Memory"
:06  SettleBets ──────▶ reconcile wagers → win/loss ───┤     BET / RUN / NOTE
                                                       │
     bitcoin.rfoel.dev ──▶ dashboard + JSON ───────────┘
```

| File | Role |
| --- | --- |
| `src/agent.ts` | The agent loop: system prompt, token budget, usage accounting |
| `src/tools.ts` | The 10 tools Claude drives the market with |
| `src/bet.ts` | Futuur mechanics — event discovery, sizing, order placement |
| `src/settle.ts` | Hourly reconciliation of placed bets against their wagers |
| `src/store.ts` | DynamoDB access, cost model, stats |
| `src/ui.ts` | Server-rendered dashboard |
| `src/api.ts` | HTTP routing for the dashboard and the JSON endpoints |

Lambda `nodejs24.x` on arm64, region `sa-east-1`.

## Setup

```bash
pnpm install
pnpm sst secret set FutuurPublicKey  <your-public-key>  --stage production
pnpm sst secret set FutuurPrivateKey <your-private-key> --stage production
pnpm sst secret set AnthropicApiKey  <sk-ant-...>       --stage production
pnpm sst secret set ApiToken "$(openssl rand -hex 32)"  --stage production
pnpm sst deploy --stage production
```

Secrets are per stage. Without `ApiToken` the two write endpoints reject everything;
the dashboard and the read endpoints do not need it.

### Domain

`DOMAIN` at the top of `sst.config.ts` is the dashboard's custom domain, applied on the
`production` stage only — other stages get the generated API Gateway URL so they never
compete for the same DNS record. The hosted zone must already exist in Route 53 on the
same AWS account; SST issues the certificate and writes the records.

```bash
DOMAIN=bitcoin.example.com pnpm sst deploy --stage production   # fork it elsewhere
DOMAIN= pnpm sst deploy --stage production                      # skip the custom domain
```

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
| `write_note` | Save a lesson the next run will read |
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
- **Fallback** — if the loop itself fails (API down, a classifier refusal), a
  deterministic spot bet goes in. A run that *deliberately passes* does not trigger it.
- **`fallbacks: "default"`** on the request, so a refusal is re-run on Anthropic's
  recommended fallback model rather than silently costing the hour.

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

Roughly **$0.50 per run** at `effort: high` (~15 turns), so ~$12/day. Levers, cheapest
first: `AGENT_EFFORT=medium` (~35% less), `claude-sonnet-5`, or a less frequent schedule.
`GET /stats` reports measured `spend` — `avgCostPerRun`, `avgCostPerBet`, and the cache
hit rate, which is the number to watch if cost drifts up.

## Dashboard

`GET /` is server-rendered HTML with no JavaScript, refreshing itself every 30 seconds.
It shows the bankroll, net settled, win rate and decision cost, then results broken down
by direction and strategy, then a timeline of receipts — each run with its cost, turn
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
| `AGENT_EFFORT` | `high` | `low` … `max`; the main cost lever |
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
