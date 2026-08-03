import type { BetRecord } from "./store.js";

/**
 * One hourly market the bot took a position in. Rounds are numbered chronologically,
 * which is the x axis — "round #7" is more useful than a timestamp when the question
 * is whether the thing is trending up.
 */
export interface Round {
  index: number;
  betEndDate: string;
  /** Net OOMs from this round alone. */
  pnl: number;
  /** Running total across every round so far. */
  cumulative: number;
  bets: number;
  staked: number;
  pending: boolean;
}

/**
 * Groups settled bets into rounds by the market they resolved against. Rounds with
 * nothing settled are left out — a gap in the line is honest, a zero is not.
 */
export function rounds(bets: BetRecord[]): Round[] {
  const byMarket = new Map<string, BetRecord[]>();
  for (const bet of bets) {
    const list = byMarket.get(bet.betEndDate) ?? [];
    list.push(bet);
    byMarket.set(bet.betEndDate, list);
  }

  const settledFirst = [...byMarket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, group]) => group.some((b) => b.status === "won" || b.status === "lost"));

  let cumulative = 0;
  return settledFirst.map(([betEndDate, group], i) => {
    const decided = group.filter((b) => b.status === "won" || b.status === "lost");
    const pnl = round2(
      decided.reduce(
        (sum, b) => sum + (b.status === "won" ? (b.earnings ?? 0) : -b.estimatedCost),
        0,
      ),
    );
    cumulative = round2(cumulative + pnl);

    return {
      index: i + 1,
      betEndDate,
      pnl,
      cumulative,
      bets: decided.length,
      staked: round2(decided.reduce((sum, b) => sum + b.estimatedCost, 0)),
      pending: group.some((b) => b.status === "pending"),
    };
  });
}

// Slot 1 and slot 2 of the categorical order, dark steps. Validated against this
// dashboard's own surface (#0b0e14): lightness band, chroma floor, CVD separation
// ΔE 26.8 protan, and 3:1 contrast all pass.
const CUMULATIVE = "#3987e5";
const PER_ROUND = "#d95926";

const W = 720;
const H = 260;
const PAD = { top: 18, right: 54, bottom: 30, left: 54 };

/**
 * Two panels rather than two lines. Both series are OOMs, but per-round swings ±200
 * while cumulative climbs past 900 — sharing one axis flattens the per-round line into
 * noise, and a second y-scale would be the dual-axis mistake. Small multiples on a
 * shared x axis is the form that keeps both readable.
 *
 * One series per panel, so neither needs a legend: the caption names it.
 */
export function renderChart(data: Round[]): string {
  if (data.length === 0) {
    return `<div class="empty">No settled rounds yet — the chart appears with the first result.</div>`;
  }

  return (
    panel(data, {
      get: (r) => r.pnl,
      color: PER_ROUND,
      caption: `Result of each round on its own, in OOMs. ${data.length} rounds settled.`,
      markers: true,
    }) +
    panel(data, {
      get: (r) => r.cumulative,
      color: CUMULATIVE,
      caption: "Running total of the same rounds, in OOMs.",
      markers: false,
    })
  );
}

function panel(
  data: Round[],
  opts: {
    get: (r: Round) => number;
    color: string;
    caption: string;
    markers: boolean;
  },
): string {
  const values = [...data.map(opts.get), 0];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // Pad the range so the extremes are not welded to the frame, and never divide by 0.
  const span = hi - lo || 1;
  const yMin = lo - span * 0.08;
  const yMax = hi + span * 0.08;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => PAD.top + ((yMax - v) / (yMax - yMin)) * plotH;

  const path = data
    .map((r, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(opts.get(r)).toFixed(1)}`)
    .join(" ");
  const last = data[data.length - 1]!;
  const lastValue = opts.get(last);

  return `
<figure class="chart">
  <figcaption>${esc(opts.caption)}</figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" width="100%"
       aria-label="${esc(opts.caption)} Ends at ${Math.round(lastValue)} OOMs after ${
         data.length
       } rounds.">
    ${axisTicks(yMin, yMax)
      .map(
        (t) => `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(t).toFixed(1)}" y2="${y(
          t,
        ).toFixed(1)}" class="grid"/>
        <text x="${PAD.left - 8}" y="${(y(t) + 3.5).toFixed(1)}" class="tick" text-anchor="end">${t}</text>`,
      )
      .join("")}

    <line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(
      1,
    )}" class="zero"/>

    <path d="${path}" fill="none" stroke="${opts.color}" stroke-width="2"
          stroke-linejoin="round" stroke-linecap="round"/>

    ${data
      .map((r, i) => {
        const tip = `Round ${r.index} — ${r.bets} bet${r.bets > 1 ? "s" : ""}, staked ${
          r.staked
        }, ${r.pnl >= 0 ? "+" : ""}${r.pnl} this round, ${
          r.cumulative >= 0 ? "+" : ""
        }${r.cumulative} cumulative`;

        // Every point is hoverable on both panels; the hit target is wider than the
        // mark. Where the mark is hidden the target is transparent, so the cumulative
        // line stays clean without giving up the tooltip.
        return opts.markers
          ? // A 2px surface ring keeps a marker readable where the line doubles back.
            `<circle cx="${x(i).toFixed(1)}" cy="${y(opts.get(r)).toFixed(1)}" r="4"
               fill="${opts.color}" stroke="var(--bg)" stroke-width="2"><title>${esc(
                 tip,
               )}</title></circle>`
          : `<circle cx="${x(i).toFixed(1)}" cy="${y(opts.get(r)).toFixed(1)}" r="7"
               fill="transparent"><title>${esc(tip)}</title></circle>`;
      })
      .join("")}

    <text x="${W - PAD.right + 8}" y="${(y(lastValue) + 3.5).toFixed(1)}" class="tick"
          style="fill:${opts.color}">${lastValue >= 0 ? "+" : ""}${Math.round(lastValue)}</text>

    ${xLabels(data.length)
      .map(
        (i) =>
          `<text x="${x(i).toFixed(1)}" y="${H - 10}" class="tick" text-anchor="middle">${
            data[i]!.index
          }</text>`,
      )
      .join("")}
  </svg>
</figure>`;
}

function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Four or five round numbers, evenly spaced, so the axis never collides with itself. */
function xLabels(count: number): number[] {
  if (count <= 6) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil(count / 5);
  const picks = [];
  for (let i = 0; i < count; i += step) picks.push(i);
  if (picks[picks.length - 1] !== count - 1) picks.push(count - 1);
  return picks;
}

/**
 * Round tick values covering the range, always including zero. Picks the candidate step
 * whose tick count lands nearest five: taking the first step above range/5 rounds up too
 * eagerly and left a 576-wide range labelled 0, 200, 400 with nothing below the axis.
 */
function axisTicks(min: number, max: number): number[] {
  const range = max - min;
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(range / 5) || 1));
  const candidates = [0.5, 1, 2, 2.5, 5, 10].map((m) => m * magnitude);

  const build = (step: number) => {
    const ticks: number[] = [];
    for (let t = Math.ceil(min / step) * step; t <= max; t += step) {
      ticks.push(Math.round(t * 100) / 100);
    }
    return ticks;
  };

  const best = candidates
    .map((step) => ({ step, count: build(step).length }))
    .filter(({ count }) => count >= 3 && count <= 8)
    .sort((a, b) => Math.abs(a.count - 5) - Math.abs(b.count - 5))[0];

  const ticks = build(best?.step ?? magnitude);
  return ticks.includes(0) ? ticks : [...ticks, 0].sort((a, b) => a - b);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
