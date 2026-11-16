import type { Asset } from "./assets.js";
import type { Ledger, RoundRecord } from "./rounds.js";

/**
 * The 5-minute bot's page, in Portuguese, built to be read at a glance rather than
 * explained: the bankroll, the window that is open right now, the last 24 hours, the
 * bankroll's curve, and — folded away — every round.
 *
 *  - "Agora" draws the asset's price second by second inside the current window, against
 *    the price it has to beat: above the line is Sobe, below is Desce, and the strip at the
 *    end is where the bot decides. That picture is the whole strategy. The prices come
 *    straight from Binance's public market-data API in the browser — the same candle
 *    Futuur settles on — so the page never waits on our backend for them.
 *  - "Últimas 24 horas" is a dot per 5-minute window: one column per hour, twelve rows.
 *    Filled blue is a bet won, a red ring a bet lost, the size is the stake; grey is a
 *    round skipped. Under each column, a bar with what that hour made or lost.
 *
 * Server-rendered; the script only adds the live price, the clock, tooltips and a refresh
 * every 30 seconds (without it, the page falls back to a plain reload).
 *
 * Colour: gain/loss is polarity, so it is the diverging pair (blue ↔ red), validated in
 * both modes — and doubled by shape, filled against ring and up against down. Status chips
 * always carry an icon and a word. Text never wears a series colour.
 */

export interface RoundsView {
  /** Only rounds where the bot actually bet. */
  onlyBets?: boolean;
  /** Every asset the bot plays, for the switcher. The first one lives at `/`. */
  assets?: Asset[];
}

const TZ = "America/Sao_Paulo";
const MIN_PROB = Number(process.env.FIVEMIN_MIN_PROB ?? "0.7");
const DECIDE_AT = Number(process.env.FIVEMIN_DECIDE_AT ?? "15");
const WINDOW_MS = 300_000;
const HOURS = 24;

export function renderRounds(
  asset: Asset,
  ledger: Ledger | null,
  rounds: RoundRecord[],
  view: RoundsView = {},
): string {
  const assets = view.assets ?? [asset];
  const pathOf = (a: Asset) => (a.key === assets[0]?.key ? "/" : `/${a.key}`);
  const home = pathOf(asset);
  const settled = rounds
    .filter((r) => r.status === "won" || r.status === "lost")
    .sort((a, b) => a.closesAt.localeCompare(b.closesAt));
  const pending = rounds.filter((r) => r.status === "pending");
  const atStake = pending.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const equity = ledger ? ledger.bankroll + atStake : null;
  const shown = (view.onlyBets ? rounds.filter(isBet) : rounds).slice(0, 120);

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<noscript><meta http-equiv="refresh" content="30"></noscript>
<title>${equity === null ? "" : `${int(equity)} OOM · `}${esc(asset.name)} 5 min</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <header class="bar">
    <div class="eyebrow"><span class="live" aria-hidden="true"></span> Ao vivo · OOM de mentira</div>
    ${assets.length > 1 ? `<nav class="pills" aria-label="Mercado">${assets.map((a) => `<a href="${pathOf(a)}" ${a.key === asset.key ? 'aria-current="true"' : ""}>${esc(a.name)}</a>`).join("")}</nav>` : ""}
  </header>

  <section class="card top" id="live-hero" data-live>
    ${ledger === null ? emptyState() : hero(asset, ledger, equity!, atStake)}
  </section>

  ${now(asset, rounds)}

  <div id="live-body" data-live>
    <section class="card">
      <div class="head">
        <h2>Últimas 24 horas</h2>
        <div class="legend">
          <span><i class="sw won"></i>ganhou</span>
          <span><i class="sw lost"></i>perdeu</span>
          <span><i class="sw pending"></i>aguardando</span>
          <span><i class="sw skipped"></i>pulou</span>
          <span class="muted">tamanho = quanto apostou</span>
        </div>
      </div>
      ${dayGrid(rounds)}
    </section>

    <section class="card">
      <div class="head"><h2>Banca</h2></div>
      ${bankrollChart(ledger, settled)}
    </section>
  </div>

  <details class="card rounds" ${view.onlyBets ? "open" : ""}>
    <summary><h2>Todas as rodadas</h2></summary>
    <nav class="pills small-pills" aria-label="Filtrar rodadas">
      <a href="${home}" ${view.onlyBets ? "" : 'aria-current="true"'}>Todas</a>
      <a href="${home}?ver=apostas" ${view.onlyBets ? 'aria-current="true"' : ""}>Só apostas</a>
    </nav>
    <div id="live-table" data-live>${table(shown)}</div>
  </details>

  <footer><a href="/rounds?asset=${asset.key}">JSON</a> · <a href="/hourly">robô horário</a></footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/* ── Hero ────────────────────────────────────────────────────────────────── */

function hero(asset: Asset, ledger: Ledger, equity: number, atStake: number): string {
  const pnl = equity - ledger.startedWith;
  const pct = ledger.startedWith > 0 ? (pnl / ledger.startedWith) * 100 : 0;
  const decided = ledger.won + ledger.lost;

  return `<div>
      <div class="k">Banca · ${esc(asset.name)}</div>
      <div class="hero-value">${big(equity)} <span class="unit">OOM</span></div>
      <div class="delta ${pnl >= 0 ? "up" : "down"}">
        <span aria-hidden="true">${pnl >= 0 ? "▲" : "▼"}</span>
        ${signedBig(pnl)} (${Math.abs(pct) >= 1000 ? signedBig(pct) : signed(pct, 1)}%)
        <span class="muted">desde ${int(ledger.startedWith)}</span>
      </div>
    </div>
    <dl class="stats">
      ${stat("Acertos", decided === 0 ? "—" : `${Math.round((ledger.won / decided) * 100)}%`, `${ledger.won} de ${decided}`)}
      ${stat("Apostas", int(ledger.bets), "no total")}
      ${stat("Em jogo", big(atStake), "OOM")}
    </dl>`;
}

function stat(label: string, value: string, note: string): string {
  return `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd><span>${esc(note)}</span></div>`;
}

function emptyState(): string {
  return `<div class="empty">
    <h2>Nenhuma rodada ainda</h2>
    <p>A banca de 10.000 OOM nasce na primeira execução. Volte em instantes.</p>
  </div>`;
}

/* ── Now: the open window, live ──────────────────────────────────────────── */

/**
 * The card the script fills with Binance's live price. The server only supplies the last
 * few rounds, so the script can say what the bot did in this window and the one before.
 */
function now(asset: Asset, rounds: RoundRecord[]): string {
  const recent = rounds.slice(0, 4).map((r) => ({
    c: Date.parse(r.closesAt),
    s: r.status,
    side: r.side ?? null,
    cost: r.cost ?? 0,
    prob: r.prob ?? null,
    pnl: r.pnl ?? null,
    why: shortSkip(r),
  }));

  return `<section class="card now" id="now" data-symbol="${esc(asset.symbol)}" data-decide-at="${DECIDE_AT}" data-rounds='${esc(JSON.stringify(recent))}'>
    <div class="now-head">
      <div>
        <div class="k">Agora · ${esc(asset.name)}</div>
        <div class="now-price"><span id="now-price">—</span> <span id="now-gap" class="gap"></span></div>
      </div>
      <div class="clock">
        <div class="k" id="countdown-label">Decide em</div>
        <div class="countdown" id="countdown">—</div>
      </div>
    </div>
    <figure class="race">
      <svg viewBox="0 0 760 240" preserveAspectRatio="none" role="img" aria-label="Preço do ${esc(asset.name)} na janela de 5 minutos atual, contra o preço de abertura">
        <rect class="zone-up" x="0" y="0" width="760" height="120"/>
        <rect class="zone-down" x="0" y="120" width="760" height="120"/>
        <rect class="zone-act" y="0" height="240" x="740" width="20"/>
        <line class="beat" x1="0" x2="760" y1="120" y2="120"/>
        <path class="price"/>
      </svg>
      <span class="tag tag-up">↑ Sobe</span>
      <span class="tag tag-down">↓ Desce</span>
      <span class="tag tag-act">robô decide</span>
      <span class="tag tag-beat" id="beat-label"></span>
      <i class="head-dot" aria-hidden="true"></i>
      <div class="race-msg" id="race-msg">Carregando preço…</div>
    </figure>
    <div class="now-foot">
      <span id="now-status">O robô aposta nos últimos ${DECIDE_AT}s, no lado em que o preço estiver.</span>
      <span id="now-prev" class="muted"></span>
    </div>
  </section>`;
}

/* ── The last 24 hours, a dot per window ─────────────────────────────────── */

/** Index of the 5-minute window a round covers, counted from the epoch. */
function slotOf(r: RoundRecord): number {
  return Math.round(Date.parse(r.closesAt) / WINDOW_MS) - 1;
}

/**
 * One column per clock hour (Brasília is a whole number of hours from UTC, so twelve
 * windows are exactly one of its hours), the current hour on the right. Under the dots,
 * each hour's settled result as a bar.
 */
function dayGrid(rounds: RoundRecord[]): string {
  const nowSlot = Math.floor(Date.now() / WINDOW_MS);
  const nowHour = Math.floor(nowSlot / 12);
  const bySlot = new Map(rounds.map((r) => [slotOf(r), r]));
  const biggest = Math.max(1, ...rounds.filter(isBet).map((r) => r.cost ?? 0));

  const C = 30, L = 36, R = 6, BAR = 64, GAP = 14;
  const width = L + HOURS * C + R;
  const top = 4, mat = 12 * C, barMid = top + mat + GAP + BAR / 2;
  const height = top + mat + GAP + BAR + 22;

  const hourNet: { pnl: number; bets: number }[] = [];
  const cells: string[] = [];
  for (let col = 0; col < HOURS; col++) {
    const hour = nowHour - (HOURS - 1 - col);
    let pnl = 0, bets = 0;
    for (let row = 0; row < 12; row++) {
      const k = hour * 12 + row;
      if (k > nowSlot) continue;
      const cx = L + col * C + C / 2, cy = top + row * C + C / 2;
      const r = bySlot.get(k);
      const win = `${timeFmt.format((k) * WINDOW_MS)}–${timeFmt.format((k + 1) * WINDOW_MS)}`;
      if (k === nowSlot && !r) {
        cells.push(`<circle class="dot-now" cx="${cx}" cy="${cy}" r="10"/><rect class="hit" x="${cx - C / 2}" y="${cy - C / 2}" width="${C}" height="${C}" data-a="${win}" data-b="Janela aberta agora"/>`);
        continue;
      }
      if (!r) {
        cells.push(`<circle class="dot-none" cx="${cx}" cy="${cy}" r="1.6"/>`);
        continue;
      }
      if (r.status === "won" || r.status === "lost") { pnl += r.pnl ?? 0; bets++; }
      const bet = isBet(r);
      const radius = bet ? 3.5 + 8 * Math.sqrt(Math.min(1, (r.cost ?? 0) / biggest)) : 3;
      const cls = bet ? r.status : r.status === "failed" ? "failed" : "skipped";
      const [a, b] = tipOf(r);
      cells.push(`<circle class="dot ${cls}" cx="${cx}" cy="${cy}" r="${radius.toFixed(1)}"/><rect class="hit" x="${cx - C / 2}" y="${cy - C / 2}" width="${C}" height="${C}" data-a="${esc(`${win} · ${a}`)}" data-b="${esc(b)}"/>`);
    }
    hourNet.push({ pnl, bets });
  }

  const maxAbs = Math.max(1, ...hourNet.map((h) => Math.abs(h.pnl)));
  const bars = hourNet.map((h, col) => {
    const hour = nowHour - (HOURS - 1 - col);
    const x = L + col * C + 7, label = `${hourFmt.format(hour * 3_600_000)}h`;
    const tip = `<rect class="hit" x="${L + col * C}" y="${barMid - BAR / 2}" width="${C}" height="${BAR}" data-a="${label}" data-b="${h.bets === 0 ? "nenhuma aposta liquidada" : `${signedBig(h.pnl)} OOM em ${h.bets} aposta${h.bets === 1 ? "" : "s"}`}"/>`;
    const tick = col === HOURS - 1 ? `<text class="tick" x="${L + col * C + C / 2}" y="${height - 4}" text-anchor="middle">agora</text>`
      : col % 3 === 2 ? `<text class="tick" x="${L + col * C + C / 2}" y="${height - 4}" text-anchor="middle">${label}</text>` : "";
    if (h.bets === 0) return tick + tip;
    const len = Math.max(2, (Math.abs(h.pnl) / maxAbs) * (BAR / 2 - 2));
    const y = h.pnl >= 0 ? barMid - len : barMid;
    return `<rect class="bar-${h.pnl >= 0 ? "up" : "down"}" x="${x}" y="${y.toFixed(1)}" width="${C - 14}" height="${len.toFixed(1)}" rx="2"/>${tick}${tip}`;
  }).join("");

  const minutes = [0, 3, 6, 9].map((row) =>
    `<text class="tick" x="${L - 8}" y="${top + row * C + C / 2 + 4}" text-anchor="end">:${String(row * 5).padStart(2, "0")}</text>`).join("");

  const count = (s: string) => rounds.filter((r) => r.status === s).length;
  const label = `Últimas 24 horas, um ponto por janela de 5 minutos: ${count("won")} apostas ganhas, ${count("lost")} perdidas, ${count("skipped")} rodadas puladas.`;

  return `<figure class="grid24">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
      ${minutes}
      <line class="base" x1="${L}" x2="${width - R}" y1="${barMid}" y2="${barMid}"/>
      ${cells.join("")}
      ${bars}
    </svg>
    <div class="tooltip" hidden><strong></strong><span></span></div>
  </figure>`;
}

function tipOf(r: RoundRecord): [string, string] {
  const side = r.side === "down" ? "↓ Desce" : "↑ Sobe";
  const stake = r.cost ?? 0;
  const pick = `${side} · ${chance(r.prob ?? 0)} · ${big(stake)} OOM`;
  switch (r.status) {
    case "won": return [`Ganhou ${signedBig(r.pnl ?? 0)}`, pick];
    case "lost": return [`Perdeu ${big(Math.abs(r.pnl ?? stake))}`, pick];
    case "pending": return ["Aguardando", pick];
    default: return [CHIPS[r.status]?.[1] ?? r.status, shortSkip(r)];
  }
}

/* ── Bankroll chart ──────────────────────────────────────────────────────── */

const W = 760;

/** Equity after each settled round, rebuilt backwards from the ledger's current total. */
function bankrollChart(ledger: Ledger | null, settled: RoundRecord[]): string {
  if (!ledger || settled.length === 0) {
    return `<div class="chart-empty">Aparece depois da primeira aposta liquidada.</div>`;
  }

  // The ledger's total is the truth; the window may not reach back to the first round,
  // so each point is the final total minus whatever came after it.
  const final = ledger.startedWith + ledger.settledPnl;
  let after = 0;
  const points = [...settled].reverse().map((r) => {
    const value = final - after;
    after += r.pnl ?? 0;
    return { r, value };
  }).reverse();
  const series = [{ r: null as RoundRecord | null, value: final - after }, ...points];

  const H = 220;
  const pad = { top: 16, right: 64, bottom: 28, left: 56 };
  const values = [...series.map((p) => p.value), ledger.startedWith];
  const [lo, hi, ticks] = niceScale(Math.min(...values), Math.max(...values));
  const x = (i: number) => pad.left + (i / Math.max(series.length - 1, 1)) * (W - pad.left - pad.right);
  const y = (v: number) => pad.top + (1 - (v - lo) / (hi - lo)) * (H - pad.top - pad.bottom);

  const line = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const area = `${line}L${x(series.length - 1).toFixed(1)},${y(lo).toFixed(1)}L${x(0).toFixed(1)},${y(lo).toFixed(1)}Z`;
  const last = series[series.length - 1]!;
  const data = series.map((p, i) => ({
    x: +x(i).toFixed(1),
    y: +y(p.value).toFixed(1),
    v: int(p.value),
    t: p.r ? `${when(p.r.closesAt)} · ${p.r.status === "won" ? "ganhou" : "perdeu"} ${signed(p.r.pnl ?? 0)}` : "início",
  }));

  return `<figure class="chart" data-points='${esc(JSON.stringify(data))}'>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Banca ao longo das apostas: de ${int(series[0]!.value)} para ${int(last.value)} OOM">
      ${ticks.map((t) => `<line class="grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${pad.left - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join("")}
      <line class="ref" x1="${pad.left}" x2="${W - pad.right}" y1="${y(ledger.startedWith)}" y2="${y(ledger.startedWith)}"/>
      <text class="ref-label" x="${pad.left + 4}" y="${y(ledger.startedWith) - 6}">início</text>
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
      <circle class="dot-end" cx="${x(series.length - 1)}" cy="${y(last.value)}" r="4"/>
      <text class="end-label" x="${x(series.length - 1) + 10}" y="${y(last.value) + 4}">${big(last.value)}</text>
      <g class="hover" aria-hidden="true"><line class="cross" y1="${pad.top}" y2="${H - pad.bottom}"/><circle class="hover-dot" r="5"/></g>
      <rect class="chart-hit" x="${pad.left}" y="0" width="${W - pad.left - pad.right}" height="${H}"/>
    </svg>
    <div class="tooltip" hidden><strong></strong><span></span></div>
  </figure>`;
}

/** Round bounds and 3–5 clean ticks covering [min, max]. */
function niceScale(min: number, max: number): [number, number, number[]] {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t * 100) / 100);
  return [lo, hi, ticks];
}

/* ── Table ───────────────────────────────────────────────────────────────── */

function table(rounds: RoundRecord[]): string {
  if (rounds.length === 0) return `<div class="chart-empty">Nada por aqui ainda.</div>`;
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Hora</th><th>Situação</th><th>Lado</th><th class="n">Chance</th><th class="n">Apostou</th><th class="n">Resultado</th>
    </tr></thead>
    <tbody>${rounds.map(row).join("")}</tbody>
  </table></div>`;
}

function row(r: RoundRecord): string {
  const head = `<td>${when(r.closesAt)}</td><td>${chip(r.status)}${r.dryRun ? ' <span class="muted">simulação</span>' : ""}</td>`;
  const side = r.side ? `${r.side === "down" ? "↓ Desce" : "↑ Sobe"}` : "";
  const prob = r.prob === undefined ? "" : chance(r.prob);

  if (!isBet(r)) {
    return `<tr class="dim">${head}<td>${side}</td><td class="n">${prob}</td><td colspan="2" class="why">${esc(shortSkip(r))}</td></tr>`;
  }

  const pnl = r.pnl === undefined ? "" : `<span class="${r.pnl >= 0 ? "t-up" : "t-down"}">${signed(r.pnl)}</span>`;
  return `<tr>${head}<td>${side}</td><td class="n">${prob}</td><td class="n">${int(r.cost ?? 0)}</td><td class="n">${pnl}</td></tr>`;
}

const CHIPS: Record<string, [string, string]> = {
  won: ["✓", "Ganhou"],
  lost: ["✕", "Perdeu"],
  pending: ["◷", "Aguardando"],
  skipped: ["–", "Pulou"],
  unfilled: ["–", "Não executou"],
  failed: ["!", "Erro"],
};

function chip(status: string): string {
  const [icon, label] = CHIPS[status] ?? ["?", status];
  return `<span class="chip ${esc(status)}"><span aria-hidden="true">${icon}</span>${esc(label)}</span>`;
}

/** The handler's skip reasons are terse and in English; this says them in a few words. */
function shortSkip(r: RoundRecord): string {
  const reason = r.reason ?? "";
  if (r.status === "failed") return `Erro: ${r.error ?? reason}`;
  if (r.status === "unfilled") return "Ordem não executada";
  if (reason.startsWith("dry run")) return "Simulação";
  if (r.prob !== undefined && r.prob < MIN_PROB) return `Perto demais da linha (${chance(r.prob)})`;
  if (reason.startsWith("no edge")) return "Preço alto demais";
  if (reason.startsWith("line mismatch")) return "Linha não bateu com a Binance";
  if (reason.startsWith("nothing to stake")) return "Sem saldo";
  if (reason.startsWith("woke up too late")) return "Acordou tarde";
  if (reason.startsWith("order canceled")) return "Ordem cancelada";
  if (reason.startsWith("no volatility")) return "Sem volatilidade";
  return reason;
}

/** 0.999 is not 100%: the bot can still lose it. */
function chance(p: number): string {
  if (p >= 0.995) return ">99%";
  if (p <= 0.005) return "<1%";
  return `${Math.round(p * 100)}%`;
}

function isBet(r: RoundRecord): boolean {
  return r.status === "pending" || r.status === "won" || r.status === "lost";
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

const timeFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });

function when(iso: string, withDay = false): string {
  const d = new Date(iso);
  const sameDay = dayFmt.format(d) === dayFmt.format(new Date());
  return withDay || !sameDay ? `${dayFmt.format(d)} ${timeFmt.format(d)}` : timeFmt.format(d);
}

function int(value: number): string {
  return Math.round(value).toLocaleString("pt-BR");
}

function signed(value: number, digits = 0): string {
  const text = Math.abs(value).toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${value >= 0 ? "+" : "−"}${text}`;
}

/** Axis-style: 9.500 / 12 mil / 1,2 mi / 3,4 bi. */
function compact(value: number): string {
  const abs = Math.abs(value);
  const unit = (n: number, s: string) =>
    `${(value / n).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${s}`;
  if (abs >= 1e9) return unit(1e9, "bi");
  if (abs >= 1e6) return unit(1e6, "mi");
  if (abs >= 10_000) return unit(1e3, "mil");
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}

/** Full figures while they fit, compact past a million. */
function big(value: number): string {
  return Math.abs(value) >= 1e6 ? compact(value) : int(value);
}

function signedBig(value: number): string {
  return `${value >= 0 ? "+" : "−"}${big(Math.abs(value))}`;
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/* ── Style & script ──────────────────────────────────────────────────────── */

const CSS = `
:root {
  color-scheme: light;
  --page: #eeece4; --surface: #faf9f5; --edge: #d3cfc1; --ink: #0d0d0c; --ink-2: #4f4d48; --muted: #85827a;
  --grid: #e2dfd4; --axis: #c3c0b3; --ring: rgba(13,13,12,.12);
  --gain: #2a78d6; --loss: #e34948; --warn: #f5a800; --skip: #c5c0ae;
  --gain-wash: rgba(42,120,214,.09); --loss-wash: rgba(227,73,72,.08); --warn-wash: rgba(245,168,0,.22);
  --good: #0ca30c; --critical: #d03b3b; --warning: #fab219;
  --t-up: #006300; --t-down: #b42318;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #08090c; --surface: #12141a; --edge: #1d2029; --ink: #f0efec; --ink-2: #b9bbc2; --muted: #80838d;
    --grid: #252831; --axis: #383c47; --ring: rgba(255,255,255,.09);
    --gain: #3987e5; --loss: #e66767; --warn: #fab219; --skip: #4a5163;
    --gain-wash: rgba(57,135,229,.12); --loss-wash: rgba(230,103,103,.10); --warn-wash: rgba(250,178,25,.18);
    --t-up: #0ca30c; --t-down: #e66767;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main, #live-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
main { max-width: 1080px; margin: 0 auto; padding: 20px 20px 48px; }
a { color: var(--gain); }
h2 { font-size: 16px; margin: 0; font-weight: 650; letter-spacing: -.01em; }
.k { color: var(--ink-2); font: 500 11px/1.4 var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.muted { color: var(--muted); font-weight: 400; }

.card { background: var(--surface); border: 1px solid var(--ring); border-radius: 18px; padding: 20px 22px;
  box-shadow: 0 5px 0 var(--edge); position: relative; }
.head { display: flex; justify-content: space-between; align-items: center; gap: 8px 16px; flex-wrap: wrap; margin-bottom: 12px; }

.bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.eyebrow { color: var(--ink-2); font: 500 11px/1.4 var(--mono); letter-spacing: .06em; text-transform: uppercase;
  display: flex; align-items: center; gap: 10px; }
.live { width: 8px; height: 8px; border-radius: 50%; background: var(--good); animation: beat 2s ease-out infinite; }
@keyframes beat { 0% { box-shadow: 0 0 0 0 rgba(12,163,12,.5); } 100% { box-shadow: 0 0 0 9px rgba(12,163,12,0); } }
.pills { display: flex; gap: 4px; flex-wrap: wrap; }
.pills a { text-decoration: none; color: var(--ink-2); font-size: 13px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--ring); }
.pills a:hover { color: var(--ink); border-color: var(--axis); }
.pills a[aria-current] { background: var(--ink); color: var(--surface); border-color: var(--ink); }

/* Hero */
.top { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px 32px; flex-wrap: wrap; }
.hero-value { font-size: clamp(40px, 8vw, 64px); line-height: 1; font-weight: 720; letter-spacing: -.045em; margin: 8px 0 10px;
  font-variant-numeric: tabular-nums; }
.unit { font: 500 13px/1 var(--mono); letter-spacing: .06em; color: var(--ink-2); }
.delta { font-size: 15px; font-weight: 600; }
.delta.up { color: var(--t-up); } .delta.down { color: var(--t-down); }
.stats { display: flex; gap: 10px; margin: 0; flex-wrap: wrap; }
.stats div { border: 1px solid var(--ring); border-radius: 12px; padding: 10px 14px; min-width: 104px; }
.stats dt { font: 500 11px/1.4 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.stats dd { margin: 2px 0 0; font-size: 24px; font-weight: 680; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.2; }
.stats span { font-size: 12px; color: var(--muted); }
.empty h2 { font-size: 22px; margin-bottom: 4px; } .empty p { color: var(--ink-2); margin: 0; }

/* Now */
.now-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-bottom: 12px; }
.now-price { font: 650 26px/1.2 var(--mono); font-variant-numeric: tabular-nums; letter-spacing: -.02em; margin-top: 4px; }
.gap { font-size: 15px; font-weight: 600; margin-left: 6px; }
.gap.up { color: var(--t-up); } .gap.down { color: var(--t-down); }
.clock { text-align: right; }
.countdown { font: 650 26px/1.2 var(--mono); font-variant-numeric: tabular-nums; letter-spacing: -.02em; margin-top: 4px; }
.race { margin: 0; position: relative; height: 240px; }
.race svg { width: 100%; height: 100%; display: block; overflow: visible; border-radius: 10px; }
.zone-up { fill: var(--gain-wash); } .zone-down { fill: var(--loss-wash); } .zone-act { fill: var(--warn-wash); }
.beat { stroke: var(--ink-2); stroke-width: 1.5; stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; }
.price { fill: none; stroke: var(--ink); stroke-width: 2.25; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.tag { position: absolute; font: 600 11px/1 var(--mono); letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); pointer-events: none; }
.tag-up { left: 10px; top: 10px; } .tag-down { left: 10px; bottom: 10px; }
.tag-act { right: 0; top: 0; bottom: 0; width: 8%; writing-mode: vertical-rl; display: grid; place-items: center; color: var(--ink-2); }
.tag-beat { left: 10px; transform: translateY(-140%); font-weight: 500; text-transform: none; letter-spacing: 0; font-size: 11px; }
.head-dot { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: var(--ink);
  border: 2px solid var(--surface); display: none; }
.head-dot.up { background: var(--gain); } .head-dot.down { background: var(--loss); }
.head-dot::after { content: ""; position: absolute; inset: -6px; border-radius: 50%; border: 2px solid currentColor; opacity: 0;
  animation: ping 1.6s ease-out infinite; color: inherit; }
.head-dot.up::after { border-color: var(--gain); } .head-dot.down::after { border-color: var(--loss); }
@keyframes ping { 0% { opacity: .7; transform: scale(.6); } 100% { opacity: 0; transform: scale(1.6); } }
.race-msg { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-size: 13px; }
.race-msg[hidden] { display: none; }
.now-foot { display: flex; justify-content: space-between; gap: 6px 16px; flex-wrap: wrap; margin-top: 12px; font-size: 14px; color: var(--ink-2); }
#now-status b { color: var(--ink); }

/* Day grid */
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.sw.won { background: var(--gain); } .sw.lost { border: 2.5px solid var(--loss); }
.sw.pending { background: var(--warn); } .sw.skipped { background: var(--skip); width: 6px; height: 6px; }
.grid24 { margin: 0; position: relative; }
.grid24 svg { width: 100%; height: auto; display: block; }
.dot.won { fill: var(--gain); }
.dot.lost { fill: none; stroke: var(--loss); stroke-width: 3; }
.dot.pending { fill: var(--warn); animation: glow 1.4s ease-in-out infinite alternate; }
.dot.skipped { fill: var(--skip); }
.dot.failed { fill: none; stroke: var(--critical); stroke-width: 1.5; }
.dot-none { fill: var(--grid); }
.dot-now { fill: none; stroke: var(--ink); stroke-width: 1.5; stroke-dasharray: 3 3; animation: spin 8s linear infinite; transform-box: fill-box; transform-origin: center; }
@keyframes glow { from { opacity: 1; } to { opacity: .45; } }
@keyframes spin { to { transform: rotate(360deg); } }
.bar-up { fill: var(--gain); } .bar-down { fill: var(--loss); }
.base { stroke: var(--axis); stroke-width: 1; }
.hit { fill: transparent; }
.grid24 .hit:hover { fill: var(--ring); }

/* Bankroll chart */
.chart { margin: 0; position: relative; }
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.grid { stroke: var(--grid); stroke-width: 1; }
.ref { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 4 4; }
.ref-label, .tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.end-label { fill: var(--ink); font-size: 13px; font-weight: 620; }
.line { fill: none; stroke: var(--gain); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.area { fill: var(--gain-wash); }
.dot-end, .hover-dot { fill: var(--gain); stroke: var(--surface); stroke-width: 2; }
.hover { display: none; } .chart.hovering .hover { display: block; }
.cross { stroke: var(--axis); stroke-width: 1; }
.chart-hit { fill: transparent; cursor: crosshair; }
.chart-empty { color: var(--muted); padding: 28px 0; text-align: center; border: 1px dashed var(--axis); border-radius: 12px; }

.tooltip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--ring);
  border-radius: 10px; padding: 7px 11px; font-size: 12px; box-shadow: 0 4px 0 var(--edge), 0 10px 24px rgba(0,0,0,.14);
  display: grid; transform: translate(-50%, calc(-100% - 12px)); white-space: nowrap; z-index: 2; }
.tooltip[hidden] { display: none; }
.tooltip strong { font-size: 13px; } .tooltip span { color: var(--ink-2); }

/* Rounds */
.rounds summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; }
.rounds summary::-webkit-details-marker { display: none; }
.rounds summary::after { content: "▾"; color: var(--muted); transition: transform .2s; }
.rounds[open] summary::after { transform: rotate(180deg); }
.small-pills { margin: 14px 0 8px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
th { text-align: left; color: var(--muted); font: 500 11px/1.4 var(--mono); letter-spacing: .05em; text-transform: uppercase;
  padding: 8px 10px 8px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; }
td { padding: 8px 10px 8px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; }
.n { text-align: right; }
tr.dim td { color: var(--ink-2); }
td.why { white-space: normal; color: var(--muted); }
.t-up { color: var(--t-up); font-weight: 600; } .t-down { color: var(--t-down); font-weight: 600; }
.chip { display: inline-flex; gap: 5px; align-items: center; font-size: 12px; font-weight: 560; padding: 2px 9px 2px 7px; border-radius: 999px; border: 1px solid var(--ring); color: var(--ink); }
.chip.won span { color: var(--good); } .chip.lost span { color: var(--critical); }
.chip.pending span { color: var(--warning); } .chip.failed span { color: var(--critical); }
.chip.skipped, .chip.unfilled { color: var(--ink-2); }
footer { color: var(--muted); font-size: 12px; text-align: center; }
footer a { color: var(--muted); }

@media (max-width: 640px) {
  .card { padding: 16px; }
  .stats { width: 100%; } .stats div { flex: 1; min-width: 0; padding: 8px 10px; } .stats dd { font-size: 20px; }
  .race { height: 200px; }
  .now-price, .countdown { font-size: 21px; }
}
@media (prefers-reduced-motion: reduce) {
  .live, .dot.pending, .dot-now, .head-dot::after { animation: none; }
}
`;

/**
 * Everything here is optional to the page:
 *
 *  - the live window: polls Binance's public 1-second candles for the open window and
 *    draws them against the window's open — the price to beat;
 *  - the clock, and what the bot did in this window and the one before;
 *  - tooltips on the day grid and the bankroll chart;
 *  - the refresh: the page is fetched again every 30 seconds — and once more just after
 *    the bot decides — and its `data-live` regions are swapped in place.
 *
 * Text only ever goes in with textContent. String.raw, and no template literals inside,
 * so nothing here is interpolated by the server.
 */
const SCRIPT = String.raw`
(() => {
  const WIN = 300000, API = "https://data-api.binance.vision/api/v3/klines";
  const byId = (id) => document.getElementById(id);
  const mmss = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  const usd = (v, d) => "$" + v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const num = (v) => Math.round(v).toLocaleString("pt-BR");
  const signed = (v) => (v >= 0 ? "+" : "−") + num(Math.abs(v));
  const pct = (p) => p >= 0.995 ? ">99%" : Math.round(p * 100) + "%";
  const card = byId("now");
  const decideAt = card ? Number(card.dataset.decideAt || 15) : 15;

  /* ── Live window ── */
  let win = 0, open = null, pts = [], span = 0, busy = false, digits = 2;
  const svg = card && card.querySelector("svg");
  const fetchJson = async (url) => { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };

  const poll = async () => {
    if (!card || busy || document.hidden) return;
    busy = true;
    try {
      const sym = card.dataset.symbol, w = Math.floor(Date.now() / WIN) * WIN;
      if (w !== win) { win = w; open = null; pts = []; span = 0; }
      if (open === null) {
        const c = await fetchJson(API + "?symbol=" + sym + "&interval=5m&limit=1");
        if (c[0] && c[0][0] === win) open = Number(c[0][1]);
      }
      // The last candle is still forming, so it is fetched again each time.
      const since = pts.length ? pts[pts.length - 1][0] : win;
      const rows = await fetchJson(API + "?symbol=" + sym + "&interval=1s&limit=1000&startTime=" + since);
      pts = pts.filter((p) => p[0] < since);
      for (const r of rows) if (r[0] >= win && r[0] < win + WIN) pts.push([r[0], Number(r[4])]);
      if (open === null && pts.length) open = Number(rows[0][1]);
      draw();
    } catch (e) {
      if (!pts.length) { const m = byId("race-msg"); m.hidden = false; m.textContent = "Sem dados da Binance agora."; }
    } finally { busy = false; }
  };

  const draw = () => {
    if (!svg || open === null || !pts.length) return;
    byId("race-msg").hidden = true;
    const box = svg.getBoundingClientRect(), VW = 760, VH = 240, R = 0.97;
    digits = open < 10 ? 3 : 2;
    for (const p of pts) span = Math.max(span, Math.abs(p[1] - open));
    const s = Math.max(span * 1.3, open * 0.00012);
    const x = (t) => ((t - win) / WIN) * VW * R;
    const y = (v) => VH / 2 - ((v - open) / s) * (VH / 2);
    let d = "";
    pts.forEach((p, i) => { d += (i ? "L" : "M") + x(p[0] + 500).toFixed(1) + "," + y(p[1]).toFixed(1); });
    svg.querySelector(".price").setAttribute("d", d);
    const act = svg.querySelector(".zone-act");
    act.setAttribute("x", x(win + WIN - decideAt * 1000));
    act.setAttribute("width", VW - x(win + WIN - decideAt * 1000));
    card.querySelector(".tag-act").style.width = ((VW - x(win + WIN - decideAt * 1000)) / VW) * 100 + "%";

    const last = pts[pts.length - 1], gap = last[1] - open, up = gap >= 0;
    const dot = card.querySelector(".head-dot");
    dot.style.display = "block";
    dot.className = "head-dot " + (up ? "up" : "down");
    dot.style.left = (x(last[0] + 500) / VW) * box.width + "px";
    dot.style.top = (y(last[1]) / VH) * box.height + "px";
    byId("beat-label").textContent = "abertura " + usd(open, digits);
    byId("beat-label").style.top = box.height / 2 + "px";
    byId("now-price").textContent = usd(last[1], digits);
    const g = byId("now-gap");
    g.textContent = (up ? "↑ +" : "↓ −") + usd(Math.abs(gap), digits).slice(1);
    g.className = "gap " + (up ? "up" : "down");
  };

  /* ── What the bot did ── */
  const status = () => {
    if (!card) return;
    let rounds = [];
    try { rounds = JSON.parse(card.dataset.rounds || "[]"); } catch {}
    const w = Math.floor(Date.now() / WIN) * WIN, left = w + WIN - Date.now();
    const cur = rounds.find((r) => r.c === w + WIN), prev = rounds.find((r) => r.c === w);
    const side = (r) => r.side === "down" ? "↓ Desce" : "↑ Sobe";
    const el = byId("now-status");
    if (cur && (cur.s === "pending" || cur.s === "won" || cur.s === "lost")) {
      el.textContent = "Apostou " + num(cur.cost) + " OOM em " + side(cur) + (cur.prob !== null ? " · chance " + pct(cur.prob) : "");
    } else if (cur) {
      el.textContent = "Pulou esta: " + cur.why.toLowerCase();
    } else if (left <= decideAt * 1000) {
      el.textContent = "Decidindo…";
    } else {
      el.textContent = "O robô aposta nos últimos " + decideAt + "s, no lado em que o preço estiver.";
    }
    const p = byId("now-prev");
    p.textContent = !prev ? ""
      : prev.s === "won" ? "Anterior: ✓ ganhou " + signed(prev.pnl || 0)
      : prev.s === "lost" ? "Anterior: ✕ perdeu " + num(Math.abs(prev.pnl ?? prev.cost))
      : prev.s === "pending" ? "Anterior: ◷ " + num(prev.cost) + " em " + side(prev) + ", aguardando"
      : "Anterior: pulou";
  };

  /* ── Clock ── */
  let nudged = 0;
  const tick = () => {
    const el = byId("countdown");
    const into = Date.now() % WIN, left = WIN - into, lead = decideAt * 1000, decided = left <= lead;
    if (el) {
      byId("countdown-label").textContent = decided ? "Fecha em" : "Decide em";
      el.textContent = mmss(Math.ceil((decided ? left : left - lead) / 1000));
    }
    document.documentElement.classList.toggle("deciding", decided);
    // Fetch the page again a few seconds after the bot decides, to show what it did.
    const w = Date.now() - into;
    if (left < lead - 6000 && nudged !== w) { nudged = w; refresh(); }
    status();
  };

  /* ── Tooltips ── */
  document.addEventListener("pointermove", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const cell = t && t.closest(".grid24 [data-a]");
    document.querySelectorAll(".grid24 .tooltip").forEach((tip) => {
      if (!cell) { tip.hidden = true; return; }
      const fig = tip.parentElement, b = fig.getBoundingClientRect(), c = cell.getBoundingClientRect();
      tip.children[0].textContent = cell.getAttribute("data-a");
      tip.children[1].textContent = cell.getAttribute("data-b");
      tip.style.left = Math.min(Math.max(c.left + c.width / 2 - b.left, 110), b.width - 110) + "px";
      tip.style.top = c.top - b.top + 4 + "px";
      tip.hidden = false;
    });

    const hit = t && t.closest(".chart-hit");
    const fig = hit ? hit.closest("figure[data-points]") : null;
    document.querySelectorAll("figure.chart.hovering").forEach((f) => {
      if (f !== fig) { f.classList.remove("hovering"); f.querySelector(".tooltip").hidden = true; }
    });
    if (!fig) return;
    const pts = JSON.parse(fig.dataset.points);
    const s = fig.querySelector("svg"), box = s.getBoundingClientRect(), scale = s.viewBox.baseVal.width / box.width;
    const x = (e.clientX - box.left) * scale;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
    const cross = fig.querySelector(".cross"), dot = fig.querySelector(".hover-dot"), tip = fig.querySelector(".tooltip");
    cross.setAttribute("x1", best.x); cross.setAttribute("x2", best.x);
    dot.setAttribute("cx", best.x); dot.setAttribute("cy", best.y);
    tip.children[0].textContent = best.v + " OOM";
    tip.children[1].textContent = best.t;
    tip.style.left = best.x / scale + "px";
    tip.style.top = best.y / scale + "px";
    tip.hidden = false;
    fig.classList.add("hovering");
  });

  /* ── Refresh in place ── */
  let fetched = Date.now();
  async function refresh() {
    if (document.hidden) return;
    try {
      const res = await fetch(location.href, { cache: "no-store" });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      document.querySelectorAll("[data-live]").forEach((el) => {
        const next = doc.getElementById(el.id);
        if (next) el.replaceChildren(...Array.from(next.childNodes));
      });
      const next = doc.getElementById("now");
      if (next && card) card.dataset.rounds = next.dataset.rounds;
      document.title = doc.title;
      fetched = Date.now();
      status();
    } catch {}
  }

  tick();
  setInterval(tick, 1000);
  poll();
  setInterval(poll, 1000);
  setInterval(refresh, 30000);
  addEventListener("resize", draw);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    poll();
    if (Date.now() - fetched > 30000) refresh();
  });
})();
`;
