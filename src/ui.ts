import { renderChart, rounds } from "./chart.js";
import type { BetRecord, NoteRecord, RunRecord, Spend, Stats } from "./store.js";

export interface DashboardState {
  now: string;
  currency: string;
  balance: number | null;
  stats: Stats;
  spend: Spend;
  bets: BetRecord[];
  runs: RunRecord[];
  notes: NoteRecord[];
}

const STATUS_COLOR: Record<string, string> = {
  won: "var(--win)",
  lost: "var(--loss)",
  pending: "var(--pending)",
  cancelled: "var(--dim)",
  unknown: "var(--dim)",
};

export function renderPage(state: DashboardState): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Server-rendered, so a plain reload is the whole update mechanism. -->
<meta http-equiv="refresh" content="30">
<title>bitcoin hourly</title>
<style>
  :root {
    --bg: #0b0e14; --fg: #c5cdd9; --dim: #5c6773; --rule: #1f2430;
    --win: #7fd962; --loss: #f07178; --pending: #ffb454; --accent: #73d0ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 1.5rem 1rem 4rem;
    background: var(--bg); color: var(--fg);
    font: 13px/1.55 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  main { max-width: 78ch; margin: 0 auto; }
  a { color: var(--accent); }
  h1 { font-size: 13px; font-weight: 600; margin: 0; letter-spacing: .06em; }
  .sub { color: var(--dim); margin: .15rem 0 1.25rem; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 1.25rem 0; }
  .grid {
    display: grid; gap: .35rem 1.5rem;
    grid-template-columns: repeat(auto-fit, minmax(15ch, 1fr));
    margin-bottom: .5rem;
  }
  .k { color: var(--dim); }
  .v { font-variant-numeric: tabular-nums; }
  .big { font-size: 20px; line-height: 1.2; }
  .section { color: var(--dim); letter-spacing: .1em; margin: 1.5rem 0 .75rem; }
  .card { border-left: 2px solid var(--rule); padding: .1rem 0 .1rem .85rem; margin-bottom: 1.1rem; }
  .card.won { border-left-color: var(--win); }
  .card.lost { border-left-color: var(--loss); }
  .card.pending { border-left-color: var(--pending); }
  .head { display: flex; flex-wrap: wrap; gap: .6rem; align-items: baseline; }
  .ts { color: var(--dim); }
  .tag {
    font-size: 11px; letter-spacing: .08em; padding: 0 .35rem;
    border: 1px solid currentColor; border-radius: 2px;
  }
  .row { color: var(--fg); }
  .row .k { display: inline-block; min-width: 9ch; }
  .why { color: var(--dim); margin-top: .3rem; white-space: pre-wrap; }
  .empty { color: var(--dim); }
  .alert {
    border: 1px solid; border-radius: 2px; padding: .5rem .75rem;
    margin-bottom: 1.25rem; color: var(--fg);
  }
  figure.chart { margin: 0 0 1.5rem; }
  figure.chart figcaption { color: var(--dim); margin-bottom: .5rem; }
  .chart .grid { stroke: var(--rule); stroke-width: 1; }
  .chart .zero { stroke: var(--dim); stroke-width: 1; stroke-dasharray: 3 3; }
  .chart .tick { fill: var(--dim); font-size: 10px; font-family: inherit; }
  .chart .axis-title { letter-spacing: .1em; }
  .chart circle { cursor: crosshair; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: .1rem 1.25rem .1rem 0; font-weight: 400; }
  th { color: var(--dim); }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; }
</style>
</head>
<body>
<main>
  <h1>BITCOIN HOURLY — CLAUDE ON FUTUUR</h1>
  <div class="sub">${esc(state.now)} · refreshes every 30s · <a href="/state">json</a></div>

  ${renderAlert(state)}
  ${renderHeadline(state)}
  <hr>
  <div class="section">P&amp;L BY ROUND — x is the round number, y is OOMs</div>
  ${renderChart(rounds(state.bets))}

  ${renderBreakdowns(state)}

  <div class="section">TIMELINE</div>
  ${renderTimeline(state)}

  <div class="section">NOTES</div>
  ${renderNotes(state.notes)}
</main>
</body>
</html>`;
}

/**
 * A run of identical outcomes is the failure mode that hides: 37 runs that all read
 * as "passed" were 37 crashes that bet anyway. Surface it above everything else.
 */
function renderAlert(state: DashboardState): string {
  const { streak, failures } = state.spend;
  if (!streak || streak.outcome === "bet" || streak.runs < 3) return "";

  const failing = streak.outcome === "failed";
  return `<div class="alert" style="border-color:${failing ? "var(--loss)" : "var(--pending)"}">
    <strong style="color:${failing ? "var(--loss)" : "var(--pending)"}">${
      failing ? "BROKEN" : "IDLE"
    }</strong>
    — the last ${streak.runs} runs all ${esc(streak.outcome)}${
      failing ? `, ${failures} of the recent window` : ""
    }. ${
      failing
        ? "The loop is not reaching a decision; check the agent log."
        : "Nothing has met the bar to bet. Real if the market is efficient, a fault if not."
    }
  </div>`;
}

/**
 * Win rate answers "how often", ROI answers "did it make money" — in a market where a
 * 0.95 favourite pays 5%, only the second is a result. Win rate stays as a sub-line.
 */
function renderHeadline(state: DashboardState): string {
  const { stats, spend, balance, currency } = state;
  const net = stats.earnings;

  return `
  <div class="grid">
    <div>
      <div class="k">BANKROLL</div>
      <div class="v big">${balance === null ? "—" : num(balance)}</div>
      <div class="k">${esc(currency)}</div>
    </div>
    <div>
      <div class="k">NET SETTLED</div>
      <div class="v big" style="color:${net >= 0 ? "var(--win)" : "var(--loss)"}">${signed(net)}</div>
      <div class="k">${stats.won + stats.lost} settled</div>
    </div>
    <div>
      <div class="k">ROI ON STAKE</div>
      <div class="v big" style="color:${(stats.roi ?? 0) >= 0 ? "var(--win)" : "var(--loss)"}">${
        stats.roi === null ? "—" : `${signed(stats.roi * 100)}%`
      }</div>
      <div class="k">${stats.won}W · ${stats.lost}L · ${
        stats.winRate === null ? "—" : `${Math.round(stats.winRate * 100)}%`
      } win rate</div>
    </div>
    <div>
      <div class="k">DECISION COST</div>
      <div class="v big">$${spend.costUsd.toFixed(2)}</div>
      <div class="k">${spend.runs} runs · ${spend.passes} passed</div>
    </div>
  </div>
  <div class="grid" style="margin-top:.9rem">
    <div><span class="k">STAKED</span> <span class="v">${num(stats.settledStaked)}</span></div>
    <div><span class="k">$/RUN</span> <span class="v">${spend.avgCostPerRun.toFixed(4)}</span></div>
    <div><span class="k">$/BET</span> <span class="v">${spend.avgCostPerBet.toFixed(4)}</span></div>
    <div><span class="k">CACHE</span> <span class="v">${
      spend.cacheHitRate === null ? "—" : `${Math.round(spend.cacheHitRate * 100)}%`
    }</span></div>
  </div>`;
}

function renderBreakdowns(state: DashboardState): string {
  const table = (title: string, rows: Record<string, { settled: number; won: number; earnings: number }>) => {
    const entries = Object.entries(rows);
    if (entries.length === 0) return "";
    return `<table style="margin-bottom:1rem">
      <tr><th>${esc(title)}</th><th class="n">SETTLED</th><th class="n">WON</th><th class="n">NET</th></tr>
      ${entries
        .map(
          ([key, v]) => `<tr>
            <td>${esc(key)}</td>
            <td class="n">${v.settled}</td>
            <td class="n">${v.won}</td>
            <td class="n" style="color:${v.earnings >= 0 ? "var(--win)" : "var(--loss)"}">${signed(v.earnings)}</td>
          </tr>`,
        )
        .join("")}
    </table>`;
  };

  const both = table("BY DIRECTION", state.stats.byDirection) + table("BY STRATEGY", state.stats.byStrategy);
  return both || `<div class="empty">No settled bets yet.</div>`;
}

/**
 * Runs and bets on one list, newest first. A bet placed by a run nests inside it;
 * bets from the endpoint or the fallback path stand on their own.
 */
function renderTimeline(state: DashboardState): string {
  const betsByOrder = new Map(state.bets.map((bet) => [bet.orderId, bet]));
  const claimed = new Set<number>();

  const runCards = state.runs.map((run) => {
    const own = run.orderIds
      .map((id) => betsByOrder.get(id))
      .filter((bet): bet is BetRecord => bet !== undefined);
    own.forEach((bet) => claimed.add(bet.orderId));
    return { at: run.runAt, html: renderRun(run, own) };
  });

  const looseCards = state.bets
    .filter((bet) => !claimed.has(bet.orderId))
    .map((bet) => ({ at: bet.placedAt, html: renderBet(bet, true) }));

  const cards = [...runCards, ...looseCards].sort((a, b) => b.at.localeCompare(a.at));
  if (cards.length === 0) return `<div class="empty">Nothing yet. First run fires at :45.</div>`;
  return cards.map((card) => card.html).join("");
}

function renderRun(run: RunRecord, bets: BetRecord[]): string {
  const failed = Boolean(run.error);
  const passed = !failed && run.orderIds.length === 0;
  const worst = failed
    ? "lost"
    : bets.some((b) => b.status === "lost")
    ? "lost"
    : bets.some((b) => b.status === "won")
      ? "won"
      : bets.some((b) => b.status === "pending")
        ? "pending"
        : "";

  return `<div class="card ${worst}">
    <div class="head">
      <span class="ts">${esc(run.runAt.replace("T", " ").slice(0, 19))}Z</span>
      <span class="tag" style="color:${
        failed ? "var(--loss)" : passed ? "var(--dim)" : "var(--accent)"
      }">${
        failed
          ? "FAILED"
          : passed
            ? "PASSED"
            : `${run.orderIds.length} BET${run.orderIds.length > 1 ? "S" : ""}`
      }</span>
      <span class="ts">event #${run.eventId} · closes ${esc(run.betEndDate.slice(11, 16))}Z</span>
    </div>
    <div class="row"><span class="k">cost</span>$${run.costUsd.toFixed(4)} · ${run.iterations} turns · ${
      run.usage.output
    } out / ${run.usage.input + run.usage.cacheRead + run.usage.cacheWrite} in · ${esc(run.effort)}</div>
    ${run.error ? `<div class="row" style="color:var(--loss)"><span class="k">error</span>${esc(run.error)}</div>` : ""}
    ${run.summary ? `<div class="why">${esc(run.summary)}</div>` : ""}
    ${bets.map((bet) => renderBet(bet, false)).join("")}
  </div>`;
}

function renderBet(bet: BetRecord, standalone: boolean): string {
  const color = STATUS_COLOR[bet.status] ?? "var(--dim)";
  const spot = bet.spot
    ? `spot ${num(bet.spot.price)} vs ${num(bet.spot.priceToBeat)} (${signed(
        bet.spot.price - bet.spot.priceToBeat,
      )})`
    : "";

  const body = `
    <div class="head" style="margin-top:${standalone ? "0" : ".55rem"}">
      ${standalone ? `<span class="ts">${esc(bet.placedAt.replace("T", " ").slice(0, 19))}Z</span>` : ""}
      <span class="tag" style="color:${color}">${esc(bet.status.toUpperCase())}</span>
      <span style="color:${color}">${esc(bet.label)}</span>
      <span class="ts">${esc(bet.position)} · order #${bet.orderId}</span>
    </div>
    <div class="row"><span class="k">size</span>${bet.shares} shares @ ${
      bet.limitPrice === null ? "market" : bet.limitPrice
    } = ${num(bet.estimatedCost)} ${esc(bet.currency)}${
      bet.earnings === undefined || bet.earnings === null
        ? ""
        : ` → <span style="color:${color}">${signed(bet.earnings)}</span>`
    }</div>
    ${spot ? `<div class="row"><span class="k">spot</span>${esc(spot)}</div>` : ""}
    <div class="why">${esc(bet.reason)}</div>`;

  return standalone ? `<div class="card ${bet.status}">${body}</div>` : body;
}

function renderNotes(notes: NoteRecord[]): string {
  if (notes.length === 0) return `<div class="empty">No notes written yet.</div>`;
  return notes
    .map(
      (note) => `<div class="card">
        <div class="head">
          <span class="ts">${esc(note.createdAt.replace("T", " ").slice(0, 19))}Z</span>
          ${note.tags.map((tag) => `<span class="tag" style="color:var(--dim)">${esc(tag)}</span>`).join("")}
        </div>
        <div class="why" style="color:var(--fg)">${esc(note.text)}</div>
      </div>`,
    )
    .join("");
}

function num(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${num(value)}`;
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
