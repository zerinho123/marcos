// ============================================================================
// views/dashboard-store.js — selectors + lancamento optimista
// ============================================================================

import { DONUT_PALETTE } from './charts.js?v=20260727-finance-v87';
import { classeFromCategoria } from './despesa-classificacao.js?v=20260727-finance-v87';
import { soma } from '../lib/money.js?v=20260727-finance-v87';

// Reexport: fonte única de classificação fica em despesa-classificacao.js.
export { classeFromCategoria };

export const LANCAMENTO_TIPOS = [
  { id: 'income',   label: 'Receita',          fluxo: 'receita', classe: null },
  { id: 'fixed',    label: 'Despesa fixa',     fluxo: 'despesa', classe: 'fixa' },
  { id: 'variable', label: 'Despesa variavel', fluxo: 'despesa', classe: 'variavel' }
];

export const tipoMeta = (id) => LANCAMENTO_TIPOS.find((t) => t.id === id) || LANCAMENTO_TIPOS[2];

const ABERTO_STATUS = new Set(['pendente', 'vencido', 'parcial']);
const baseValue = (item, field = 'valor') => Number(item?.[`${field}_base`] ?? item?.[field] ?? 0);
const baseOutstanding = (item) => Number.isFinite(Number(item?.saldo_base))
  ? Number(item.saldo_base)
  : Math.max(0, baseValue(item, 'valor') - baseValue(item, 'valor_pago'));

/** Mapa id->categoria para joins client-side. */
function catIndex(state) {
  const idx = {};
  (state.data.categorias || []).forEach((c) => { idx[c.id] = c; });
  return idx;
}

/** Constrói os 6 meses a partir de transacoes reais (e fecha o mes atual com o dashboard). */
function buildCashflow6m(state) {
  const now = new Date();
  const meses = [];
  const idx = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
    const m = { key, mes: label.charAt(0).toUpperCase() + label.slice(1, 3), income: 0, expense: 0 };
    meses.push(m);
    idx[key] = m;
  }

  // Meses anteriores: somatorio das transacoes carregadas (ultimas 50)
  (state.data.transacoes || []).forEach((t) => {
    const key = String(t.data || '').slice(0, 7);
    const m = idx[key];
    if (!m) return;
    if (t.tipo === 'receita')      m.income  += baseValue(t);
    else if (t.tipo === 'despesa') m.expense += baseValue(t);
  });

  // Mes corrente: o dashboard.mes_atual e autoritativo (transacoes vem truncadas em 50)
  const cur = meses[meses.length - 1];
  const dm  = state.data.dashboard?.mes_atual;
  if (dm) {
    cur.income  = Number(dm.receitas || 0);
    cur.expense = Number(dm.despesas || 0);
  }
  return meses;
}

/** Invalida os caches derivados pra forcar rebuild a partir dos dados frescos do servidor.
 *  Chamado por loadAllData() apos cada refresh — fecha o ciclo otimista→reconciliacao. */
export function invalidateDashboardDerived(state) {
  state.data.cashflow6m      = null;
  state.data.expenseBreakdown = null;
  state.data.variableRecent  = null;
}

/** Seed inicial das estruturas de dashboard (roda uma vez, na primeira renderizacao). */
export function seedDashboardData(state) {
  const catMap = catIndex(state);

  if (!state.data.cashflow6m) {
    state.data.cashflow6m = buildCashflow6m(state);
  }

  // Donut: composicao das despesas por categoria. Fonte primaria = transacoes de despesa
  // (mesma fonte do "+ Lancamento" → reconcilia apos refreshAll). Sem transacoes, cai para
  // contas a pagar em ABERTO (pendente/vencido/parcial), excluindo as pagas pra nao inflar.
  if (!state.data.expenseBreakdown) {
    const bk = { variavel: {}, fixa: {} };
    const txDesp = (state.data.transacoes || []).filter((t) => t.tipo === 'despesa');
    if (txDesp.length) {
      txDesp.forEach((t) => {
        const cat  = catMap[t.categoria_id];
        const nome = cat?.nome || 'Outros';
        const cls  = classeFromCategoria(cat);
        bk[cls][nome] = (bk[cls][nome] || 0) + baseValue(t);
      });
    } else {
      (state.data.contasPagar || [])
        .filter((p) => ABERTO_STATUS.has(p.status))
        .forEach((p) => {
          const cat  = catMap[p.categoria_id];
          const nome = cat?.nome || 'Outros';
          const cls  = classeFromCategoria(cat);
          const rest = baseOutstanding(p);
          if (rest > 0) bk[cls][nome] = (bk[cls][nome] || 0) + rest;
        });
    }
    state.data.expenseBreakdown = bk;
  }

  // Tabela: despesas variaveis REALIZADAS recentes (transacoes despesa + categoria variavel),
  // ordenadas por data desc; cai para contas a pagar variaveis em aberto se nao houver transacoes.
  if (!state.data.variableRecent) {
    const fromTx = (state.data.transacoes || [])
      .filter((t) => t.tipo === 'despesa' && classeFromCategoria(catMap[t.categoria_id]) === 'variavel')
      .map((t) => ({
        data: t.data,
        descricao: t.descricao,
        categoria_nome: catMap[t.categoria_id]?.nome || 'Outros',
        valor: baseValue(t),
        tipo: 'variable'
      }));

    const fromAp = fromTx.length ? [] : (state.data.contasPagar || [])
      .filter((p) => ABERTO_STATUS.has(p.status) && classeFromCategoria(catMap[p.categoria_id]) === 'variavel')
      .map((p) => ({
        data: p.vencimento,
        descricao: p.descricao,
        categoria_nome: catMap[p.categoria_id]?.nome || 'Outros',
        valor: baseOutstanding(p),
        tipo: 'variable'
      }));

    state.data.variableRecent = [...fromTx, ...fromAp]
      .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')))
      .slice(0, 8);
  }
}

/** Aplica lancamento OTIMISTA: KPIs, donut, gráfico, DRE. */
export function applyLancamento(state, l) {
  const valor = Number(l.valor) || 0;
  const meta  = tipoMeta(l.tipo);

  // KPIs — dashboard.mes_atual
  const dash = state.data.dashboard = state.data.dashboard
    || { mes_atual: { receitas: 0, despesas: 0 }, inadimplencia: { total: 0, contas: [] } };
  if (!dash.mes_atual) dash.mes_atual = { receitas: 0, despesas: 0 };
  if (meta.fluxo === 'receita') {
    dash.mes_atual.receitas = Number(dash.mes_atual.receitas || 0) + valor;
  } else {
    dash.mes_atual.despesas = Number(dash.mes_atual.despesas || 0) + valor;
  }

  // Donut — expenseBreakdown
  if (meta.fluxo === 'despesa') {
    const bk = state.data.expenseBreakdown = state.data.expenseBreakdown || { variavel: {}, fixa: {} };
    const cls  = meta.classe || 'variavel';
    const nome = l.categoria_nome || 'Sem categoria';
    bk[cls][nome] = (bk[cls][nome] || 0) + valor;
  }

  // Tabela recentes
  if (meta.classe === 'variavel') {
    state.data.variableRecent = [{ ...l, valor }, ...(state.data.variableRecent || [])].slice(0, 8);
  }

  // Bar chart — mês corrente (último item)
  const m6 = state.data.cashflow6m;
  if (Array.isArray(m6) && m6.length) {
    const cur = m6[m6.length - 1];
    if (meta.fluxo === 'receita') cur.income  = (cur.income  || 0) + valor;
    else                           cur.expense = (cur.expense || 0) + valor;
  }

  // DRE resumo (se carregado)
  const r = state.data.dre?.resumo;
  if (r) {
    const n = (k) => Number(r[k] || 0);
    if (meta.fluxo === 'receita') {
      r.receita_bruta   = n('receita_bruta')   + valor;
      r.receita_liquida = n('receita_liquida') + valor;
      r.margem_bruta    = n('margem_bruta')    + valor;
      r.ebtda           = n('ebtda')           + valor;
      r.lucro_liquido   = n('lucro_liquido')   + valor;
    } else if (meta.classe === 'variavel') {
      r.margem_bruta  = n('margem_bruta')  - valor;
      r.ebtda         = n('ebtda')         - valor;
      r.lucro_liquido = n('lucro_liquido') - valor;
    } else {
      r.ebtda         = n('ebtda')         - valor;
      r.lucro_liquido = n('lucro_liquido') - valor;
    }
  }
}

// === Selectors ===
export const selectCashflow6m     = (state) => state.data.cashflow6m     || [];
export const selectVariableRecent = (state) => state.data.variableRecent || [];

export function selectDonut(state) {
  const bk = state.data.expenseBreakdown || { variavel: {}, fixa: {} };
  const rows = [
    ...Object.entries(bk.variavel).map(([label, value]) => ({ label, value, classe: 'variavel' })),
    ...Object.entries(bk.fixa).map(([label, value])     => ({ label, value, classe: 'fixa' }))
  ].filter((x) => x.value > 0).sort((a, b) => b.value - a.value);

  const slices        = rows.map((x, i) => ({ ...x, color: DONUT_PALETTE[i % DONUT_PALETTE.length] }));
  const totalVariable = soma(Object.values(bk.variavel));
  const totalFixed    = soma(Object.values(bk.fixa));
  const total         = soma([totalVariable, totalFixed]);
  return { slices, totalVariable, totalFixed, total, pctVariable: total ? (totalVariable / total) * 100 : 0 };
}
