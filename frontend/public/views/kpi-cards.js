// ============================================================================
// views/kpi-cards.js — 6 KPI cards ricos com mini-gráficos inline
// ============================================================================

import {
  state, escapeHtml, formatCurrency, formatCurrencyShort, formatPercent,
  receitasMes, despesasMes, saldoTotal, totalReceber, totalPagar, contasDoWorkspace, dateToInput
} from '../finance-core.js?v=20260727-finance-v87';
import { selectDonut, selectCashflow6m } from './dashboard-store.js?v=20260727-finance-v87';
import { soma } from '../lib/money.js?v=20260727-finance-v87';
import { icon } from '../lib/vendor/lucide.min.js?v=20260727-finance-v87';

const baseValue = (item, field = 'valor') => Number(item?.[`${field}_base`] ?? item?.[field] ?? 0);
const baseOutstanding = (item) => Number.isFinite(Number(item?.saldo_base))
  ? Number(item.saldo_base)
  : Math.max(0, baseValue(item, 'valor') - baseValue(item, 'valor_pago'));

// ── Helpers de dado ──────────────────────────────────────────────────────────

function sparklineDays(tipo, days = 7) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getTime() - (days - 1 - i) * 86400000);
    return { date: dateToInput(d), total: 0 };
  });
  const map = {};
  buckets.forEach((b) => { map[b.date] = b; });
  (state.data.transacoes || [])
    .filter((t) => t.tipo === tipo && map[String(t.data || '').slice(0, 10)])
    .forEach((t) => { map[String(t.data).slice(0, 10)].total += baseValue(t); });
  return buckets;
}

function cashflowDelta(field) {
  const m6 = selectCashflow6m(state);
  if (m6.length < 2) return null;
  const curr = Number(m6[m6.length - 1][field] || 0);
  const prev = Number(m6[m6.length - 2][field] || 0);
  if (!prev) return null;
  return ((curr - prev) / prev) * 100;
}

function receberBreakdown() {
  const list = state.data.contasReceber || [];
  return {
    pendente: soma(list.filter((r) => r.status === 'pendente'), baseOutstanding),
    vencido: soma(list.filter((r) => r.status === 'vencido'), baseOutstanding),
    parcial: soma(list.filter((r) => r.status === 'parcial'), baseOutstanding)
  };
}

function pagarUrgency() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const itens = (state.data.contasPagar || [])
    .filter((p) => ['pendente', 'vencido', 'parcial'].includes(p.status))
    .map((p) => {
      const raw = String(p.vencimento || '').split('T')[0];
      const due = new Date(raw + 'T00:00:00');
      const diff = Math.round((due - today) / 86400000);
      const bucket = diff <= 0 ? 'vencido' : diff <= 7 ? 'semana' : 'futuro';
      return { bucket, rest: baseOutstanding(p) };
    });
  return {
    vencido: soma(itens.filter((i) => i.bucket === 'vencido'), (i) => i.rest),
    semana: soma(itens.filter((i) => i.bucket === 'semana'), (i) => i.rest),
    futuro: soma(itens.filter((i) => i.bucket === 'futuro'), (i) => i.rest)
  };
}

// ── Helpers de SVG ───────────────────────────────────────────────────────────

function sparklineSVG(buckets, color) {
  const W = 120, H = 32;
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const n = buckets.length, step = W / n, bw = step * 0.58;
  const bars = buckets.map((b, i) => {
    const bh = b.total > 0 ? Math.max(3, (b.total / max) * H) : 1.5;
    const x = i * step + (step - bw) / 2;
    return `<rect x="${x.toFixed(1)}" y="${(H - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${color}" opacity="${b.total === 0 ? '0.18' : '1'}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="kpi-spark" aria-hidden="true">${bars}</svg>`;
}

function stackBarHTML(segs) {
  // segs: [{label, value, color}]
  const total = segs.reduce((s, x) => s + x.value, 0);
  if (!total) return '<div class="kpi-stack-bar" style="background:var(--s2)"></div>';
  const inner = segs.filter((s) => s.value > 0).map((s) => {
    const pct = ((s.value / total) * 100).toFixed(1);
    return `<div class="kpi-stack-seg" style="flex:${s.value};background:${s.color}" title="${escapeHtml(s.label)}: ${formatCurrency(s.value)} (${pct}%)"></div>`;
  }).join('');
  return `<div class="kpi-stack-bar">${inner}</div>`;
}

function miniDonutSVG(fixedPct) {
  const varPct = 100 - fixedPct;
  const r = 16, sw = 9, c = 20, circ = 2 * Math.PI * r;
  const fixedLen = (fixedPct / 100) * circ;
  const varLen   = (varPct  / 100) * circ;
  return `<svg viewBox="0 0 40 40" class="kpi-mini-donut" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="${sw}" stroke-dasharray="${fixedLen.toFixed(1)} ${varLen.toFixed(1)}" transform="rotate(-90 ${c} ${c})"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--yellow)" stroke-width="${sw}" stroke-dasharray="${varLen.toFixed(1)} ${fixedLen.toFixed(1)}" stroke-dashoffset="${(-fixedLen).toFixed(1)}" transform="rotate(-90 ${c} ${c})"/>
  </svg>`;
}

function deltaBadge(pct, invertGood = false) {
  if (pct === null || pct === undefined) return '';
  const isGood = invertGood ? pct <= 0 : pct >= 0;
  const cls    = isGood ? 'kpi-delta-good' : 'kpi-delta-bad';
  const arrow  = icon(pct >= 0 ? 'trending-up' : 'trending-down', { size: 12 });
  return `<span class="kpi-delta ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}% vs ant.</span>`;
}

function urgencyBarsSVG(vencido, semana, futuro) {
  const total = vencido + semana + futuro || 1;
  const W = 120, H = 10, gap = 3;
  const vPct = vencido / total, sPct = semana / total, fPct = futuro / total;
  const available = W - gap * 2;
  const vW = Math.max(0, vPct * available), sW = Math.max(0, sPct * available), fW = Math.max(0, fPct * available);
  let x = 0;
  const rects = [
    vW > 0 ? `<rect x="${x.toFixed(1)}" y="0" width="${vW.toFixed(1)}" height="${H}" rx="3" fill="var(--red)" opacity="0.9"><title>Vencido ${formatCurrency(vencido)}</title></rect>` : '',
    sW > 0 ? `<rect x="${(x += vW + (vW > 0 ? gap : 0)).toFixed(1)}" y="0" width="${sW.toFixed(1)}" height="${H}" rx="3" fill="var(--yellow)" opacity="0.9"><title>7 dias ${formatCurrency(semana)}</title></rect>` : '',
    fW > 0 ? `<rect x="${(x += sW + (sW > 0 ? gap : 0)).toFixed(1)}" y="0" width="${fW.toFixed(1)}" height="${H}" rx="3" fill="var(--accent)" opacity="0.9"><title>Restante ${formatCurrency(futuro)}</title></rect>` : ''
  ].join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="kpi-urg-svg" aria-hidden="true">${rects}</svg>`;
}

function marginProgressHTML(margem) {
  const pct    = Math.max(0, Math.min(100, margem));
  const color  = margem < 0 ? 'var(--red)' : margem < 15 ? 'var(--yellow)' : margem < 30 ? 'var(--blue)' : 'var(--green)';
  const zone   = margem < 0 ? 'Prejuízo' : margem < 15 ? 'Margem baixa' : margem < 30 ? 'Margem razoável' : 'Margem saudável';
  return `<div class="kpi-progress-wrap">
    <div class="kpi-progress-track"><div class="kpi-progress-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>
      <div class="kpi-progress-ref" style="left:30%" title="Meta 30%"></div>
    </div>
    <div class="kpi-progress-labels"><span style="color:${color};font-weight:600;">${zone}</span><span class="kpi-muted">meta ≥ 30%</span></div>
  </div>`;
}

function subRow(items) {
  // items: [{dot, label, val}]
  const spans = items.map((it) => `<span><i class="kpi-dot" style="background:${it.dot}"></i>${escapeHtml(it.label)}<strong>${it.val}</strong></span>`).join('');
  return `<div class="kpi-sub-row">${spans}</div>`;
}

function acctRows() {
  // Escopo do workspace ativo — coerente com saldoTotal()/contasDoWorkspace().
  const contas = contasDoWorkspace();
  const total  = contas.reduce((s, c) => s + Number(c.saldo || 0), 0) || 1;
  const mixedCurrencies = new Set(contas.map((c) => String(c.moeda || 'BRL').toUpperCase())).size > 1;
  if (!contas.length) return '<div class="kpi-muted" style="font-size:11px;">Nenhuma conta.</div>';
  return contas.slice(0, 3).map((c) => {
    const pct  = Math.max(0, ((Number(c.saldo || 0) / total) * 100));
    const cor  = escapeHtml(c.cor || '#22d3ee');
    const nome = escapeHtml((c.nome || '').split(' ').slice(0, 2).join(' '));
    return `<div class="kpi-acct-row">
      <span class="kpi-acct-dot" style="background:${cor}"></span>
      <span class="kpi-acct-name">${nome}</span>
      <div class="kpi-acct-track">${mixedCurrencies ? '' : `<div class="kpi-acct-fill" style="width:${pct.toFixed(0)}%;background:${cor}"></div>`}</div>
      <span class="kpi-acct-pct">${mixedCurrencies ? escapeHtml(c.moeda || 'BRL') : `${pct.toFixed(0)}%`}</span>
      <span class="kpi-acct-val">${formatCurrencyShort(Number(c.saldo || 0), c.moeda)}</span>
    </div>`;
  }).join('');
}

// ── Shell ────────────────────────────────────────────────────────────────────

function shell(kind, head, value, chart, sub) {
  return `<div class="kpi-card kpi-${kind} kpi-rich">
  <div class="kpi-rich-head">${head}</div>
  <span class="kpi-value">${value}</span>
  <div class="kpi-chart-area">${chart}</div>
  ${sub ? `<div class="kpi-sub-area">${sub}</div>` : ''}
</div>`;
}

// ── 6 Cards públicos ─────────────────────────────────────────────────────────

/** Card 1 — Caixa total: distribuição por conta + barras */
export function cardCaixaTotal() {
  const total  = saldoTotal();
  const nContas = contasDoWorkspace().length;
  return shell('primary',
    `<span class="kpi-label">Caixa total</span><span class="kpi-badge-neu">${nContas} conta${nContas !== 1 ? 's' : ''}</span>`,
    formatCurrency(total),
    `<div class="kpi-acct-list">${acctRows()}</div>`,
    ''
  );
}

/** Card 2 — Receitas mês: sparkline 7 dias + delta vs mês anterior */
export function cardReceitasMes() {
  const val    = receitasMes();
  const spark  = sparklineDays('receita', 7);
  const sumWk  = spark.reduce((s, b) => s + b.total, 0);
  const delta  = cashflowDelta('income');
  const pctWk  = val > 0 ? ((sumWk / val) * 100).toFixed(0) : 0;
  return shell('success',
    `<span class="kpi-label">Receitas mês</span>${deltaBadge(delta)}`,
    formatCurrency(val),
    sparklineSVG(spark, 'var(--green)'),
    subRow([
      { dot: 'var(--green)', label: 'Últ. 7 dias', val: formatCurrencyShort(sumWk) },
      { dot: 'transparent',  label: '',             val: `${pctWk}% do mês` }
    ])
  );
}

/** Card 3 — Despesas mês: mini donut fixo/variável quando há lastro; senão, sparkline 7d */
export function cardDespesasMes() {
  const val      = despesasMes();
  const donut    = selectDonut(state);
  const delta    = cashflowDelta('expense');
  // A classificação Fixo/Variável só existe quando alguma categoria tem seção de DRE
  // variável (CMV/serviços). Sem esse lastro — caso típico do workspace Pessoal, onde
  // categorias não carregam dre_secao — TODA despesa caía em "fixa" e o card exibia um
  // falso "100% Fixo / 0% Variável". Nesse caso, em vez de fabricar a estatística,
  // mostramos o histórico de despesas dos últimos 7 dias (dado real).
  const hasSplit = donut.total > 0 && donut.totalVariable > 0;
  const fixedPct = donut.total > 0 ? (donut.totalFixed / donut.total) * 100 : 50;
  const varPct   = 100 - fixedPct;
  const chart = hasSplit
    ? `<div class="kpi-donut-row">
        ${miniDonutSVG(fixedPct)}
        <div class="kpi-donut-leg">
          <div><i class="kpi-dot" style="background:var(--accent)"></i><span class="kpi-muted">Fixo</span><strong>${formatPercent(fixedPct)}</strong></div>
          <div><i class="kpi-dot" style="background:var(--yellow)"></i><span class="kpi-muted">Variável</span><strong>${formatPercent(varPct)}</strong></div>
          <div class="kpi-muted" style="font-size:10.5px;margin-top:2px;">Total: ${formatCurrencyShort(donut.total)}</div>
        </div>
      </div>`
    : sparklineSVG(sparklineDays('despesa', 7), 'var(--red)');
  return shell('danger',
    `<span class="kpi-label">Despesas mês</span>${deltaBadge(delta, true)}`,
    formatCurrency(val),
    chart,
    ''
  );
}

/** Card 4 — Lucro mês: barra de progresso de margem com zonas de cor */
export function cardLucroMes() {
  const rec   = receitasMes(), desp = despesasMes();
  const lucro = rec - desp;
  const marg  = rec > 0 ? (lucro / rec) * 100 : 0;
  const kind  = lucro >= 0 ? (marg >= 30 ? 'success' : 'warning') : 'danger';
  return shell(kind,
    `<span class="kpi-label">Lucro mês</span><span class="kpi-badge-neu">${formatPercent(marg, 1)} margem</span>`,
    formatCurrency(lucro),
    marginProgressHTML(marg),
    subRow([
      { dot: 'var(--green)',  label: 'Receita',  val: formatCurrencyShort(rec)  },
      { dot: 'var(--red)',    label: 'Despesa',  val: formatCurrencyShort(desp) }
    ])
  );
}

/** Card 5 — A receber: barra empilhada pendente/vencido/parcial */
export function cardAReceber() {
  const bd    = receberBreakdown();
  const total = totalReceber();
  const segs  = [
    { label: 'Pendente', value: bd.pendente, color: 'var(--accent)' },
    { label: 'Vencido',  value: bd.vencido,  color: 'var(--red)'    },
    { label: 'Parcial',  value: bd.parcial,  color: 'var(--yellow)' }
  ];
  const alertH = bd.vencido > 0
    ? `<span class="kpi-alert">${icon('alert-triangle', { size: 12 })} ${formatCurrencyShort(bd.vencido)} vencido</span>`
    : `<span class="kpi-badge-ok">Tudo em dia</span>`;
  return shell('info',
    `<span class="kpi-label">A receber</span>${alertH}`,
    formatCurrency(total),
    stackBarHTML(segs),
    subRow([
      { dot: 'var(--accent)', label: 'Pendente', val: formatCurrencyShort(bd.pendente) },
      { dot: 'var(--red)',    label: 'Vencido',  val: formatCurrencyShort(bd.vencido)  },
      { dot: 'var(--yellow)', label: 'Parcial',  val: formatCurrencyShort(bd.parcial)  }
    ])
  );
}

/** Card 6 — A pagar: barras de urgência vencido / 7 dias / restante */
export function cardAPagar() {
  const urg   = pagarUrgency();
  const total = totalPagar();
  const alertH = urg.vencido > 0
    ? `<span class="kpi-alert">${icon('alert-triangle', { size: 12 })} ${formatCurrencyShort(urg.vencido)} atrasado</span>`
    : `<span class="kpi-badge-ok">Em dia</span>`;
  return shell('warning',
    `<span class="kpi-label">A pagar</span>${alertH}`,
    formatCurrency(total),
    `<div class="kpi-urg-wrap">
      ${urgencyBarsSVG(urg.vencido, urg.semana, urg.futuro)}
    </div>`,
    subRow([
      { dot: 'var(--red)',    label: 'Venc.',  val: formatCurrencyShort(urg.vencido) },
      { dot: 'var(--yellow)', label: '7 dias', val: formatCurrencyShort(urg.semana)  },
      { dot: 'var(--accent)', label: 'Mês',   val: formatCurrencyShort(urg.futuro)  }
    ])
  );
}
