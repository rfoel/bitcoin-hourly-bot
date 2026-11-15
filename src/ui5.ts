import type { Ledger, RoundRecord } from "./rounds.js";

/**
 * The 5-minute bot's progress: the ledger on top, then every round newest first —
 * bets and skips alike, each with what the bot saw and why it decided.
 */
export function renderRounds(ledger: Ledger | null, rounds: RoundRecord[]): string {
  const settled = (ledger?.won ?? 0) + (ledger?.lost ?? 0);
  const pending = rounds.filter((r) => r.status === "pending");
  const atStake = pending.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const equity = ledger ? ledger.bankroll + atStake : null;
  const pnl = ledger?.settledPnl ?? 0;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>bitcoin 5 min</title>
<style>
  :root { --bg:#0b0e14; --fg:#c5cdd9; --dim:#5c6773; --rule:#1f2430;
          --win:#7fd962; --loss:#f07178; --pending:#ffb454; --accent:#73d0ff; }
  * { box-sizing: border-box; }
  body { margin:0; padding:1.5rem 1rem 4rem; background:var(--bg); color:var(--fg);
         font:13px/1.55 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace; }
  main { max-width: 120ch; margin: 0 auto; }
  a { color: var(--accent); }
  h1 { font-size:13px; font-weight:600; margin:0; letter-spacing:.06em; }
  .sub { color:var(--dim); margin:.15rem 0 1.25rem; }
  .grid { display:grid; gap:.35rem 1.5rem; grid-template-columns:repeat(auto-fit,minmax(15ch,1fr)); }
  .k { color:var(--dim); }
  .big { font-size:20px; line-height:1.2; font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; margin-top:1.5rem; font-variant-numeric:tabular-nums; }
  th { text-align:left; color:var(--dim); font-weight:400; border-bottom:1px solid var(--rule); padding:.25rem .5rem .25rem 0; }
  td { padding:.2rem .5rem .2rem 0; border-bottom:1px solid var(--rule); vertical-align:top; }
  .n { text-align:right; }
  .won { color:var(--win); } .lost { color:var(--loss); } .pending { color:var(--pending); }
  .skipped, .unfilled { color:var(--dim); } .failed { color:var(--loss); }
  .why { color:var(--dim); max-width:48ch; }
</style>
</head>
<body><main>
<h1>BITCOIN UP OR DOWN · 5 MIN</h1>
<div class="sub">${esc(new Date().toISOString().slice(0, 19).replace("T", " "))}Z · refreshes every 30s ·
  <a href="/rounds">json</a> · <a href="/hourly">hourly history</a></div>
${
  ledger === null
    ? `<p class="k">No rounds yet — the ledger is created on the first run.</p>`
    : `<div class="grid">
  <div><div class="k">bankroll</div><div class="big">${money(equity ?? 0)}</div>
       <div class="k">started ${money(ledger.startedWith)} · ${esc(ledger.startedAt.slice(0, 16).replace("T", " "))}</div></div>
  <div><div class="k">settled P&amp;L</div><div class="big ${pnl >= 0 ? "won" : "lost"}">${signed(pnl)}</div>
       <div class="k">${ledger.startedWith > 0 ? signed((pnl / ledger.startedWith) * 100, 1) + "%" : ""}</div></div>
  <div><div class="k">won / lost</div><div class="big">${ledger.won} / ${ledger.lost}</div>
       <div class="k">${settled > 0 ? ((ledger.won / settled) * 100).toFixed(0) + "% hit" : "—"}</div></div>
  <div><div class="k">bets</div><div class="big">${ledger.bets}</div>
       <div class="k">${pending.length} pending · ${money(atStake)} at stake</div></div>
</div>`
}
<table>
<tr><th>closes</th><th>result</th><th>side</th><th class="n">left</th><th class="n">gap</th>
<th class="n">prob</th><th class="n">shares</th><th class="n">avg</th><th class="n">cost</th>
<th class="n">P&amp;L</th><th class="n">bankroll</th><th>why</th></tr>
${rounds.map(row).join("\n")}
</table>
</main></body></html>`;
}

function row(r: RoundRecord): string {
  const bet = r.status !== "skipped" && r.status !== "failed";
  return `<tr>
<td>${esc(r.closesAt.slice(5, 16).replace("T", " "))}</td>
<td class="${r.status}">${esc(r.status)}${r.dryRun ? " (dry)" : ""}</td>
<td>${r.side ? esc(r.side) : ""}</td>
<td class="n">${r.secondsLeft === undefined ? "" : r.secondsLeft.toFixed(1) + "s"}</td>
<td class="n">${r.gap === undefined ? "" : signed(r.gap)}</td>
<td class="n">${r.prob === undefined ? "" : (r.prob * 100).toFixed(1) + "%"}</td>
<td class="n">${bet && r.shares ? r.shares : ""}</td>
<td class="n">${bet && r.avgPrice ? r.avgPrice.toFixed(3) : ""}</td>
<td class="n">${bet && r.cost ? money(r.cost) : ""}</td>
<td class="n ${r.pnl === undefined ? "" : r.pnl >= 0 ? "won" : "lost"}">${r.pnl === undefined ? "" : signed(r.pnl)}</td>
<td class="n">${r.bankrollAfter === undefined ? "" : money(r.bankrollAfter)}</td>
<td class="why">${esc(r.error ?? (bet ? "" : r.reason))}</td>
</tr>`;
}

function money(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function signed(value: number, digits = 0): string {
  const text = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${value >= 0 ? "+" : "−"}${text}`;
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
