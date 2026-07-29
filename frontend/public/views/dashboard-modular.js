// ============================================================================
// views/dashboard-modular.js — Dashboard modular (widgets editáveis)
// ----------------------------------------------------------------------------
// O dashboard (empresarial e pessoal) é dirigido por um LAYOUT: uma lista
// ordenada de widgets, cada um com largura e altura em células. Em modo edição
// dá pra arrastar/mover, redimensionar, adicionar/remover cards e criar notas.
// Layouts e perfis nomeados ficam em localStorage (UI prefs). Catálogo de
// widgets reutiliza os renders já existentes (KPIs, gráficos, cascata, etc).
// ============================================================================

import {
  state, escapeHtml, formatCurrency, formatCurrencyBase, originalCurrencyHint, formatCurrencyShort, formatPercent, formatDateBR,
  MOEDAS, moedaAtiva,
  saldoTotal, receitasMes, despesasMes, totalDividas, totalReceber, totalPagar, saveUiPrefs,
  contasDoWorkspace, sortTransacoesDesc
} from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader, renderKpiCard, renderCurrencyWarning } from './shared.js?v=20260727-finance-v87';
import { renderBarChart, renderDonutChart, renderLineChart, buildPieSlices } from './charts.js?v=20260727-finance-v87';
import { seedDashboardData, selectCashflow6m, selectDonut } from './dashboard-store.js?v=20260727-finance-v87';
import {
  cardCaixaTotal, cardReceitasMes, cardDespesasMes, cardLucroMes, cardAReceber, cardAPagar
} from './kpi-cards.js?v=20260727-finance-v87';
import { defaultMes, mesLabel, ensureDre } from './dre-shared.js?v=20260727-finance-v87';
import { cascataCards, inadCard, monthPicker } from './dashboard-empresarial-view.js?v=20260727-finance-v87';

const num = (v) => Number(v || 0);

// ── Corpos de widgets novos ───────────────────────────────────────────────────
function cardShell(titulo, inner, headExtra = '') {
  return `<div class="card"><div class="card-header"><h3>${escapeHtml(titulo)}</h3>${headExtra}</div>${inner}</div>`;
}

function fluxoBody() {
  return cardShell('Fluxo de caixa — 6 meses',
    renderBarChart(selectCashflow6m(state)),
    `<div class="chart-legend-inline"><span><i class="sw-income"></i>Receita</span><span><i class="sw-expense"></i>Despesa</span></div>`);
}

function donutBody() {
  const donut = selectDonut(state);
  return `<div class="card">
    <div class="card-header"><h3>Despesas — Fixo vs Variável</h3>
      ${donut.total > 0 ? `<span class="badge badge-info">${formatPercent(donut.pctVariable)} variável</span>` : ''}
    </div>
    <div class="donut-wrap">
      ${renderDonutChart(donut.slices)}
      <ul class="donut-legend">
        ${donut.slices.length === 0
          ? `<li class="muted">Nenhuma despesa lançada.</li>`
          : donut.slices.slice(0, 6).map((s) => `
            <li><span class="legend-dot" style="background:${s.color}"></span>
              <span class="legend-grow">${escapeHtml(s.label)} <small class="muted">${s.classe === 'variavel' ? 'var.' : 'fixa'}</small></span>
              <span class="legend-val">${formatCurrency(s.value)}</span></li>`).join('')}
      </ul>
    </div></div>`;
}

function tendenciaBody() {
  const pts = selectCashflow6m(state).map((m) => ({ label: m.mes, value: num(m.income) - num(m.expense) }));
  return cardShell('Tendência de resultado (6 meses)', renderLineChart(pts),
    `<span class="muted" style="font-size:11.5px;">receita − despesa por mês</span>`);
}

function contasBody() {
  // Filtra pelo escopo do workspace ativo (pessoal/empresarial), igual à tela Contas.
  // Sem isso, contas empresariais vazavam no dashboard Pessoal enquanto o Saldo Total
  // (que usa contasDoWorkspace) só somava as pessoais — números contraditórios na mesma tela.
  const contas = contasDoWorkspace();
  const inner = contas.length === 0
    ? `<div class="empty-state-sm">Nenhuma conta cadastrada.</div>`
    : `<ul class="list-clean">${contas.map((c) => `
        <li><span class="dot" style="background:${escapeHtml(c.cor || '#22d3ee')}"></span>
          <span class="grow">${escapeHtml(c.nome)}</span>
          <strong>${formatCurrency(c.saldo, c.moeda)}</strong></li>`).join('')}</ul>`;
  return cardShell('Contas bancárias', inner,
    `<button class="btn btn-sm btn-ghost" data-action="open-modal-conta">+ Conta</button>`);
}

function transacoesBody() {
  const tx = sortTransacoesDesc(state.data.transacoes).slice(0, 8);
  const inner = tx.length === 0
    ? `<div class="empty-state-sm">Nenhum lançamento ainda.</div>`
    : `<ul class="list-clean">${tx.map((t) => `
        <li><span class="dot ${t.tipo === 'receita' ? 'dot-success' : 'dot-danger'}"></span>
          <div class="grow"><div>${escapeHtml(t.descricao || t.categoria_nome || '(sem descrição)')}</div>
            <small class="muted">${formatDateBR(t.data)} · ${escapeHtml(t.categoria_nome || 'Sem categoria')}</small></div>
          <span style="text-align:right;">
            <strong class="${t.tipo === 'receita' ? 'text-success' : 'text-danger'}">${t.tipo === 'receita' ? '+' : '-'} ${formatCurrencyBase(t)}</strong>
            ${originalCurrencyHint(t) ? `<small class="muted" style="display:block;">orig. ${originalCurrencyHint(t)}</small>` : ''}
          </span>
        </li>`).join('')}</ul>`;
  return cardShell('Últimas transações', inner,
    `<button class="btn btn-sm btn-ghost" data-action="change-view" data-param="transacoes">Ver todas</button>`);
}

function metasBody() {
  const metas = state.data.metas || [];
  if (!metas.length) return cardShell('Metas', `<div class="empty-state-sm">Nenhuma meta cadastrada.</div>`,
    `<button class="btn btn-sm btn-ghost" data-action="change-view" data-param="metas">Ver metas</button>`);
  const inner = `<div class="rank-list">${metas.slice(0, 5).map((m) => {
    const alvo = num(m.valor_alvo ?? m.alvo);
    const atual = num(m.valor_atual ?? m.acumulado ?? m.saldo);
    const pct = alvo > 0 ? Math.max(0, Math.min(100, (atual / alvo) * 100)) : 0;
    return `<div class="rank-row">
      <div class="rank-head"><span class="rank-name">${escapeHtml(m.titulo || m.nome || 'Meta')}</span>
        <span class="rank-val">${formatCurrency(atual)} <small class="muted">/ ${formatCurrencyShort(alvo)}</small></span></div>
      <div class="rank-track"><div class="rank-fill" style="width:${pct.toFixed(1)}%"></div></div>
    </div>`;
  }).join('')}</div>`;
  return cardShell('Metas', inner, `<button class="btn btn-sm btn-ghost" data-action="change-view" data-param="metas">Ver metas</button>`);
}

function dividasBody() {
  const dividas = state.data.dividas || [];
  const total = totalDividas();
  const inner = dividas.length === 0
    ? `<div class="empty-state-sm">Sem dívidas ativas. 🎉</div>`
    : `<ul class="list-clean">${dividas.slice(0, 6).map((d) => `
        <li><span class="dot dot-danger"></span>
          <span class="grow">${escapeHtml(d.credor || d.descricao || 'Dívida')} <small class="muted">${escapeHtml(d.tipo || '')}</small></span>
          <strong class="text-danger">${formatCurrency(d.saldo_devedor)}</strong></li>`).join('')}</ul>
        <div class="card-footer" style="margin-top:8px;">Total: <strong class="text-danger">${formatCurrency(total)}</strong></div>`;
  return cardShell('Dívidas ativas', inner);
}

function topCategoriasBody() {
  const tx = (state.data.transacoes || []).filter((t) => t.tipo === 'despesa');
  const porCat = {};
  tx.forEach((t) => { const k = t.categoria_nome || 'Sem categoria'; porCat[k] = (porCat[k] || 0) + num(t.valor_base ?? t.valor); });
  const ranking = Object.entries(porCat).map(([nome, total]) => ({ nome, total }))
    .filter((r) => r.total > 0).sort((a, b) => b.total - a.total).slice(0, 6);
  if (!ranking.length) return cardShell('Top categorias de despesa', `<div class="empty-state-sm">Sem despesas lançadas.</div>`);
  const maxV = Math.max(1, ...ranking.map((r) => r.total));
  const inner = `<div class="rank-list">${ranking.map((r) => `
    <div class="rank-row"><div class="rank-head"><span class="rank-name">${escapeHtml(r.nome)}</span>
      <span class="rank-val">${formatCurrency(r.total)}</span></div>
      <div class="rank-track"><div class="rank-fill" style="width:${((r.total / maxV) * 100).toFixed(1)}%"></div></div></div>`).join('')}</div>`;
  return cardShell('Top categorias de despesa', inner);
}

// Pizza genérica: donut + legenda com % — mais fácil de bater o olho que ranking.
function pieCard(titulo, slices, { caption, emptyMessage, legendSuffix } = {}) {
  const total = slices.reduce((s, x) => s + num(x.value), 0);
  if (!slices.length || total <= 0) {
    return cardShell(titulo, `<div class="empty-state-sm">${escapeHtml(emptyMessage || 'Sem dados no período.')}</div>`);
  }
  const inner = `<div class="donut-wrap">
    ${renderDonutChart(slices, { caption, emptyMessage, ariaLabel: titulo })}
    <ul class="donut-legend">
      ${slices.slice(0, 8).map((s) => `
        <li><span class="legend-dot" style="background:${s.color}"></span>
          <span class="legend-grow">${escapeHtml(s.label)}${legendSuffix ? ` <small class="muted">${escapeHtml(legendSuffix(s))}</small>` : ''}</span>
          <span class="legend-val">${formatPercent((num(s.value) / total) * 100, 0)} · ${formatCurrencyShort(s.value)}</span></li>`).join('')}
    </ul>
  </div>`;
  return cardShell(titulo, inner);
}

// Mês corrente no fuso local (YYYY-MM) — mesmo recorte dos KPIs do mês.
function mesAtualPrefix() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// O backend já devolve /transacoes recortado pelo escopo ativo; o filtro por
// conta_escopo aqui é defensivo (mesmo padrão da tela Despesas Variáveis) —
// evita vazar lançamento do outro ambiente se a lista vier mista.
function txDoMes(tipo) {
  const mes = mesAtualPrefix();
  return (state.data.transacoes || []).filter((t) =>
    t.tipo === tipo
    && String(t.data || '').startsWith(mes)
    && (!t.conta_escopo || t.conta_escopo === state.workspace));
}

function pizzaDespesasCatBody() {
  const slices = buildPieSlices(txDoMes('despesa').map((t) => [t.categoria_nome || 'Sem categoria', t.valor_base ?? t.valor]));
  return pieCard('Despesas do mês por categoria', slices,
    { caption: 'DESPESAS', emptyMessage: 'Sem despesas neste mês.' });
}

function pizzaReceitasCatBody() {
  const slices = buildPieSlices(txDoMes('receita').map((t) => [t.categoria_nome || 'Sem categoria', t.valor_base ?? t.valor]));
  return pieCard('Receitas do mês por categoria', slices,
    { caption: 'RECEITAS', emptyMessage: 'Sem receitas neste mês.' });
}

function pizzaContasBody() {
  const contas = contasDoWorkspace().filter((c) => num(c.saldo) > 0);
  const mixedCurrencies = new Set(contas.map((c) => String(c.moeda || 'BRL').toUpperCase())).size > 1;
  if (mixedCurrencies) {
    return cardShell('Onde o dinheiro está', '<div class="empty-state-sm">Distribuição indisponível para contas em moedas diferentes. O total consolidado continua no card Caixa total.</div>');
  }
  const slices = buildPieSlices(contas.map((c) => [c.nome, c.saldo]));
  return pieCard('Onde o dinheiro está', slices,
    { caption: 'SALDO', emptyMessage: 'Nenhuma conta com saldo positivo.' });
}

// Card de nota (informação livre). Editável em modo edição.
function notaBody(item) {
  if (state.dashEdit) {
    return `<div class="card dash-nota">
      <input class="input dash-nota-title" value="${escapeHtml(item.title || '')}" placeholder="Título do card" data-action="dash-nota-title" data-param="${escapeHtml(item.uid)}" />
      <textarea class="input dash-nota-body" rows="4" placeholder="Escreva uma anotação, lembrete ou meta…" data-action="dash-nota-body" data-param="${escapeHtml(item.uid)}">${escapeHtml(item.body || '')}</textarea>
    </div>`;
  }
  const body = escapeHtml(item.body || '').replace(/\n/g, '<br>');
  return `<div class="card dash-nota">
    <div class="card-header"><h3>${escapeHtml(item.title || 'Informação')}</h3></div>
    <div class="dash-nota-text">${body || '<span class="muted">Card de informação vazio.</span>'}</div>
  </div>`;
}

const MOEDA_CODES = new Set(MOEDAS.map((item) => item.code));
const CAMBIO_PERIODOS = [7, 30, 90];

export function normalizeCambioConfig(item = {}, base = moedaAtiva()) {
  const fallbackFrom = MOEDA_CODES.has(String(base || '').toUpperCase()) ? String(base).toUpperCase() : 'BRL';
  const de = MOEDA_CODES.has(String(item.cambioDe || '').toUpperCase())
    ? String(item.cambioDe).toUpperCase()
    : fallbackFrom;
  const para = MOEDA_CODES.has(String(item.cambioPara || '').toUpperCase())
    ? String(item.cambioPara).toUpperCase()
    : (de === 'GBP' ? 'BRL' : 'GBP');
  const valor = item.cambioValor == null ? '100' : String(item.cambioValor);
  const dias = CAMBIO_PERIODOS.includes(Number(item.cambioDias)) ? Number(item.cambioDias) : 30;
  return { valor, de, para, dias };
}

function cambioOptions(selected) {
  return MOEDAS.map((item) => `<option value="${item.code}" ${item.code === selected ? 'selected' : ''}>${escapeHtml(item.nome)} · ${item.code}</option>`).join('');
}

function cambioPeriodOptions(selected) {
  return CAMBIO_PERIODOS.map((days) => `<option value="${days}" ${days === selected ? 'selected' : ''}>${days} dias</option>`).join('');
}

function cambioRate(value) {
  return Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function cambioPercent(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? '+' : ''}${number.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function cambioDate(value) {
  if (!value) return '';
  const [year, month, day] = String(value).split('-');
  return year && month && day ? `${day}/${month}/${year}` : '';
}

function renderCambioChart(points = [], de = '', para = '') {
  const safe = points.filter((point) => Number.isFinite(Number(point?.taxa)) && Number(point.taxa) > 0);
  if (safe.length < 2) return '<div class="dash-cambio-chart-empty">Histórico temporariamente indisponível.</div>';
  const W = 640, H = 190, padX = 42, padTop = 18, padBottom = 30;
  const values = safe.map((point) => Number(point.taxa));
  const min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max - min) * 0.12, max * 0.002, 0.000001);
  const low = min - padding, high = max + padding, range = high - low;
  const x = (index) => padX + index * (W - padX * 2) / Math.max(1, safe.length - 1);
  const y = (value) => padTop + (high - value) / range * (H - padTop - padBottom);
  const path = safe.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(Number(point.taxa)).toFixed(1)}`).join(' ');
  const area = `${path} L${x(safe.length - 1).toFixed(1)} ${(H - padBottom).toFixed(1)} L${x(0).toFixed(1)} ${(H - padBottom).toFixed(1)} Z`;
  const labelIndexes = [...new Set([0, Math.floor((safe.length - 1) / 2), safe.length - 1])];
  const labels = labelIndexes.map((index) => `<text x="${x(index).toFixed(1)}" y="${H - 8}" class="chart-axis" text-anchor="${index === 0 ? 'start' : index === safe.length - 1 ? 'end' : 'middle'}">${escapeHtml(cambioDate(safe[index].data).slice(0, 5))}</text>`).join('');
  const endpoints = [0, safe.length - 1].map((index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(values[index]).toFixed(1)}" r="3.5" class="dash-cambio-chart-dot"><title>${escapeHtml(cambioDate(safe[index].data))}: 1 ${escapeHtml(de)} = ${escapeHtml(cambioRate(values[index]))} ${escapeHtml(para)}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="dash-cambio-chart-svg" role="img" aria-label="Oscilação da cotação de ${escapeHtml(de)} para ${escapeHtml(para)}">
    <line x1="${padX}" y1="${padTop}" x2="${W - padX}" y2="${padTop}" class="chart-grid" />
    <line x1="${padX}" y1="${H - padBottom}" x2="${W - padX}" y2="${H - padBottom}" class="chart-grid" />
    <text x="${padX - 6}" y="${padTop + 4}" class="chart-axis" text-anchor="end">${escapeHtml(cambioRate(max))}</text>
    <text x="${padX - 6}" y="${H - padBottom + 4}" class="chart-axis" text-anchor="end">${escapeHtml(cambioRate(min))}</text>
    <path d="${area}" class="dash-cambio-chart-area" />
    <path d="${path}" class="dash-cambio-chart-line" />
    ${endpoints}${labels}
  </svg>`;
}

function cambioSummaryText(data) {
  const summary = data?.resumo;
  if (!summary) return 'O valor final usa a cotação mais recente disponível. O histórico não está disponível para comparar oscilações.';
  const direction = summary.tendencia === 'alta' ? 'subiu' : summary.tendencia === 'baixa' ? 'caiu' : 'ficou estável';
  const impact = Number(summary.impacto_valor) || 0;
  const impactText = impact === 0
    ? 'sem impacto relevante no valor convertido'
    : `${impact > 0 ? 'acréscimo' : 'redução'} de ${formatCurrency(Math.abs(impact), data.para)} sobre o valor informado`;
  return `A cotação ${direction} ${Math.abs(Number(summary.variacao_pct) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% no período, com ${impactText}.`;
}

function cambioPanelBody(config, result) {
  const data = result?.data;
  if (result?.status === 'loading' && !data) {
    return `<div class="dash-cambio-result is-loading" role="status">Montando o resumo automático…</div>`;
  }
  if (result?.status === 'error' && !data) {
    return `<div class="dash-cambio-result is-error" role="alert">${escapeHtml(result.error || 'Cotação indisponível.')}</div>`;
  }
  if (!data) {
    return `<div class="dash-cambio-result is-empty">A cotação será carregada automaticamente.</div>`;
  }

  const summary = data.resumo;
  const updated = new Date(data.consultado_em);
  const updatedLabel = Number.isNaN(updated.getTime()) ? '' : updated.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const variationClass = Number(summary?.variacao_pct) > 0 ? 'is-up' : Number(summary?.variacao_pct) < 0 ? 'is-down' : 'is-flat';
  return `<div class="dash-cambio-panel ${result?.status === 'loading' ? 'is-refreshing' : ''}">
    <section class="dash-cambio-final" aria-label="Valor final convertido">
      <span>Valor final</span>
      <strong>${formatCurrency(data.valor_convertido, data.para)}</strong>
      <small>${formatCurrency(data.valor, data.de)} convertidos pela taxa de ${escapeHtml(cambioRate(data.taxa))}</small>
    </section>
    <div class="dash-cambio-breakdown" aria-label="Resumo da conversão">
      <div><span>Valor de origem</span><strong>${formatCurrency(data.valor, data.de)}</strong></div>
      <div><span>Taxa usada</span><strong>1 ${escapeHtml(data.de)} = ${escapeHtml(cambioRate(data.taxa))} ${escapeHtml(data.para)}</strong></div>
      <div><span>Data da cotação</span><strong>${escapeHtml(cambioDate(data.cotacao_data) || 'Última disponível')}</strong></div>
    </div>
    <div class="dash-cambio-section-head">
      <div><strong>Oscilação da cotação</strong><span>${config.dias} dias</span></div>
      ${result?.status === 'loading' ? '<small role="status">Atualizando…</small>' : ''}
    </div>
    ${summary ? `<div class="dash-cambio-metrics">
      <div class="${variationClass}"><span>Variação</span><strong>${escapeHtml(cambioPercent(summary.variacao_pct))}</strong></div>
      <div><span>Mínima</span><strong>${escapeHtml(cambioRate(summary.menor_taxa))}</strong></div>
      <div><span>Máxima</span><strong>${escapeHtml(cambioRate(summary.maior_taxa))}</strong></div>
      <div><span>Média</span><strong>${escapeHtml(cambioRate(summary.taxa_media))}</strong></div>
    </div>` : ''}
    <div class="dash-cambio-chart">${renderCambioChart(data.historico, data.de, data.para)}</div>
    <p class="dash-cambio-summary">${escapeHtml(cambioSummaryText(data))}</p>
    <div class="dash-cambio-meta">
      <span>Referência diária do BCE via Frankfurter</span>
      <span>${updatedLabel ? `Painel atualizado em ${escapeHtml(updatedLabel)}` : 'Atualização automática a cada 15 minutos'}</span>
      <span class="dash-cambio-disclaimer">O valor efetivo pode incluir spread, tarifa e impostos da instituição financeira.</span>
    </div>
    ${result?.status === 'error' ? `<p class="dash-cambio-inline-error" role="alert">${escapeHtml(result.error || 'Falha ao atualizar. Mantendo a última cotação.')}</p>` : ''}
  </div>`;
}

function cambioBody(item) {
  const config = normalizeCambioConfig(item);
  const result = state.dashCambioResults?.[item.uid];
  const loading = result?.status === 'loading';
  const uid = escapeHtml(item.uid);
  return `<div class="card dash-cambio-card">
    <div class="card-header">
      <div><h3>Painel de câmbio</h3><small class="muted">Conversão e oscilação automática</small></div>
      <div class="dash-cambio-header-meta"><span class="dash-cambio-auto">Automático</span><span class="dash-cambio-pair">${escapeHtml(config.de)} → ${escapeHtml(config.para)}</span></div>
    </div>
    <form class="dash-cambio-form" data-dash-cambio="${uid}" novalidate>
      <label class="dash-cambio-field dash-cambio-value">
        <span>Valor</span>
        <input class="input" type="number" inputmode="decimal" min="0.01" max="1000000000000" step="0.01"
          value="${escapeHtml(config.valor)}" data-action="dash-cambio-valor" data-param="${uid}" aria-label="Valor para converter" required />
      </label>
      <label class="dash-cambio-field">
        <span>De</span>
        <select class="input" data-action="dash-cambio-de" data-param="${uid}" aria-label="Moeda de origem">${cambioOptions(config.de)}</select>
      </label>
      <button class="dash-cambio-swap" type="button" data-action="dash-cambio-swap" data-param="${uid}" aria-label="Inverter moedas" title="Inverter moedas">⇄</button>
      <label class="dash-cambio-field">
        <span>Para</span>
        <select class="input" data-action="dash-cambio-para" data-param="${uid}" aria-label="Moeda de destino">${cambioOptions(config.para)}</select>
      </label>
      <label class="dash-cambio-field dash-cambio-period">
        <span>Período do gráfico</span>
        <select class="input" data-action="dash-cambio-dias" data-param="${uid}" aria-label="Período da oscilação">${cambioPeriodOptions(config.dias)}</select>
      </label>
      <button class="btn btn-secondary dash-cambio-submit" type="submit" ${loading ? 'disabled' : ''}>${loading ? 'Atualizando…' : 'Atualizar cotação'}</button>
    </form>
    <div class="dash-cambio-live" aria-live="polite">${cambioPanelBody(config, result)}</div>
  </div>`;
}

// ── Catálogo de widgets ───────────────────────────────────────────────────────
// scope: 'empresarial' | 'pessoal' | 'both'. Dimensões são largura × altura.
export const DASH_GRID_OPTIONS = [12, 6, 4];
export const DASH_GRID_ROW_PX = 88;
const DASH_GRID_MAX_H = 32;
const DASH_BOARD_VERSION = 4;

// Apenas tamanhos PADRÃO (ao adicionar o widget). O mínimo é universal 1×1 (ver minSize).
const SIZE = {
  compact: { defaultW: { 12: 3, 6: 2, 4: 1 }, defaultH: 2 },
  standard: { defaultW: { 12: 6, 6: 3, 4: 2 }, defaultH: 4 },
  result: { defaultW: { 12: 6, 6: 3, 4: 2 }, defaultH: 8 },
  exchange: { defaultW: { 12: 6, 6: 3, 4: 2 }, defaultH: 9 },
  wide: { defaultW: { 12: 12, 6: 6, 4: 4 }, defaultH: 4 }
};

const WIDGETS = {
  'resultado-mes':   { title: 'Resultado do mês (DRE)', desc: 'Cascata Receita → Lucro', scope: 'empresarial', ...SIZE.result, render: (ctx) => cascataCards(ctx.mes) },
  'inadimplencia':   { title: 'Inadimplência',          desc: 'Vencidos + filtros',       scope: 'empresarial', ...SIZE.wide, render: () => inadCard() },
  'a-receber':       { title: 'A receber',              desc: 'Pendente/vencido/parcial', scope: 'empresarial', ...SIZE.compact, render: () => cardAReceber() },
  'a-pagar':         { title: 'A pagar',                desc: 'Urgência de pagamento',    scope: 'empresarial', ...SIZE.compact, render: () => cardAPagar() },

  'kpi-caixa':       { title: 'Caixa total',            desc: 'Soma das suas contas',      scope: 'both', ...SIZE.compact, render: () => cardCaixaTotal() },
  'kpi-receitas':    { title: 'Receitas do mês',        desc: 'Quanto entrou no mês',      scope: 'both', ...SIZE.compact, render: () => cardReceitasMes() },
  'kpi-despesas':    { title: 'Despesas do mês',        desc: 'Quanto saiu no mês',        scope: 'both', ...SIZE.compact, render: () => cardDespesasMes() },
  'kpi-lucro':       { title: 'Lucro/Resultado do mês', desc: 'Margem com zonas',          scope: 'both', ...SIZE.compact, render: () => cardLucroMes() },
  'kpi-saldo':       { title: 'Saldo total',            desc: 'Quanto você tem no total',  scope: 'pessoal', ...SIZE.compact, render: () => renderKpiCard({ label: 'Saldo total', valor: formatCurrency(saldoTotal()), hint: `${contasDoWorkspace().length} conta(s)`, kind: 'primary' }) },
  'kpi-economia':    { title: 'Economia do mês',        desc: 'Quanto sobrou no mês',      scope: 'pessoal', ...SIZE.compact, render: () => { const e = receitasMes() - despesasMes(); const p = receitasMes() > 0 ? (e / receitasMes()) * 100 : 0; return renderKpiCard({ label: 'Economia', valor: formatCurrency(e), hint: `${p.toFixed(1)}% das receitas`, kind: e >= 0 ? 'success' : 'danger' }); } },
  'kpi-dividas':     { title: 'Dívidas ativas',         desc: 'Total que você ainda deve', scope: 'both', ...SIZE.compact, render: () => renderKpiCard({ label: 'Dívidas ativas', valor: formatCurrency(totalDividas()), hint: `${(state.data.dividas || []).length} dívida(s)`, kind: 'warning' }) },
  'kpi-receber':     { title: 'Total a receber',        desc: 'KPI simples',               scope: 'empresarial', ...SIZE.compact, render: () => renderKpiCard({ label: 'A receber', valor: formatCurrency(totalReceber()), kind: 'info' }) },
  'kpi-pagar':       { title: 'Total a pagar',          desc: 'KPI simples',               scope: 'empresarial', ...SIZE.compact, render: () => renderKpiCard({ label: 'A pagar', valor: formatCurrency(totalPagar()), kind: 'warning' }) },

  'fluxo-6m':        { title: 'Fluxo de caixa 6 meses', desc: 'Entradas e saídas por mês', scope: 'both', ...SIZE.standard, render: () => fluxoBody() },
  'donut-despesas':  { title: 'Despesas fixo×variável', desc: 'Gastos fixos vs variáveis', scope: 'both', ...SIZE.standard, render: () => donutBody() },
  'pizza-despesas':  { title: 'Despesas por categoria', desc: 'Para onde foi o dinheiro',  scope: 'both', ...SIZE.standard, render: () => pizzaDespesasCatBody() },
  'pizza-receitas':  { title: 'Receitas por categoria', desc: 'De onde veio o dinheiro',   scope: 'both', ...SIZE.standard, render: () => pizzaReceitasCatBody() },
  'pizza-contas':    { title: 'Onde o dinheiro está',   desc: 'Quanto tem em cada conta',  scope: 'both', ...SIZE.standard, render: () => pizzaContasBody() },
  'tendencia-saldo': { title: 'Tendência de resultado', desc: 'A sobra ao longo do tempo', scope: 'both', ...SIZE.standard, render: () => tendenciaBody() },
  'top-categorias':  { title: 'Top categorias',         desc: 'Onde você mais gasta',      scope: 'both', ...SIZE.standard, render: () => topCategoriasBody() },
  'contas-saldos':   { title: 'Contas bancárias',       desc: 'Saldo de cada conta',       scope: 'both', ...SIZE.standard, render: () => contasBody() },
  'transacoes':      { title: 'Últimas transações',     desc: 'Seus últimos lançamentos',  scope: 'both', ...SIZE.standard, render: () => transacoesBody() },
  'metas':           { title: 'Metas',                  desc: 'Progresso dos objetivos',   scope: 'both', ...SIZE.standard, render: () => metasBody() },
  'dividas':         { title: 'Dívidas',                desc: 'Lista de dívidas',          scope: 'both', ...SIZE.standard, render: () => dividasBody() },
  'conversor-moedas':{ title: 'Painel de câmbio',       desc: 'Conversão, resumo e oscilação', scope: 'both', ...SIZE.exchange, render: (_ctx, item) => cambioBody(item) },
  'nota':            { title: 'Card de informação',     desc: 'Texto/anotação livre',      scope: 'both', ...SIZE.compact, custom: true, render: (ctx, item) => notaBody(item) }
};

function widgetsForScope(ws) {
  return Object.entries(WIDGETS).filter(([, d]) => d.scope === ws || d.scope === 'both');
}

// ── Layouts padrão ────────────────────────────────────────────────────────────
const DEFAULT_TYPES = {
  empresarial: ['resultado-mes', 'donut-despesas', 'a-receber', 'a-pagar', 'fluxo-6m', 'pizza-despesas', 'inadimplencia', 'tendencia-saldo'],
  // Ordem que conta uma história pra qualquer pessoa: quanto tenho → quanto
  // entrou → quanto saiu → quanto sobrou → pra onde foi → ao longo do tempo →
  // minhas contas → meus objetivos → o que aconteceu.
  pessoal: ['kpi-saldo', 'kpi-receitas', 'kpi-despesas', 'kpi-economia', 'conversor-moedas', 'pizza-despesas', 'fluxo-6m', 'contas-saldos', 'metas', 'transacoes']
};

// Presets de layout (1 clique no modo edição). `types` = seleção/ordem dos cards;
// o arranjo é empacotado por buildDefaultLayout no tamanho padrão de cada widget.
// Nomes/descrições em linguagem do dia a dia (sem "KPI"/"indicador"/"resultado")
// — o painel pessoal é pra qualquer pessoa, não só quem entende de finanças.
const LAYOUT_PRESETS = {
  pessoal: [
    { id: 'geral',    nome: 'Visão geral',     desc: 'Tudo o que importa num lugar só', icon: '▦', types: DEFAULT_TYPES.pessoal },
    { id: 'resumo',   nome: 'Resumo rápido',   desc: 'Só os números principais',        icon: '▭', types: ['kpi-saldo', 'kpi-receitas', 'kpi-despesas', 'kpi-economia', 'pizza-despesas', 'fluxo-6m'] },
    { id: 'gastos',   nome: 'Meus gastos',     desc: 'Para onde o dinheiro está indo',  icon: '◴', types: ['kpi-despesas', 'pizza-despesas', 'top-categorias', 'transacoes'] },
    { id: 'situacao', nome: 'Metas e situação', desc: 'Objetivos, saldos e dívidas',    icon: '◎', types: ['kpi-saldo', 'kpi-economia', 'metas', 'contas-saldos', 'pizza-contas', 'dividas'] }
  ],
  empresarial: [
    { id: 'geral',    nome: 'Visão geral',   desc: 'DRE, cobrança e fluxo',      icon: '▦', types: DEFAULT_TYPES.empresarial },
    { id: 'dre',      nome: 'DRE em foco',   desc: 'Resultado + indicadores',    icon: '▤', types: ['resultado-mes', 'kpi-receitas', 'kpi-despesas', 'kpi-lucro', 'tendencia-saldo'] },
    { id: 'cobranca', nome: 'Cobrança',      desc: 'Inadimplência e recebíveis', icon: '◉', types: ['inadimplencia', 'a-receber', 'a-pagar', 'kpi-receber', 'kpi-pagar'] },
    { id: 'caixa',    nome: 'Caixa & fluxo', desc: 'Liquidez e composição',      icon: '◑', types: ['fluxo-6m', 'pizza-despesas', 'pizza-contas', 'donut-despesas', 'contas-saldos', 'kpi-caixa'] }
  ]
};

let uidSeq = 0;
function newUid(type) { return `${type}-${Date.now().toString(36)}${(uidSeq++).toString(36)}`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}
function sizeAt(value, columns) { return typeof value === 'object' ? value[columns] : value; }
function defaultSize(type, columns) {
  const def = WIDGETS[type];
  return { w: sizeAt(def.defaultW, columns), h: def.defaultH };
}
// Mínimo universal de 1×1 — qualquer widget pode ser reduzido ao máximo na grade.
function minSize() {
  return { w: 1, h: 1 };
}

export function normalizeGridColumns(value, fallback = 12) {
  const parsed = Number.parseInt(value, 10);
  return DASH_GRID_OPTIONS.includes(parsed) ? parsed : fallback;
}

export function normalizeDashboardGeometry(rect, type, columns) {
  const cols = normalizeGridColumns(columns);
  const fallback = defaultSize(type, cols);
  const minimum = minSize(type, cols);
  const w = clampInt(rect?.w, fallback.w, minimum.w, cols);
  const h = clampInt(rect?.h, fallback.h, minimum.h, DASH_GRID_MAX_H);
  const x = clampInt(rect?.x, 0, 0, Math.max(0, cols - w));
  const y = Math.max(0, Number.parseInt(rect?.y, 10) || 0);
  return { uid: rect.uid, x, y, w, h };
}

export function dashboardRectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function itemByUid(items) { return new Map((items || []).map((item) => [item.uid, item])); }
function geometryFree(rect, placed) { return !placed.some((other) => dashboardRectsOverlap(rect, other)); }
function findFirstFree(rect, placed, columns, startY = 0) {
  for (let y = Math.max(0, startY); ; y += 1) {
    for (let x = 0; x <= columns - rect.w; x += 1) {
      const candidate = { ...rect, x, y };
      if (geometryFree(candidate, placed)) return candidate;
    }
  }
}

export function resolveDashboardCollisions(layout, priorityUid, columns = 12) {
  const cols = normalizeGridColumns(columns);
  const source = (layout || []).map((rect) => ({ ...rect }));
  const ordered = priorityUid
    ? [...source.filter((rect) => rect.uid === priorityUid), ...source.filter((rect) => rect.uid !== priorityUid)]
    : source;
  const placed = [];
  ordered.forEach((rect) => {
    let next = { ...rect };
    while (!geometryFree(next, placed)) {
      const blockers = placed.filter((other) => dashboardRectsOverlap(next, other));
      next.y = Math.max(next.y + 1, ...blockers.map((other) => other.y + other.h));
    }
    placed.push(next);
  });
  const byUid = new Map(placed.map((rect) => [rect.uid, rect]));
  return source.map((rect) => byUid.get(rect.uid));
}

export function organizeDashboardLayout(layout, columns = 12, uidOrder = []) {
  const cols = normalizeGridColumns(columns);
  const order = new Map(uidOrder.map((uid, index) => [uid, index]));
  const source = (layout || []).map((rect, index) => ({ rect, index }));
  source.sort((a, b) => (order.get(a.rect.uid) ?? a.index) - (order.get(b.rect.uid) ?? b.index));
  const placed = [];
  source.forEach(({ rect }) => placed.push(findFirstFree({ ...rect }, placed, cols, 0)));
  return placed;
}

export function deriveDashboardLayout(sourceLayout, sourceColumns, targetColumns, items = []) {
  const from = normalizeGridColumns(sourceColumns);
  const to = normalizeGridColumns(targetColumns);
  const types = itemByUid(items);
  const scaled = (sourceLayout || []).map((rect) => {
    const item = types.get(rect.uid);
    if (!item) return null;
    return normalizeDashboardGeometry({ ...rect, x: Math.round(rect.x * to / from), w: Math.round(rect.w * to / from) }, item.type, to);
  }).filter(Boolean);
  return resolveDashboardCollisions(scaled, null, to);
}

function buildDefaultLayout(items, columns) {
  return organizeDashboardLayout(items.map((item) => ({ uid: item.uid, x: 0, y: 0, ...defaultSize(item.type, columns) })), columns, items.map((item) => item.uid));
}

function createDefaultBoard(ws) {
  const items = (DEFAULT_TYPES[ws] || []).map((type) => ({ uid: newUid(type), type }));
  return { version: DASH_BOARD_VERSION, preferredColumns: 12, items, layouts: { 12: buildDefaultLayout(items, 12), 6: null, 4: null } };
}

function ensurePersonalConverter(items, ws) {
  const next = [...items];
  if (ws === 'pessoal' && !next.some((item) => item.type === 'conversor-moedas')) {
    next.push({ uid: newUid('conversor-moedas'), type: 'conversor-moedas' });
  }
  return next;
}

function migrateLegacyLayout(layout, ws) {
  const items = ensurePersonalConverter((layout || []).filter((item) => WIDGETS[item?.type]).map((item) => {
    const next = { uid: item.uid || newUid(item.type), type: item.type };
    if (item.title != null) next.title = item.title;
    if (item.body != null) next.body = item.body;
    return next;
  }), ws);
  if (!items.length) return createDefaultBoard(ws);
  const types = itemByUid(items);
  const legacy = (layout || []).map((item) => {
    const stored = types.get(item?.uid);
    if (!stored) return null;
    const minimum = minSize(stored.type, 4);
    const fallback = defaultSize(stored.type, 4);
    return { uid: stored.uid, x: 0, y: 0, w: clampInt(item.w ?? item.span, fallback.w, minimum.w, 4), h: clampInt(item.h, fallback.h / 2, minimum.h / 2, DASH_GRID_MAX_H / 2) * 2 };
  }).filter(Boolean);
  const organized = organizeDashboardLayout(legacy, 4, items.map((item) => item.uid));
  items.forEach((item) => {
    if (organized.some((rect) => rect.uid === item.uid)) return;
    organized.push(findFirstFree({ uid: item.uid, x: 0, y: 0, ...defaultSize(item.type, 4) }, organized, 4));
  });
  return { version: DASH_BOARD_VERSION, preferredColumns: 4, items, layouts: { 12: null, 6: null, 4: organized } };
}

export function migrateDashboardBoard(value, ws = 'empresarial') {
  if (Array.isArray(value)) return migrateLegacyLayout(value, ws);
  if (!value || !Array.isArray(value.items) || !value.layouts) return createDefaultBoard(ws);
  const items = ensurePersonalConverter(
    value.items.filter((item) => WIDGETS[item?.type]).map((item) => ({ ...item, uid: item.uid || newUid(item.type) })),
    ws
  );
  if (!items.length) return createDefaultBoard(ws);
  const types = itemByUid(items);
  const layouts = {};
  DASH_GRID_OPTIONS.forEach((columns) => {
    if (!Array.isArray(value.layouts[columns])) { layouts[columns] = null; return; }
    const seen = new Set();
    layouts[columns] = value.layouts[columns].map((rect) => {
      const item = types.get(rect?.uid);
      if (!item || seen.has(rect.uid)) return null;
      seen.add(rect.uid);
      const normalized = normalizeDashboardGeometry(rect, item.type, columns);
      if (Number(value.version) < DASH_BOARD_VERSION && item.type === 'conversor-moedas' && normalized.h <= 4) {
        normalized.h = SIZE.exchange.defaultH;
      }
      return normalized;
    }).filter(Boolean);
    items.forEach((item) => {
      if (seen.has(item.uid)) return;
      layouts[columns].push(findFirstFree({ uid: item.uid, x: 0, y: 0, ...defaultSize(item.type, columns) }, layouts[columns], columns));
    });
    layouts[columns] = resolveDashboardCollisions(layouts[columns], null, columns);
  });
  return { version: DASH_BOARD_VERSION, preferredColumns: normalizeGridColumns(value.preferredColumns, 12), items, layouts };
}

function nearestLayout(board, targetColumns) {
  return DASH_GRID_OPTIONS.filter((columns) => Array.isArray(board.layouts[columns]))
    .sort((a, b) => Math.abs(a - targetColumns) - Math.abs(b - targetColumns))[0];
}

export function ensureDashboardLayout(board, columns) {
  const cols = normalizeGridColumns(columns);
  if (!Array.isArray(board.layouts[cols])) {
    const sourceColumns = nearestLayout(board, cols);
    board.layouts[cols] = sourceColumns
      ? deriveDashboardLayout(board.layouts[sourceColumns], sourceColumns, cols, board.items)
      : buildDefaultLayout(board.items, cols);
  }
  return board.layouts[cols];
}

export function dashboardViewportCapacity(width = Number(globalThis.window?.innerWidth || 1440)) {
  if (width <= 680) return 4;
  if (width <= 1100) return 6;
  return 12;
}

export function dashboardColumns(board, width) {
  const capacity = dashboardViewportCapacity(width);
  return DASH_GRID_OPTIONS.find((columns) => columns <= Math.min(board.preferredColumns, capacity)) || 4;
}

// ── Estado de layout (persistido em UI prefs) ─────────────────────────────────
export function getDashboardBoard(ws) {
  state.dashLayout = state.dashLayout || {};
  const current = state.dashLayout[ws];
  const board = current?.version === DASH_BOARD_VERSION ? current : migrateDashboardBoard(current, ws);
  state.dashLayout[ws] = board;
  state.dashProfiles = state.dashProfiles || {};
  state.dashProfiles[ws] = state.dashProfiles[ws] || {};
  Object.keys(state.dashProfiles[ws]).forEach((name) => {
    const profile = state.dashProfiles[ws][name];
    if (profile?.version === DASH_BOARD_VERSION) return;
    state.dashProfiles[ws][name] = migrateDashboardBoard(profile, ws);
  });
  if (current !== board) persist();
  return board;
}

export function getLayout(ws, columns) {
  const board = getDashboardBoard(ws);
  const cols = normalizeGridColumns(columns, dashboardColumns(board));
  const items = itemByUid(board.items);
  return ensureDashboardLayout(board, cols).map((rect) => ({ ...items.get(rect.uid), ...rect }));
}

function persist() {
  saveUiPrefs({ dashLayout: state.dashLayout, dashProfiles: state.dashProfiles });
}

// ── Mutadores (chamados pelas actions em app-hotfix) ─────────────────────────
export function dashPreviewPlacement(ws, uid, geometry, columns) {
  const board = getDashboardBoard(ws);
  const cols = normalizeGridColumns(columns, dashboardColumns(board));
  const item = board.items.find((entry) => entry.uid === uid);
  if (!item) return ensureDashboardLayout(board, cols);
  const next = ensureDashboardLayout(board, cols).map((rect) => rect.uid === uid
    ? normalizeDashboardGeometry({ ...rect, ...geometry }, item.type, cols)
    : { ...rect });
  return resolveDashboardCollisions(next, uid, cols);
}

export function dashMoveWidget(ws, uid, x, y, columns) {
  const board = getDashboardBoard(ws);
  const cols = normalizeGridColumns(columns, dashboardColumns(board));
  board.layouts[cols] = dashPreviewPlacement(ws, uid, { x, y }, cols);
  persist();
}

export function dashAddWidget(ws, type) {
  if (!WIDGETS[type]) return;
  const board = getDashboardBoard(ws);
  const item = { uid: newUid(type), type };
  board.items.push(item);
  DASH_GRID_OPTIONS.forEach((columns) => {
    if (!Array.isArray(board.layouts[columns])) return;
    const rect = { uid: item.uid, x: 0, y: 0, ...defaultSize(type, columns) };
    board.layouts[columns].push(findFirstFree(rect, board.layouts[columns], columns));
  });
  persist();
}
export function dashRemoveWidget(ws, uid) {
  const board = getDashboardBoard(ws);
  board.items = board.items.filter((item) => item.uid !== uid);
  DASH_GRID_OPTIONS.forEach((columns) => {
    if (Array.isArray(board.layouts[columns])) board.layouts[columns] = board.layouts[columns].filter((rect) => rect.uid !== uid);
  });
  persist();
}
// Commit do arraste: reordena o layout pra casar com a lista de uids lida do DOM.
// (uids não presentes na lista — ex.: algo fora de sincronia — vão pro fim, na ordem atual.)
export function dashApplyOrder(ws, uidOrder, columns) {
  const board = getDashboardBoard(ws);
  const cols = normalizeGridColumns(columns, dashboardColumns(board));
  board.layouts[cols] = organizeDashboardLayout(ensureDashboardLayout(board, cols), cols, uidOrder);
  persist();
}
export function dashSetWidgetSize(ws, uid, w, h, columns) {
  const board = getDashboardBoard(ws);
  const cols = normalizeGridColumns(columns, dashboardColumns(board));
  board.layouts[cols] = dashPreviewPlacement(ws, uid, { w, h }, cols);
  persist();
}
export function dashSetGridColumns(ws, columns) {
  const board = getDashboardBoard(ws);
  board.preferredColumns = normalizeGridColumns(columns, board.preferredColumns);
  ensureDashboardLayout(board, board.preferredColumns);
  persist();
}
export function dashOrganizeLayout(ws, columns) {
  const board = getDashboardBoard(ws);
  const cols = normalizeGridColumns(columns, dashboardColumns(board));
  board.layouts[cols] = organizeDashboardLayout(ensureDashboardLayout(board, cols), cols, board.items.map((item) => item.uid));
  persist();
}
export function dashboardPresets(ws) { return LAYOUT_PRESETS[ws] || []; }
// Aplica um preset: monta um board novo com os cards do preset, preservando a densidade ativa.
export function dashApplyPreset(ws, presetId) {
  const preset = (LAYOUT_PRESETS[ws] || []).find((p) => p.id === presetId);
  if (!preset) return;
  const current = getDashboardBoard(ws);
  const prefer = normalizeGridColumns(current.preferredColumns, 12);
  const items = preset.types.filter((type) => WIDGETS[type]).map((type) => ({ uid: newUid(type), type }));
  const board = { version: DASH_BOARD_VERSION, preferredColumns: prefer, items, layouts: { 12: buildDefaultLayout(items, 12), 6: null, 4: null } };
  ensureDashboardLayout(board, prefer);
  state.dashLayout[ws] = board;
  persist();
}
export function dashSetNota(ws, uid, field, value) {
  const item = getDashboardBoard(ws).items.find((entry) => entry.uid === uid);
  if (!item) return;
  item[field === 'title' ? 'title' : 'body'] = value;
  persist();
}
export function dashGetCambioConfig(ws, uid) {
  const item = getDashboardBoard(ws).items.find((entry) => entry.uid === uid);
  return item ? normalizeCambioConfig(item) : null;
}
export function dashSetCambioConfig(ws, uid, field, value) {
  const item = getDashboardBoard(ws).items.find((entry) => entry.uid === uid);
  if (!item) return;
  let changed = false;
  if (field === 'valor') {
    const next = String(value ?? '').trim().slice(0, 24);
    changed = item.cambioValor !== next;
    item.cambioValor = next;
  }
  if ((field === 'de' || field === 'para') && MOEDA_CODES.has(String(value || '').toUpperCase())) {
    const key = field === 'de' ? 'cambioDe' : 'cambioPara';
    const next = String(value).toUpperCase();
    changed = changed || item[key] !== next;
    item[key] = next;
  }
  if (field === 'dias' && CAMBIO_PERIODOS.includes(Number(value))) {
    const next = Number(value);
    changed = changed || item.cambioDias !== next;
    item.cambioDias = next;
  }
  if (changed && state.dashCambioResults) delete state.dashCambioResults[uid];
  if (changed) persist();
}
export function dashSwapCambio(ws, uid) {
  const item = getDashboardBoard(ws).items.find((entry) => entry.uid === uid);
  if (!item) return;
  const config = normalizeCambioConfig(item);
  item.cambioDe = config.para;
  item.cambioPara = config.de;
  if (state.dashCambioResults) delete state.dashCambioResults[uid];
  persist();
}
export function dashResetLayout(ws, columns) {
  const board = getDashboardBoard(ws);
  const cols = normalizeGridColumns(columns, dashboardColumns(board));
  board.layouts[cols] = buildDefaultLayout(board.items, cols);
  persist();
}
export function dashSaveProfile(ws, nome) {
  if (!nome) return;
  const board = getDashboardBoard(ws);
  state.dashProfiles[ws][nome] = clone(board);
  persist();
}
export function dashLoadProfile(ws, nome) {
  const snapshot = state.dashProfiles?.[ws]?.[nome];
  if (!snapshot) return;
  state.dashLayout[ws] = migrateDashboardBoard(clone(snapshot), ws);
  persist();
}
export function dashDeleteProfile(ws, nome) {
  if (state.dashProfiles?.[ws]?.[nome]) { delete state.dashProfiles[ws][nome]; persist(); }
}

// ── Render ────────────────────────────────────────────────────────────────────
function widgetShell(item, ctx) {
  const def = WIDGETS[item.type];
  if (!def) return '';
  const minimum = minSize(item.type, ctx.columns);
  let body = '';
  try { body = def.render(ctx, item) || ''; }
  catch (e) { body = `<div class="card text-danger">Erro no card "${escapeHtml(def.title)}".</div>`; }
  const edit = state.dashEdit;
  const bar = edit ? `
    <div class="dash-widget-bar">
      <button class="dash-widget-name" data-dash-move-handle title="Arraste para reposicionar" aria-label="Mover ${escapeHtml(def.title)}">⠿ ${escapeHtml(def.title)}</button>
      <span class="dash-widget-tools">
        <details class="dash-size-menu">
          <summary class="dash-widget-size" aria-label="Alterar tamanho de ${escapeHtml(def.title)}">
            <span class="dash-widget-size-value">${item.w}×${item.h}</span>
          </summary>
          <div class="dash-size-popover" role="group" aria-label="Dimensões do widget">
            <span>Largura</span>
            <button data-action="dash-widget-size" data-param="${escapeHtml(item.uid)}|w|-1" aria-label="Diminuir largura" ${item.w <= minimum.w ? 'disabled' : ''}>−</button>
            <strong>${item.w}</strong>
            <button data-action="dash-widget-size" data-param="${escapeHtml(item.uid)}|w|1" aria-label="Aumentar largura" ${item.w >= ctx.columns ? 'disabled' : ''}>+</button>
            <span>Altura</span>
            <button data-action="dash-widget-size" data-param="${escapeHtml(item.uid)}|h|-1" aria-label="Diminuir altura" ${item.h <= minimum.h ? 'disabled' : ''}>−</button>
            <strong>${item.h}</strong>
            <button data-action="dash-widget-size" data-param="${escapeHtml(item.uid)}|h|1" aria-label="Aumentar altura" ${item.h >= DASH_GRID_MAX_H ? 'disabled' : ''}>+</button>
          </div>
        </details>
        <button data-action="dash-widget-remove" data-param="${escapeHtml(item.uid)}" class="dash-widget-x" title="Remover" aria-label="Remover ${escapeHtml(def.title)}">×</button>
      </span>
    </div>` : '';
  const resize = edit ? `<button class="dash-resize-handle" data-dash-resize aria-label="Redimensionar ${escapeHtml(def.title)}" title="Arraste para redimensionar"></button>` : '';
  return `<div class="dash-widget ${edit ? 'is-edit' : ''}"
      style="--x:${item.x};--y:${item.y};--w:${item.w};--h:${item.h};grid-column:${item.x + 1} / span ${item.w};grid-row:${item.y + 1} / span ${item.h};"
      data-dash-uid="${escapeHtml(item.uid)}" data-x="${item.x}" data-y="${item.y}" data-w="${item.w}" data-h="${item.h}" data-min-w="${minimum.w}" data-min-h="${minimum.h}">
    ${bar}
    <div class="dash-widget-body">${body}</div>
    ${resize}
  </div>`;
}

function profilesBar(ws) {
  const profs = state.dashProfiles?.[ws] || {};
  const names = Object.keys(profs);
  return `<div class="card dash-profiles">
    <span class="dash-profiles-label">Perfis de layout</span>
    <div class="dash-prof-chips">
      ${names.length
        ? names.map((n) => `<span class="dash-prof-chip">
            <button data-action="dash-profile-load" data-param="${escapeHtml(ws)}" data-profile-name="${escapeHtml(n)}">${escapeHtml(n)}</button>
            <button class="dash-prof-del" data-action="dash-profile-del" data-param="${escapeHtml(ws)}" data-profile-name="${escapeHtml(n)}" title="Excluir perfil">×</button>
          </span>`).join('')
        : `<span class="muted" style="font-size:12px;">nenhum perfil salvo</span>`}
    </div>
    <div class="dash-profiles-actions">
      <button class="btn btn-sm btn-primary" data-action="dash-profile-save" data-param="${escapeHtml(ws)}">Salvar perfil atual</button>
      <button class="btn btn-sm btn-ghost" data-action="dash-layout-reset" data-param="${escapeHtml(ws)}">Restaurar padrão</button>
    </div>
  </div>`;
}

function gridControls(ws, board, columns) {
  const capacity = dashboardViewportCapacity();
  return `<div class="dash-grid-controls" role="group" aria-label="Densidade da grade">
    <span>Densidade</span>
    ${DASH_GRID_OPTIONS.map((option) => `<button class="btn btn-sm ${columns === option ? 'btn-primary' : 'btn-ghost'}"
      data-action="dash-grid-columns" data-param="${escapeHtml(ws)}|${option}"
      aria-pressed="${columns === option}" ${option > capacity ? 'disabled' : ''}>${option}</button>`).join('')}
    <button class="btn btn-sm btn-ghost" data-action="dash-layout-organize" data-param="${escapeHtml(ws)}|${columns}">Organizar</button>
    ${board.preferredColumns !== columns ? `<small class="muted">Desktop: ${board.preferredColumns} colunas</small>` : ''}
  </div>`;
}

function presetsBar(ws) {
  const presets = dashboardPresets(ws);
  if (!presets.length) return '';
  return `<div class="card dash-presets">
    <div class="dash-presets-head">
      <span class="dash-presets-label">Layouts prontos</span>
      <small class="muted">aplicam um arranjo de cards — você ajusta depois</small>
    </div>
    <div class="dash-presets-grid">
      ${presets.map((p) => `
        <button class="dash-preset-card" type="button" data-action="dash-apply-preset"
                data-param="${escapeHtml(ws)}|${escapeHtml(p.id)}" title="${escapeHtml(p.desc)}">
          <span class="dash-preset-icon" aria-hidden="true">${p.icon}</span>
          <span class="dash-preset-text">
            <strong>${escapeHtml(p.nome)}</strong>
            <small>${escapeHtml(p.desc)}</small>
          </span>
        </button>`).join('')}
    </div>
  </div>`;
}

function palette(ws) {
  return `<div class="card dash-palette">
    <div class="card-header"><h3>Adicionar card</h3>
      <button class="btn btn-sm btn-ghost" data-action="dash-add-toggle">Fechar</button>
    </div>
    <div class="dash-palette-grid">
      ${widgetsForScope(ws).map(([key, d]) => `
        <button class="dash-palette-item" data-action="dash-widget-add" data-param="${escapeHtml(ws)}|${escapeHtml(key)}">
          <strong>${escapeHtml(d.title)}</strong>
          <small class="muted">${escapeHtml(d.desc || '')}</small>
        </button>`).join('')}
    </div>
  </div>`;
}

// Seletor de período dos KPIs (Receitas/Despesas/Lucro do mês). "Mês atual" =
// comportamento padrão; "Período" abre dois date-pickers para um intervalo livre
// (ex.: dia 1 ao 30, ou dia 30 de um mês ao dia 30 do seguinte). A escolha é
// persistida no backend por empresa/usuário/escopo (ver /dashboard-config).
function periodoControl() {
  const p = state.filters.dashPeriodo || { tipo: 'mes' };
  const isCustom = p.tipo === 'custom';
  return `<div class="dash-periodo" role="group" aria-label="Período do dashboard">
    <button class="btn btn-sm ${!isCustom ? 'btn-primary' : 'btn-ghost'}" data-action="dash-periodo-tipo" data-param="mes" aria-pressed="${!isCustom}">Mês atual</button>
    <button class="btn btn-sm ${isCustom ? 'btn-primary' : 'btn-ghost'}" data-action="dash-periodo-tipo" data-param="custom" aria-pressed="${isCustom}">Período</button>
    ${isCustom ? `
      <input type="date" class="input input-sm" value="${escapeHtml(p.dataInicio || '')}" data-action="dash-periodo-inicio" aria-label="Data início do período" />
      <span class="muted">até</span>
      <input type="date" class="input input-sm" value="${escapeHtml(p.dataFim || '')}" data-action="dash-periodo-fim" aria-label="Data fim do período" />
    ` : ''}
  </div>`;
}

function renderModular(ws) {
  seedDashboardData(state);
  const isEmp = ws === 'empresarial';
  const mes = isEmp ? (state.filters.dashMes || (state.filters.dashMes = defaultMes())) : null;
  if (isEmp) ensureDre(mes);

  const edit = state.dashEdit;
  const monthNav = isEmp
    ? `<button class="btn btn-ghost btn-sm" data-action="dash-month-prev" title="Mês anterior">‹</button>
       ${monthPicker(mes)}
       <button class="btn btn-ghost btn-sm" data-action="dash-month-next" title="Próximo mês">›</button>`
    : '';
  const actions = `
    ${periodoControl()}
    ${monthNav}
    ${edit ? `<button class="btn btn-sm btn-ghost" data-action="dash-add-toggle">+ Adicionar card</button>` : ''}
    <button class="btn btn-sm ${edit ? 'btn-primary' : 'btn-ghost'}" data-action="dash-edit-toggle" title="Ativar/desativar edição do layout">
      ${edit ? '✓ Editando layout' : '✎ Editar layout'}
    </button>
    ${!isEmp ? `<button class="btn btn-primary btn-sm" data-action="open-modal-transacao" data-param="despesa">+ Lançamento</button>` : ''}`;

  const board = getDashboardBoard(ws);
  const columns = dashboardColumns(board);
  const layout = getLayout(ws, columns);
  const ctx = { ws, mes, columns };

  // Subtítulo reflete o período ativo dos KPIs: intervalo custom > mês corrente.
  const per = state.filters.dashPeriodo || { tipo: 'mes' };
  const subtitulo = (per.tipo === 'custom' && per.dataInicio && per.dataFim)
    ? `Período de ${formatDateBR(per.dataInicio)} a ${formatDateBR(per.dataFim)}`
    : (isEmp ? `Resultado de ${escapeHtml(mesLabel(mes))}` : 'Visão geral da sua vida financeira');

  return `
    <section class="page-section dash-modular">
      ${pageHeader({
        titulo: isEmp ? 'Dashboard empresarial' : 'Dashboard',
        subtitulo,
        actions
      })}
      ${renderCurrencyWarning(state.data.dashboard?.moeda_incompleta, state.data.dashboard?.moeda_base)}
      ${edit ? presetsBar(ws) : ''}
      ${edit ? profilesBar(ws) : ''}
      ${edit ? gridControls(ws, board, columns) : ''}
      ${edit && state.dashAddOpen ? palette(ws) : ''}
      <div class="dash-mod-grid ${edit ? 'is-edit' : ''}" style="--dash-cols:${columns};" data-dash-columns="${columns}" data-dash-workspace="${escapeHtml(ws)}">
        ${layout.map((item) => widgetShell(item, ctx)).join('')}
      </div>
    </section>`;
}

export function renderDashboardEmpresarialModular() { return renderModular('empresarial'); }
export function renderDashboardPessoalModular() { return renderModular('pessoal'); }
