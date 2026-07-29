// ============================================================================
// views/charts.js — SVG charts puros (sem libs, sem bundler)
// ============================================================================

import { escapeHtml, formatCurrency, formatCurrencyShort } from '../finance-core.js?v=20260727-finance-v87';

export const DONUT_PALETTE = ['#22d3ee','#f87171','#fbbf24','#4ade80','#a78bfa','#fb923c','#38bdf8','#f472b6'];

/** Barras agrupadas Receita vs Despesa. series: [{mes,income,expense}] */
export function renderBarChart(series = []) {
  const W = 560, H = 260, padX = 42, padTop = 14, padBot = 32, innerH = H - padTop - padBot;
  if (!series.length) return '<div class="empty-state-sm">Sem histórico de fluxo ainda.</div>';

  const max = Math.max(1, ...series.flatMap((d) => [Number(d.income) || 0, Number(d.expense) || 0]));
  const step = (W - padX * 2) / series.length;
  const bw = Math.max(8, Math.min(18, step / 3.2));
  const yPos = (v) => padTop + innerH - ((v / max) * innerH);
  const base = padTop + innerH;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const gy = (padTop + innerH - t * innerH).toFixed(1);
    return `<line x1="${padX}" y1="${gy}" x2="${W - padX}" y2="${gy}" class="chart-grid"/>
<text x="${(padX - 5)}" y="${(Number(gy) + 3).toFixed(1)}" class="chart-axis" text-anchor="end">${formatCurrencyShort(t * max)}</text>`;
  }).join('');

  const bars = series.map((d, i) => {
    const cx = padX + step * i + step / 2;
    const inc = Number(d.income) || 0;
    const exp = Number(d.expense) || 0;
    const yi = yPos(inc), ye = yPos(exp);
    return `<rect x="${(cx - bw - 2).toFixed(1)}" y="${yi.toFixed(1)}" width="${bw}" height="${(base - yi).toFixed(1)}" rx="3" class="bar-income"><title>${escapeHtml(d.mes)} Receita ${formatCurrency(inc)}</title></rect>
<rect x="${(cx + 2).toFixed(1)}" y="${ye.toFixed(1)}" width="${bw}" height="${(base - ye).toFixed(1)}" rx="3" class="bar-expense"><title>${escapeHtml(d.mes)} Despesa ${formatCurrency(exp)}</title></rect>
<text x="${cx.toFixed(1)}" y="${H - 8}" class="chart-axis" text-anchor="middle">${escapeHtml(d.mes)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Fluxo de caixa 6 meses">${grid}${bars}</svg>`;
}

/** Linha de tendência. points: [{label,value}] — usa zero como base, aceita negativos. */
export function renderLineChart(points = []) {
  const W = 560, H = 200, padX = 44, padTop = 16, padBot = 28, innerH = H - padTop - padBot;
  if (!points.length) return '<div class="empty-state-sm">Sem dados para a tendência.</div>';
  const vals = points.map((p) => Number(p.value) || 0);
  const max = Math.max(1, ...vals);
  const min = Math.min(0, ...vals);
  const range = (max - min) || 1;
  const x = (i) => padX + (i * (W - 2 * padX) / Math.max(1, points.length - 1));
  const y = (v) => padTop + innerH - ((v - min) / range) * innerH;
  const zeroY = y(0);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(vals[i]).toFixed(1)}`).join(' ');
  const area = `${path} L${x(points.length - 1).toFixed(1)} ${zeroY.toFixed(1)} L${x(0).toFixed(1)} ${zeroY.toFixed(1)} Z`;
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(vals[i]).toFixed(1)}" r="3.2" class="line-dot ${vals[i] < 0 ? 'line-dot--neg' : ''}"><title>${escapeHtml(p.label)} ${formatCurrency(vals[i])}</title></circle>`).join('');
  const labels = points.map((p, i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="chart-axis" text-anchor="middle">${escapeHtml(p.label)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Tendência">
<line x1="${padX}" y1="${zeroY.toFixed(1)}" x2="${W - padX}" y2="${zeroY.toFixed(1)}" class="chart-grid"/>
<text x="${(padX - 6)}" y="${(zeroY + 3).toFixed(1)}" class="chart-axis" text-anchor="end">0</text>
<path d="${area}" fill="var(--acc-bg)" stroke="none"/>
<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2"/>
${dots}${labels}</svg>`;
}

/** Donut por categoria. slices: [{label,value,color,classe}].
 *  opts: { caption, ariaLabel, emptyMessage } — caption é o rótulo do centro. */
export function renderDonutChart(slices = [], opts = {}) {
  const caption = opts.caption || 'DESPESAS';
  const emptyMessage = opts.emptyMessage || 'Lance despesas para ver a composicao.';
  const S = 180, r = 70, sw = 26, c = S / 2, circ = 2 * Math.PI * r;
  const total = slices.reduce((s, x) => s + (Number(x.value) || 0), 0);
  if (total <= 0) return `<div class="empty-state-sm">${escapeHtml(emptyMessage)}</div>`;

  let acc = 0;
  const arcs = slices.map((sl) => {
    const len = ((Number(sl.value) || 0) / total) * circ;
    const seg = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${sl.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${c} ${c})"><title>${escapeHtml(sl.label)} ${((len / circ) * 100).toFixed(1)}%</title></circle>`;
    acc += len;
    return seg;
  }).join('');

  return `<svg viewBox="0 0 ${S} ${S}" class="donut-svg" role="img" aria-label="${escapeHtml(opts.ariaLabel || `Composicao de ${caption.toLowerCase()}`)}">
${arcs}
<text x="${c}" y="${c - 2}" text-anchor="middle" class="donut-center-val">${formatCurrencyShort(total)}</text>
<text x="${c}" y="${c + 12}" text-anchor="middle" class="donut-center-cap">${escapeHtml(caption)}</text>
</svg>`;
}

/** Agrupa valores por rótulo e devolve fatias prontas pro donut (top N + "Outros"). */
export function buildPieSlices(pairs = [], { topN = 7 } = {}) {
  const porLabel = new Map();
  for (const [label, value] of pairs) {
    const v = Number(value) || 0;
    if (v <= 0) continue;
    const k = label || 'Sem categoria';
    porLabel.set(k, (porLabel.get(k) || 0) + v);
  }
  const ordenado = [...porLabel.entries()].sort((a, b) => b[1] - a[1]);
  const top = ordenado.slice(0, topN);
  const resto = ordenado.slice(topN).reduce((s, [, v]) => s + v, 0);
  if (resto > 0) top.push(['Outros', resto]);
  return top.map(([label, value], i) => ({
    label, value, color: DONUT_PALETTE[i % DONUT_PALETTE.length]
  }));
}
