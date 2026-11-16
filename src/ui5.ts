import type { Ledger, RoundRecord } from "./rounds.js";

/**
 * The 5-minute bot's page, in Portuguese and written to be read by someone who has not
 * seen the code: the bankroll first, then how it got there, then how the bot thinks,
 * then its last decision spelled out, then every round.
 *
 * Server-rendered. The only script is progressive: a live countdown and a hover readout
 * on the bankroll chart. Every value it shows is also in the table, so nothing is gated
 * behind it.
 *
 * Colour: gain/loss is polarity, so it is the diverging pair (blue ↔ red), validated in
 * both modes (CVD ΔE 21.6 light / 19.2 dark). Won/lost chips are status and always carry
 * an icon and a word. Text never wears a series colour.
 */

export interface RoundsView {
  /** Only rounds where the bot actually bet. */
  onlyBets?: boolean;
}

const TZ = "America/Sao_Paulo";
const MIN_PROB = Number(process.env.FIVEMIN_MIN_PROB ?? "0.7");
const DECIDE_AT = Number(process.env.FIVEMIN_DECIDE_AT ?? "15");

export function renderRounds(
  ledger: Ledger | null,
  rounds: RoundRecord[],
  view: RoundsView = {},
): string {
  const settled = rounds
    .filter((r) => r.status === "won" || r.status === "lost")
    .sort((a, b) => a.closesAt.localeCompare(b.closesAt));
  const pending = rounds.filter((r) => r.status === "pending");
  const atStake = pending.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const equity = ledger ? ledger.bankroll + atStake : null;
  const latest = rounds.find((r) => r.prob !== undefined);
  const shown = (view.onlyBets ? rounds.filter(isBet) : rounds).slice(0, 120);

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>${equity === null ? "" : `${int(equity)} OOM · `}Bitcoin 5 min</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <header class="top">
    <div>
      <div class="eyebrow"><span class="live" aria-hidden="true"></span> Robô ao vivo · Futuur · dinheiro de mentira (OOM)</div>
      <h1>Bitcoin sobe ou desce em 5 minutos</h1>
    </div>
    <div class="next">
      <div class="k">Próxima decisão em</div>
      <div class="countdown" id="countdown" data-decide-at="${DECIDE_AT}">—</div>
    </div>
  </header>

  ${ledger === null ? emptyState() : summary(ledger, equity!, atStake, pending.length, rounds)}

  <section class="card">
    <h2>Evolução da banca</h2>
    <p class="caption">Banca depois de cada aposta liquidada. A linha cinza é o valor inicial — acima dela o robô está ganhando.</p>
    ${bankrollChart(ledger, settled)}
  </section>

  <section class="card">
    <h2>Resultado de cada aposta</h2>
    <p class="caption">Quanto cada rodada ganhou (para cima, azul) ou perdeu (para baixo, vermelho), em OOM.${settled.length > 0 ? ` Últimas ${Math.min(settled.length, 60)} apostas.` : ""}</p>
    ${pnlChart(settled.slice(-60))}
  </section>

  <div class="two">
    ${howItWorks()}
    ${latest ? lastDecision(latest) : ""}
  </div>

  <section class="card">
    <div class="table-head">
      <h2>Todas as rodadas</h2>
      <nav class="filters" aria-label="Filtrar rodadas">
        <a href="/" ${view.onlyBets ? "" : 'aria-current="true"'}>Todas</a>
        <a href="/?ver=apostas" ${view.onlyBets ? 'aria-current="true"' : ""}>Só apostas</a>
        <a href="/rounds">JSON</a>
      </nav>
    </div>
    <p class="caption">Horário de Brasília. Uma linha por janela de 5 minutos, inclusive as que o robô pulou — com o motivo.</p>
    ${table(shown)}
  </section>

  <footer>Atualiza sozinho a cada 30s · <a href="/hourly">histórico do robô horário</a></footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/* ── Summary ─────────────────────────────────────────────────────────────── */

function summary(
  ledger: Ledger,
  equity: number,
  atStake: number,
  pendingCount: number,
  rounds: RoundRecord[],
): string {
  const pnl = equity - ledger.startedWith;
  const decided = ledger.won + ledger.lost;
  const skipped = rounds.filter((r) => r.status === "skipped").length;
  const pct = ledger.startedWith > 0 ? (pnl / ledger.startedWith) * 100 : 0;

  return `<section class="hero card">
    <div class="hero-main">
      <div class="k">Banca agora</div>
      <div class="hero-value">${big(equity)} <span class="unit">OOM</span></div>
      <div class="delta ${pnl >= 0 ? "up" : "down"}">
        <span aria-hidden="true">${pnl >= 0 ? "▲" : "▼"}</span>
        ${signedBig(pnl)} OOM (${Math.abs(pct) >= 1000 ? signedBig(pct) : signed(pct, 1)}%) desde o início com ${int(ledger.startedWith)}
      </div>
      <div class="k small">Começou em ${when(ledger.startedAt, true)}</div>
    </div>
    <div class="tiles">
      ${tile("Acertos", decided === 0 ? "—" : `${Math.round((ledger.won / decided) * 100)}%`, `${ledger.won} ganhas · ${ledger.lost} perdidas`)}
      ${tile("Apostas feitas", int(ledger.bets), `${skipped} rodadas puladas nas últimas ${rounds.length}`)}
      ${tile("Em jogo agora", big(atStake), pendingCount === 0 ? "nenhuma aposta aberta" : `${pendingCount} aposta esperando resultado`)}
      ${tile("Resultado liquidado", signedBig(ledger.settledPnl), "lucro ou prejuízo já pago pela Futuur")}
    </div>
  </section>`;
}

function tile(label: string, value: string, note: string): string {
  return `<div class="tile"><div class="k">${esc(label)}</div><div class="tile-value">${esc(value)}</div><div class="k small">${esc(note)}</div></div>`;
}

function emptyState(): string {
  return `<section class="card empty">
    <h2>Ainda não houve nenhuma rodada</h2>
    <p>A banca de 10.000 OOM é criada na primeira execução. O robô roda a cada 5 minutos — volte em instantes.</p>
  </section>`;
}

/* ── Charts ──────────────────────────────────────────────────────────────── */

const W = 760;

/** Equity after each settled round, rebuilt backwards from the ledger's current total. */
function bankrollChart(ledger: Ledger | null, settled: RoundRecord[]): string {
  if (!ledger || settled.length === 0) {
    return `<div class="chart-empty">O gráfico aparece depois da primeira aposta liquidada.</div>`;
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

  const H = 240;
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
      <text class="ref-label" x="${pad.left + 4}" y="${y(ledger.startedWith) - 6}">início ${int(ledger.startedWith)}</text>
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
      <circle class="dot" cx="${x(series.length - 1)}" cy="${y(last.value)}" r="4"/>
      <text class="end-label" x="${x(series.length - 1) + 10}" y="${y(last.value) + 4}">${big(last.value)}</text>
      <text class="tick" x="${pad.left}" y="${H - 8}">${esc(series[1]?.r ? when(series[1].r.closesAt) : "")}</text>
      <text class="tick" x="${W - pad.right}" y="${H - 8}" text-anchor="end">${esc(last.r ? when(last.r.closesAt) : "")}</text>
      <g class="hover" aria-hidden="true"><line class="cross" y1="${pad.top}" y2="${H - pad.bottom}"/><circle class="hover-dot" r="5"/></g>
      <rect class="hit" x="${pad.left}" y="0" width="${W - pad.left - pad.right}" height="${H}"/>
    </svg>
    <div class="tooltip" hidden><strong></strong><span></span></div>
  </figure>`;
}

/** Signed P&L per settled round as diverging columns from a zero baseline. */
function pnlChart(settled: RoundRecord[]): string {
  if (settled.length === 0) {
    return `<div class="chart-empty">Nenhuma aposta liquidada ainda.</div>`;
  }

  const H = 200;
  const pad = { top: 12, right: 16, bottom: 12, left: 56 };
  const pnls = settled.map((r) => r.pnl ?? 0);
  const [lo, hi, ticks] = niceScale(Math.min(0, ...pnls), Math.max(0, ...pnls));
  const y = (v: number) => pad.top + (1 - (v - lo) / (hi - lo)) * (H - pad.top - pad.bottom);
  const slot = (W - pad.left - pad.right) / settled.length;
  const bar = Math.max(2, Math.min(24, slot - 2));
  const zero = y(0);

  const columns = settled.map((r, i) => {
    const v = r.pnl ?? 0;
    const cx = pad.left + slot * i + slot / 2;
    const top = Math.min(y(v), zero);
    const h = Math.max(1, Math.abs(y(v) - zero));
    const radius = Math.min(4, bar / 2, h);
    const shape = roundedEnd(cx - bar / 2, top, bar, h, radius, v >= 0 ? "top" : "bottom");
    const label = `${when(r.closesAt)} · ${r.side === "down" ? "Desce" : "Sobe"} · ${signed(v)} OOM`;
    return `<g class="col"><rect class="col-hit" x="${pad.left + slot * i}" y="0" width="${slot}" height="${H}"><title>${esc(label)}</title></rect><path class="${v >= 0 ? "gain" : "loss"}" d="${shape}"/></g>`;
  });

  return `<figure class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Resultado das últimas ${settled.length} apostas">
      ${ticks.map((t) => `<line class="grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${pad.left - 8}" y="${y(t) + 4}" text-anchor="end">${t > 0 ? "+" : ""}${compact(t)}</text>`).join("")}
      ${columns.join("")}
      <line class="baseline" x1="${pad.left}" x2="${W - pad.right}" y1="${zero}" y2="${zero}"/>
    </svg>
  </figure>`;
}

/** A column with 4px rounded corners at its data end and square at the baseline. */
function roundedEnd(x: number, y: number, w: number, h: number, r: number, end: "top" | "bottom"): string {
  const f = (n: number) => n.toFixed(1);
  if (end === "top") {
    return `M${f(x)},${f(y + h)}V${f(y + r)}Q${f(x)},${f(y)} ${f(x + r)},${f(y)}H${f(x + w - r)}Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)}V${f(y + h)}Z`;
  }
  return `M${f(x)},${f(y)}V${f(y + h - r)}Q${f(x)},${f(y + h)} ${f(x + r)},${f(y + h)}H${f(x + w - r)}Q${f(x + w)},${f(y + h)} ${f(x + w)},${f(y + h - r)}V${f(y)}Z`;
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

/* ── Explainers ──────────────────────────────────────────────────────────── */

function howItWorks(): string {
  return `<section class="card">
    <h2>Como o robô joga</h2>
    <p class="caption">Uma janela de 5 minutos, em escala:</p>
    <div class="window" role="img" aria-label="Linha do tempo de uma janela de 5 minutos: o mercado abre no minuto 1, o robô aposta nos últimos ${DECIDE_AT} segundos">
      <div class="seg closed" style="flex:60">fechado</div>
      <div class="seg open" style="flex:${240 - DECIDE_AT}">aberto · robô só observa</div>
      <div class="seg act" style="flex:${DECIDE_AT}"></div>
    </div>
    <div class="window-axis">
      <span style="left:0">0:00</span><span style="left:20%">1:00</span><span style="right:0">5:00</span>
    </div>
    <div class="window-note">últimos ${DECIDE_AT}s: o robô aposta <span class="key" aria-hidden="true"></span></div>
    <ol class="steps">
      <li><b>A pergunta.</b> O preço do Bitcoin vai fechar estes 5 minutos <b>acima</b> (Sobe) ou <b>abaixo</b> (Desce) do preço em que abriu? A Futuur usa o candle de 5 min da Binance.</li>
      <li><b>A brecha.</b> A Futuur vende cada lado por cerca de <b>0,51 OOM</b> e não muda esse preço quando o Bitcoin se mexe. Cada cota certa paga <b>1 OOM</b>.</li>
      <li><b>A leitura.</b> Faltando ${DECIDE_AT} segundos, o robô vê de que lado o preço está e calcula a chance de ele continuar ali até o fim.</li>
      <li><b>A aposta.</b> Só compra se a chance for de pelo menos ${Math.round(MIN_PROB * 100)}% e o preço for bem menor que essa chance. Quanto maior a certeza, maior a aposta — perto de 99% ela vai quase toda a banca.</li>
    </ol>
  </section>`;
}

/** The most recent decision, spelled out as a sentence and a two-bar comparison. */
function lastDecision(r: RoundRecord): string {
  const side = r.side === "down" ? "Desce" : "Sobe";
  const gap = r.gap ?? 0;
  const bet = isBet(r);
  const prob = r.prob ?? 0;
  const price = r.avgPrice ?? r.bestAsk ?? null;
  const payout = r.shares ?? 0;

  const outcome =
    r.status === "won" ? chip("won") + ` <span>Fechou em ${side}: recebeu ${int(payout)} OOM, lucro de ${signed(r.pnl ?? 0)}.</span>`
    : r.status === "lost" ? chip("lost") + ` <span>Não fechou em ${side}: perdeu ${int(r.cost ?? 0)} OOM.</span>`
    : r.status === "pending" ? chip("pending") + ` <span>Se fechar em ${side}, recebe ${int(payout)} OOM (lucro de ${signed(payout - (r.cost ?? 0))}). Se não, perde ${int(r.cost ?? 0)}.</span>`
    : chip(r.status) + ` <span>${esc(explainSkip(r))}</span>`;

  return `<section class="card">
    <h2>Última decisão</h2>
    <p class="caption">Rodada que fechou às ${when(r.closesAt)}.</p>
    <dl class="facts">
      <div><dt>Preço a bater</dt><dd>$${money(r.priceToBeat ?? 0)}</dd></div>
      <div><dt>Bitcoin agora</dt><dd>$${money(r.spot ?? 0)}</dd></div>
      <div><dt>Diferença</dt><dd>${gap >= 0 ? "+" : "−"}$${money(Math.abs(gap))}</dd></div>
      <div><dt>Faltavam</dt><dd>${(r.secondsLeft ?? 0).toFixed(0)}s</dd></div>
    </dl>
    <p class="explain">O Bitcoin estava <b>${gap >= 0 ? "acima" : "abaixo"}</b> da linha, então o lado provável era <b>${side}</b>.</p>
    <div class="meters">
      <div class="meter-row"><span>Chance estimada de ${side}</span><div class="track"><div class="fill chance" style="width:${(prob * 100).toFixed(1)}%"></div></div><b>${chance(prob)}</b></div>
      ${price === null ? "" : `<div class="meter-row"><span>Preço ${bet ? "médio pago" : "na Futuur"} por cota</span><div class="track"><div class="fill price" style="width:${(price * 100).toFixed(1)}%"></div></div><b>${dec(price, 2)}</b></div>`}
    </div>
    ${price !== null && prob > price ? `<p class="explain">A diferença entre as duas barras é a <b>vantagem</b>: ${Math.round((prob - price) * 100)} pontos. Pagar ${dec(price, 2)} por algo que vale ${dec(prob, 2)} dá lucro na média.</p>` : ""}
    ${bet ? `<p class="explain">Comprou <b>${int(r.shares ?? 0)} cotas</b> por <b>${int(r.cost ?? 0)} OOM</b>.</p>` : ""}
    <p class="outcome">${outcome}</p>
  </section>`;
}

/* ── Table ───────────────────────────────────────────────────────────────── */

function table(rounds: RoundRecord[]): string {
  if (rounds.length === 0) return `<div class="chart-empty">Nada por aqui ainda.</div>`;
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Fechou</th><th>Situação</th><th>Lado</th><th class="n">Diferença</th><th class="n">Chance</th>
      <th class="n">Apostou</th><th class="n">Preço médio</th><th class="n">Resultado</th><th class="n">Banca</th>
    </tr></thead>
    <tbody>${rounds.map(row).join("")}</tbody>
  </table></div>`;
}

function row(r: RoundRecord): string {
  const head = `<td>${when(r.closesAt)}</td><td>${chip(r.status)}${r.dryRun ? ' <span class="k small">simulação</span>' : ""}</td>`;
  const side = r.side ? `${r.side === "down" ? "↓ Desce" : "↑ Sobe"}` : "";
  const gap = r.gap === undefined ? "" : `${r.gap >= 0 ? "+" : "−"}$${money(Math.abs(r.gap))}`;
  const prob = r.prob === undefined ? "" : chance(r.prob);

  if (!isBet(r)) {
    return `<tr class="muted">${head}<td>${side}</td><td class="n">${gap}</td><td class="n">${prob}</td><td colspan="4" class="why">${esc(explainSkip(r))}</td></tr>`;
  }

  const pnl = r.pnl === undefined ? "" : `<span class="${r.pnl >= 0 ? "t-up" : "t-down"}">${signed(r.pnl)}</span>`;
  return `<tr>${head}<td>${side}</td><td class="n">${gap}</td><td class="n">${prob}</td>
    <td class="n">${int(r.cost ?? 0)}</td><td class="n">${r.avgPrice ? dec(r.avgPrice, 3) : ""}</td>
    <td class="n">${pnl}</td><td class="n">${r.bankrollAfter === undefined ? "" : int(r.bankrollAfter)}</td></tr>`;
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

/** The handler's skip reasons are terse and in English; this says them plainly. */
function explainSkip(r: RoundRecord): string {
  const reason = r.reason ?? "";
  if (r.status === "failed") return `Erro: ${r.error ?? reason}`;
  if (r.status === "unfilled") return "A ordem não foi executada — nada foi cobrado.";
  if (reason.startsWith("dry run")) return "Simulação: teria apostado aqui, mas o modo de teste está ligado.";
  if (r.prob !== undefined && r.prob < MIN_PROB) {
    return `Perto demais da linha: só ${(r.prob * 100).toFixed(0)}% de chance — praticamente cara ou coroa.`;
  }
  if (reason.startsWith("no edge")) return "O preço na Futuur estava alto demais para valer a pena.";
  if (reason.startsWith("line mismatch")) return "O preço a bater da Futuur não bateu com a Binance — não dava para confiar.";
  if (reason.startsWith("nothing to stake")) return "Sem saldo para apostar.";
  if (reason.startsWith("woke up too late")) return "Acordou tarde demais para apostar com segurança.";
  if (reason.startsWith("order canceled")) return "A Futuur cancelou a ordem — nada foi cobrado.";
  if (reason.startsWith("no volatility")) return "Não conseguiu medir a volatilidade do Bitcoin.";
  return reason;
}

/** 0.999 is not 100%: the bot can still lose it. */
function chance(p: number): string {
  if (p >= 0.995) return ">99%";
  if (p <= 0.005) return "<1%";
  return `${Math.round(p * 100)}%`;
}

/** Decimal in Brazilian notation: 0,57. */
function dec(value: number, digits: number): string {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function isBet(r: RoundRecord): boolean {
  return r.status === "pending" || r.status === "won" || r.status === "lost";
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

const timeFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });

function when(iso: string, withDay = false): string {
  const d = new Date(iso);
  const sameDay = dayFmt.format(d) === dayFmt.format(new Date());
  return withDay || !sameDay ? `${dayFmt.format(d)} ${timeFmt.format(d)}` : timeFmt.format(d);
}

function int(value: number): string {
  return Math.round(value).toLocaleString("pt-BR");
}

function money(value: number): string {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

/** Full figures while they fit a tile, compact past a million. */
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
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,.10);
  --gain: #2a78d6; --loss: #e34948; --gain-wash: rgba(42,120,214,.10); --price: #c3c2b7;
  --good: #0ca30c; --critical: #d03b3b; --warning: #fab219;
  --t-up: #006300; --t-down: #b42318;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,.10);
    --gain: #3987e5; --loss: #e66767; --gain-wash: rgba(57,135,229,.12); --price: #52514e;
    --t-up: #0ca30c; --t-down: #e66767;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 20px 64px; display: grid; gap: 20px; }
a { color: var(--gain); }
h1 { font-size: 28px; line-height: 1.2; margin: 4px 0 0; font-weight: 650; letter-spacing: -.01em; }
h2 { font-size: 17px; margin: 0 0 4px; font-weight: 620; }
b { font-weight: 620; }
.k { color: var(--ink-2); font-size: 13px; }
.small { font-size: 12px; color: var(--muted); }
.caption { color: var(--ink-2); font-size: 13px; margin: 0 0 16px; }
.card { background: var(--surface); border: 1px solid var(--ring); border-radius: 16px; padding: 22px 24px; }
.top { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.eyebrow { color: var(--ink-2); font-size: 13px; display: flex; align-items: center; gap: 8px; }
.live { width: 8px; height: 8px; border-radius: 50%; background: var(--good); box-shadow: 0 0 0 3px rgba(12,163,12,.18); }
.next { text-align: right; }
.countdown { font-size: 22px; font-weight: 620; font-variant-numeric: tabular-nums; }

.hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 28px; align-items: center; }
.hero-value { font-size: 52px; line-height: 1.05; font-weight: 650; letter-spacing: -.02em; margin: 4px 0 8px; }
.unit { font-size: 20px; color: var(--ink-2); font-weight: 500; letter-spacing: 0; }
.delta { font-size: 14px; font-weight: 560; margin-bottom: 6px; }
.delta.up { color: var(--t-up); } .delta.down { color: var(--t-down); }
.tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.hero-main, .tile { min-width: 0; overflow-wrap: anywhere; }
.tile { border: 1px solid var(--ring); border-radius: 12px; padding: 14px 16px; }
.tile-value { font-size: 24px; font-weight: 620; margin: 2px 0; }

.chart { margin: 0; position: relative; }
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.grid { stroke: var(--grid); stroke-width: 1; }
.baseline { stroke: var(--axis); stroke-width: 1; }
.ref { stroke: var(--muted); stroke-width: 1; }
.ref-label, .tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.end-label { fill: var(--ink); font-size: 13px; font-weight: 620; }
.line { fill: none; stroke: var(--gain); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.area { fill: var(--gain-wash); }
.dot, .hover-dot { fill: var(--gain); stroke: var(--surface); stroke-width: 2; }
.hover { display: none; } .chart.hovering .hover { display: block; }
.cross { stroke: var(--axis); stroke-width: 1; }
.hit { fill: transparent; cursor: crosshair; }
.gain { fill: var(--gain); } .loss { fill: var(--loss); }
.col-hit { fill: transparent; }
.col:hover path { opacity: .75; }
.tooltip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--ring);
  border-radius: 8px; padding: 6px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.12);
  display: grid; transform: translate(-50%, calc(-100% - 12px)); white-space: nowrap; }
.tooltip[hidden] { display: none; }
.tooltip strong { font-size: 14px; } .tooltip span { color: var(--ink-2); }
.chart-empty { color: var(--muted); padding: 28px 0; text-align: center; border: 1px solid var(--grid); border-radius: 12px; }

.two { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.two > :only-child { grid-column: 1 / -1; }
.window { display: flex; gap: 2px; height: 34px; margin-top: 8px; font-size: 12px; }
.seg { display: flex; align-items: center; justify-content: center; border-radius: 6px; padding: 0 6px; min-width: 0; text-align: center; line-height: 1.15; }
.seg.closed { background: var(--grid); color: var(--ink-2); }
.seg.open { background: var(--gain-wash); color: var(--ink-2); border: 1px solid var(--ring); }
.seg.act { background: var(--gain); min-width: 6px; }
.window-axis { position: relative; height: 16px; color: var(--muted); font-size: 11px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.window-axis span { position: absolute; }
.window-note { text-align: right; font-size: 12px; color: var(--ink-2); margin: 2px 0 14px; display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
.key { width: 10px; height: 10px; border-radius: 3px; background: var(--gain); }
.steps { margin: 0; padding-left: 20px; display: grid; gap: 10px; color: var(--ink-2); font-size: 14px; }
.steps b { color: var(--ink); }

.facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0 0 12px; }
.facts div { border: 1px solid var(--ring); border-radius: 10px; padding: 8px 10px; }
.facts dt { font-size: 11px; color: var(--muted); } .facts dd { margin: 0; font-weight: 620; font-size: 14px; }
.explain { color: var(--ink-2); font-size: 14px; margin: 10px 0; } .explain b { color: var(--ink); }
.meters { display: grid; gap: 8px; }
.meter-row { display: grid; grid-template-columns: 11rem 1fr 3rem; gap: 10px; align-items: center; font-size: 13px; color: var(--ink-2); }
.meter-row b { text-align: right; color: var(--ink); font-variant-numeric: tabular-nums; }
.track { height: 8px; border-radius: 4px; background: var(--grid); overflow: hidden; }
.fill { height: 100%; border-radius: 4px; } .fill.chance { background: var(--gain); } .fill.price { background: var(--muted); }
.outcome { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin: 14px 0 0; font-size: 14px; }

.table-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.filters { display: flex; gap: 4px; }
.filters a { text-decoration: none; color: var(--ink-2); font-size: 13px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--ring); }
.filters a[aria-current] { background: var(--ink); color: var(--surface); border-color: var(--ink); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; padding: 8px 10px 8px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; }
td { padding: 9px 10px 9px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; }
.n { text-align: right; }
tr.muted td { color: var(--ink-2); }
td.why { white-space: normal; color: var(--muted); }
.t-up { color: var(--t-up); font-weight: 600; } .t-down { color: var(--t-down); font-weight: 600; }
.chip { display: inline-flex; gap: 5px; align-items: center; font-size: 12px; font-weight: 560; padding: 2px 9px 2px 7px; border-radius: 999px; border: 1px solid var(--ring); color: var(--ink); }
.chip.won span { color: var(--good); } .chip.lost span { color: var(--critical); }
.chip.pending span { color: var(--warning); } .chip.failed span { color: var(--critical); }
.chip.skipped, .chip.unfilled { color: var(--ink-2); }
footer { color: var(--muted); font-size: 12px; text-align: center; }

@media (max-width: 760px) {
  .hero, .two { grid-template-columns: 1fr; }
  .facts { grid-template-columns: repeat(2, 1fr); }
  .meter-row { grid-template-columns: 8rem 1fr 2.5rem; }
  .hero-value { font-size: 44px; }
}
`;

/**
 * Countdown to the next decision (FIVEMIN_DECIDE_AT seconds before each 5-minute close)
 * and the bankroll chart's crosshair. Labels go in with textContent, never innerHTML.
 */
const SCRIPT = `
(() => {
  const el = document.getElementById("countdown");
  const lead = Number(el?.dataset.decideAt || 15) * 1000;
  const tick = () => {
    const now = Date.now(), win = 300000;
    let next = Math.ceil(now / win) * win - lead;
    if (next <= now) next += win;
    const s = Math.round((next - now) / 1000);
    el.textContent = s <= 1 ? "decidindo…" : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  if (el) { tick(); setInterval(tick, 1000); }

  document.querySelectorAll("figure[data-points]").forEach((fig) => {
    const pts = JSON.parse(fig.dataset.points);
    const svg = fig.querySelector("svg"), hit = fig.querySelector(".hit");
    const cross = fig.querySelector(".cross"), dot = fig.querySelector(".hover-dot");
    const tip = fig.querySelector(".tooltip"), [val, lab] = tip.children;
    const move = (e) => {
      const box = svg.getBoundingClientRect(), scale = svg.viewBox.baseVal.width / box.width;
      const x = (e.clientX - box.left) * scale;
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
      cross.setAttribute("x1", best.x); cross.setAttribute("x2", best.x);
      dot.setAttribute("cx", best.x); dot.setAttribute("cy", best.y);
      val.textContent = best.v + " OOM"; lab.textContent = best.t;
      tip.style.left = (best.x / scale) + "px"; tip.style.top = (best.y / scale) + "px";
      tip.hidden = false; fig.classList.add("hovering");
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", () => { tip.hidden = true; fig.classList.remove("hovering"); });
  });
})();
`;
