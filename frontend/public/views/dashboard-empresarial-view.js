// ============================================================================
// views/dashboard-empresarial-view.js — visão Empresarial
// ----------------------------------------------------------------------------
// Cascata tipo DRE (Receita → Deduções → ... → Lucro/Prejuízo) com seções
// expansíveis, reusando o endpoint /dre (mesmo cache da view DRE). Abaixo:
// gráficos (fluxo 6m + pizza), inadimplência configurável e A receber/A pagar.
// ============================================================================

import {
  state, escapeHtml, formatCurrency, formatDateBR, formatPercent
} from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader } from './shared.js?v=20260727-finance-v87';
import { renderBarChart, renderDonutChart } from './charts.js?v=20260727-finance-v87';
import { seedDashboardData, selectCashflow6m, selectDonut } from './dashboard-store.js?v=20260727-finance-v87';
import { cardAReceber, cardAPagar } from './kpi-cards.js?v=20260727-finance-v87';
import { defaultMes, mesLabel, ensureDre } from './dre-shared.js?v=20260727-finance-v87';
import { calcularPercentualReceita } from './finance-calc.js?v=20260727-finance-v87';

const num = (v) => Number(v || 0);
const ABERTO_STATUS = new Set(['pendente', 'vencido', 'parcial']);

// ── Seletor de mês (mesmo visual do DRE, com actions próprias do dashboard) ───
export function monthPicker(mes) {
  const [selectedYear, selectedMonth] = String(mes).split('-').map(Number);
  const year = Number(state.filters.dashCalendarYear || selectedYear || new Date().getFullYear());
  const open = !!state.filters.dashCalendarOpen;
  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  return `
    <div class="dre-month-control ${open ? 'open' : ''}">
      <button class="chip dre-month-trigger" data-action="dash-calendar-toggle" type="button" aria-haspopup="dialog" aria-expanded="${open ? 'true' : 'false'}">
        ${escapeHtml(mesLabel(mes))}
      </button>
      ${open ? `
        <div class="dre-calendar-popover" role="dialog" aria-label="Selecionar mês do dashboard">
          <div class="dre-calendar-head">
            <button class="btn btn-ghost btn-sm" data-action="dash-calendar-prev-year" type="button" title="Ano anterior">‹</button>
            <strong>${year}</strong>
            <button class="btn btn-ghost btn-sm" data-action="dash-calendar-next-year" type="button" title="Próximo ano">›</button>
          </div>
          <div class="dre-month-grid">
            ${months.map((label, idx) => {
              const month = idx + 1;
              const value = `${year}-${String(month).padStart(2, '0')}`;
              const active = year === selectedYear && month === selectedMonth;
              return `<button class="dre-month-cell ${active ? 'active' : ''}" data-action="dash-calendar-select" data-param="${value}" type="button">${label}</button>`;
            }).join('')}
          </div>
        </div>` : ''}
    </div>`;
}

// ── Cascata: monta os nós a partir da estrutura/resumo do /dre ────────────────
// Só entra no relatório o que tem valor: categorias/linhas com 0 reais (e sem
// filhos com valor) são podadas — nada de linha zerada poluindo o detalhamento.
function itemNodes(items, parentKey) {
  return (items || [])
    .filter((it) => it.kind !== 'volume' && it.kind !== 'unit')
    .map((it) => {
      const key = `${parentKey}/${it.nome}`;
      const children = itemNodes(it.itens, key);
      return {
        key,
        label: it.nome === 'CMV' ? 'CMV/CPV/CSV' : it.nome,
        value: num(it.real),
        children
      };
    })
    .filter((n) => n.value !== 0 || n.children.length > 0);
}

const FIXA_LABEL = {
  'DESPESAS COMERCIAIS': 'Despesas comerciais',
  'DESPESAS OPERACIONAIS DIRETAS': 'Despesas operacionais',
  'DESPESAS ADMINISTRATIVAS': 'Despesas administrativas',
  'DESPESAS NÃO OPERACIONAIS': 'Despesas não operacionais'
};

function buildCascata(dre) {
  const rows = dre.estrutura || [];
  const resumo = dre.resumo || {};
  const byName = new Map(rows.map((r) => [r.nome, r]));
  const get = (name) => byName.get(name) || { real: 0, itens: [] };

  const receita = get('RECEITA BRUTA');
  const deducoes = get('DEDUÇÕES DA RECEITA BRUTA');
  const despVar = get('DESPESAS VARIÁVEIS');
  const juros = get('JUROS; EMPRÉSTIMOS; PARCELAMENTO');

  const fixaSecoes = ['DESPESAS COMERCIAIS', 'DESPESAS OPERACIONAIS DIRETAS', 'DESPESAS ADMINISTRATIVAS', 'DESPESAS NÃO OPERACIONAIS'];
  const fixasChildren = fixaSecoes
    .map((nome) => {
      const sec = get(nome);
      const key = `fixas/${nome}`;
      return { key, label: FIXA_LABEL[nome] || nome, value: num(sec.real), children: itemNodes(sec.itens, key) };
    })
    .filter((c) => c.value !== 0 || c.children.length > 0);
  const fixasTotal = fixasChildren.reduce((s, c) => s + c.value, 0);

  const lucro = num(resumo.lucro_liquido);

  // kind: base (+) | deduz (−) | total (= subtotal) | final (= resultado)
  return [
    { key: 'receita', kind: 'base', label: 'Receita bruta', value: num(resumo.receita_bruta),
      children: itemNodes(receita.itens, 'receita') },
    { key: 'deducoes', kind: 'deduz', label: 'Deduções da receita', value: num(deducoes.real),
      children: itemNodes(deducoes.itens, 'deducoes') },
    { kind: 'total', label: 'Receita líquida', value: num(resumo.receita_liquida) },
    { key: 'despvar', kind: 'deduz', label: 'Despesas variáveis', value: num(despVar.real),
      children: itemNodes(despVar.itens, 'despvar') },
    { kind: 'total', label: 'Margem de contribuição', value: num(resumo.margem_bruta) },
    { key: 'fixas', kind: 'deduz', label: 'Despesas fixas', value: fixasTotal, children: fixasChildren },
    { kind: 'total', label: 'EBITDA', value: num(resumo.ebtda) },
    { key: 'juros', kind: 'deduz', label: 'Juros / empréstimos / parcelamentos', value: num(juros.real),
      children: itemNodes(juros.itens, 'juros') },
    { kind: 'final', label: lucro >= 0 ? 'Lucro líquido' : 'Prejuízo', value: lucro }
  ];
}

// Linhas do detalhamento (card de hover e detalhe inline expandido; recursivo).
function hovercardLines(nodes, depth) {
  return nodes.map((n) => {
    const row = `
      <div class="dash-hovercard-row" style="--hc-indent:${depth * 14}px;">
        <span class="dash-hovercard-name">${escapeHtml(n.label)}</span>
        <span class="dash-hovercard-val ${n.value < 0 ? 'dash-neg' : ''}">${formatCurrency(n.value)}</span>
      </div>`;
    const kids = (n.children && n.children.length > 0) ? hovercardLines(n.children, depth + 1) : '';
    return row + kids;
  }).join('');
}

// Cor do card por papel na cascata (mesma linguagem dos KPI cards do v18).
function metricKind(node) {
  if (node.kind === 'base') return 'primary';
  if (node.kind === 'deduz') return 'danger';
  if (node.kind === 'final') return node.value >= 0 ? 'success' : 'danger';
  return 'info'; // subtotais calculados (receita líquida, margem, EBITDA)
}

// Tom da porcentagem "da receita" — viva, não cinza apagado. Casa com o papel da
// linha: base=accent, deduções/despesas=vermelho, subtotais=info, resultado=verde/vermelho.
function pctTone(node) {
  if (node.kind === 'deduz') return 'neg';
  if (node.kind === 'final') return node.value >= 0 ? 'pos' : 'neg';
  return 'info';
}

function pctReceita(value, receitaLiquida) {
  const percentual = calcularPercentualReceita(value, receitaLiquida);
  if (percentual == null) return '';
  return `${percentual.toFixed(1).replace('.', ',')}% da receita`;
}

// Card modular de uma linha da cascata. Clicar numa linha com detalhe expande o
// detalhamento INLINE (no próprio card) — sem balão flutuante, que antes ficava
// "escondido lá atrás" por ser recortado pelo scroll/empilhamento dos widgets.
function metricCard(node, receitaLiquida) {
  const expanded = state.filters.dashExpanded || {};
  const hasKids = node.children && node.children.length > 0 && node.key;
  const isOpen = hasKids && !!expanded[node.key];
  const kind = metricKind(node);
  const sign = node.kind === 'base' ? '+' : node.kind === 'deduz' ? '−' : '=';
  const valNeg = node.value < 0 ? 'dash-neg' : '';
  const pct = node.kind === 'base' ? '' : pctReceita(node.value, receitaLiquida);
  const pctHtml = pct ? `<span class="dash-metric-pct dash-pct-${pctTone(node)}">${pct}</span>` : '';
  const chevron = hasKids ? `<span class="dash-chevron ${isOpen ? 'open' : ''}" aria-hidden="true">▸</span>` : '';
  const detail = (hasKids && isOpen)
    ? `<div class="dash-metric-detail">${hovercardLines(node.children, 0)}</div>`
    : '';

  return `
    <div class="kpi-card kpi-${kind} dash-metric ${hasKids ? 'dash-metric--clickable' : ''} ${isOpen ? 'is-open' : ''}"
         ${hasKids ? `data-action="dash-toggle" data-param="${escapeHtml(node.key)}" role="button" tabindex="0" aria-expanded="${isOpen ? 'true' : 'false'}"` : ''}>
      <div class="dash-metric-head">
        <span class="kpi-label">${escapeHtml(node.label)}</span>
        ${chevron}
      </div>
      <span class="kpi-value ${valNeg}">${formatCurrency(node.value)}</span>
      <div class="dash-metric-sub"><span class="dash-metric-sign">${sign}</span>${pctHtml}</div>
      ${detail}
    </div>`;
}

// Grade de cards modulares (substitui a cascata vertical única — layout estilo v18).
export function cascataCards(mes) {
  const dre = state.data.dreCache?.[mes];
  if (!dre || dre.loading) {
    return `<div class="card">Carregando resultado do mês…</div>`;
  }
  if (dre.erro) {
    return `<div class="card text-danger">Resultado: ${escapeHtml(dre.erro)}</div>`;
  }
  const nodes = buildCascata(dre);
  const receitaLiquida = num(dre.resumo?.receita_liquida);
  // Só mostra o que tem valor lançado: cards de dedução/despesa zerados somem.
  // A espinha dorsal (receita base + subtotais calculados + resultado) sempre fica,
  // pra cascata continuar legível mesmo com poucas linhas.
  const visiveis = nodes.filter((n) => {
    if (n.kind === 'deduz') return n.value !== 0 || (n.children && n.children.length > 0);
    return true;
  });
  return `
    <div class="dash-section-head">
      <h3>Resultado do mês</h3>
      <span class="muted" style="font-size:11.5px;">clique numa linha para ver o detalhamento</span>
    </div>
    <div class="kpi-grid dash-metric-grid">
      ${visiveis.map((n) => metricCard(n, receitaLiquida)).join('')}
    </div>`;
}

// ── Inadimplência (client-side, sobre contasReceber) ──────────────────────────
function diasAtraso(venc) {
  const m = String(venc || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  const due = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = new Date();
  const today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
  return Math.floor((today - due) / 86400000);
}

function selectInadimplencia() {
  const minDias = num(state.filters.inadMinDias) || 0;
  const ini = state.filters.inadDataInicio || null;
  const fim = state.filters.inadDataFim || null;
  const itens = (state.data.contasReceber || [])
    .filter((c) => ABERTO_STATUS.has(c.status))
    .map((c) => ({
      devedor_nome: c.devedor_nome,
      descricao: c.descricao,
      vencimento: c.vencimento,
      dias: diasAtraso(c.vencimento),
      valor: num(c.valor) - num(c.valor_pago)
    }))
    .filter((c) => c.dias >= minDias && c.valor > 0)
    .filter((c) => {
      const v = String(c.vencimento || '').slice(0, 10);
      if (ini && v < ini) return false;
      if (fim && v > fim) return false;
      return true;
    })
    .sort((a, b) => b.dias - a.dias);
  const total = itens.reduce((s, c) => s + c.valor, 0);
  return { itens, total };
}

export function inadCard() {
  const minDias = num(state.filters.inadMinDias) || 0;
  const ini = state.filters.inadDataInicio || '';
  const fim = state.filters.inadDataFim || '';
  const { itens, total } = selectInadimplencia();
  const chips = [15, 30, 60, 90].map((d) => `
    <button class="dash-chip ${minDias === d ? 'active' : ''}" type="button" data-action="inad-set-dias" data-param="${d}">+${d}d</button>`).join('');

  return `
    <div class="card">
      <div class="card-header">
        <h3>Inadimplência</h3>
        <button class="btn btn-sm btn-ghost" data-action="change-view" data-param="receber">Ver tudo</button>
      </div>
      <div class="inad-filters">
        <div class="inad-filter-group">
          <span class="inad-filter-label">Atraso mínimo</span>
          <div class="dash-chip-row">${chips}</div>
        </div>
        <div class="inad-filter-group">
          <span class="inad-filter-label">Período de vencimento</span>
          <div class="inad-date-row">
            <input type="date" class="input input-sm" value="${escapeHtml(ini)}" data-action="inad-set-inicio" />
            <span class="muted">até</span>
            <input type="date" class="input input-sm" value="${escapeHtml(fim)}" data-action="inad-set-fim" />
            ${(ini || fim) ? `<button class="btn btn-sm btn-ghost" data-action="inad-clear-datas" title="Limpar período">×</button>` : ''}
          </div>
        </div>
      </div>
      ${itens.length === 0
        ? `<div class="empty-state-sm">Nenhum título vencido há ${minDias}+ dias${(ini || fim) ? ' no período' : ''}. 🎉</div>`
        : `<ul class="list-clean inad-list">
            ${itens.map((i) => `
              <li>
                <span class="dot dot-danger"></span>
                <span class="grow">${escapeHtml(i.devedor_nome || '—')}
                  <small class="muted">${i.dias}d atraso${i.descricao ? ' · ' + escapeHtml(i.descricao) : ''} · venc. ${formatDateBR(i.vencimento)}</small>
                </span>
                <strong class="text-danger">${formatCurrency(i.valor)}</strong>
              </li>`).join('')}
          </ul>
          <div class="card-footer" style="margin-top:8px;">
            ${itens.length} título(s) · Total vencido: <strong class="text-danger">${formatCurrency(total)}</strong>
          </div>`}
    </div>`;
}

// ── View ──────────────────────────────────────────────────────────────────────
export function renderDashboardEmpresarialView() {
  seedDashboardData(state);

  const mes = state.filters.dashMes || (state.filters.dashMes = defaultMes());
  ensureDre(mes);

  const donut = selectDonut(state);

  const monthNav = `
    <button class="btn btn-ghost btn-sm" data-action="dash-month-prev" title="Mês anterior">‹</button>
    ${monthPicker(mes)}
    <button class="btn btn-ghost btn-sm" data-action="dash-month-next" title="Próximo mês">›</button>
    <button class="btn btn-primary btn-sm" data-action="open-modal-lancamento">+ Lançamento</button>`;

  return `
    <section class="page-section">
      ${pageHeader({
        titulo: 'Dashboard empresarial',
        subtitulo: `Resultado de ${escapeHtml(mesLabel(mes))}`,
        actions: monthNav
      })}

      ${cascataCards(mes)}

      <div class="dash-grid-2">
        <div class="card">
          <div class="card-header">
            <h3>Fluxo de caixa — 6 meses</h3>
            <div class="chart-legend-inline">
              <span><i class="sw-income"></i>Receita</span>
              <span><i class="sw-expense"></i>Despesa</span>
            </div>
          </div>
          ${renderBarChart(selectCashflow6m(state))}
        </div>

        <div class="card">
          <div class="card-header">
            <h3>Despesas — Fixo vs Variável</h3>
            ${donut.total > 0 ? `<span class="badge badge-info">${formatPercent(donut.pctVariable)} variável</span>` : ''}
          </div>
          <div class="donut-wrap">
            ${renderDonutChart(donut.slices)}
            <ul class="donut-legend">
              ${donut.slices.length === 0
                ? `<li class="muted">Nenhuma despesa lançada.</li>`
                : donut.slices.slice(0, 6).map((s) => `
                  <li>
                    <span class="legend-dot" style="background:${s.color}"></span>
                    <span class="legend-grow">${escapeHtml(s.label)} <small class="muted">${s.classe === 'variavel' ? 'var.' : 'fixa'}</small></span>
                    <span class="legend-val">${formatCurrency(s.value)}</span>
                  </li>`).join('')}
            </ul>
          </div>
        </div>
      </div>

      ${inadCard()}

      <div class="kpi-grid kpi-grid-rich">
        ${cardAReceber()}
        ${cardAPagar()}
      </div>
    </section>`;
}
