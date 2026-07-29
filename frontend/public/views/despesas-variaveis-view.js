// ============================================================================
// views/despesas-variaveis-view.js — Despesas variáveis (operacional, por mês)
// ----------------------------------------------------------------------------
// Tela operacional: filtros (período/workspace/categoria/conta), cards-resumo,
// tendência, ranking por categoria e a TABELA de lançamentos com ações
// (editar / excluir com confirmação).
//
// Classificação "variável" vem da FONTE ÚNICA (views/despesa-classificacao.js),
// alimentada por `categoria.dre_secao_efetiva` (mapa do DRE). Antes a tela usava
// regra própria e divergia do DRE/Dashboard — por isso aparecia vazia.
//
// Fonte de dados: GET /transacoes (despesa) da janela de 6 meses, filtrado no
// cliente por workspace (escopo da conta) e por categoria variável.
// ============================================================================

import {
  state, escapeHtml, formatCurrency, formatCurrencyShort, formatPercent, formatDateBR,
  categoriasDoWorkspace, contasDoWorkspace
} from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader, renderKpiCard } from './shared.js?v=20260727-finance-v87';
import { api } from '../security-client.js?v=20260727-finance-v87';
import { defaultMes as dreDefaultMes, ensureDre } from './dre-shared.js?v=20260727-finance-v87';
import { calcularPercentualReceita } from './finance-calc.js?v=20260727-finance-v87';
import { isVariavel } from './despesa-classificacao.js?v=20260727-finance-v87';

// ── Helpers de mês ────────────────────────────────────────────────────────────
function defaultMes() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function mesLongo(mes) {
  const [y, m] = mes.split('-').map(Number);
  if (!y || !m) return mes;
  const s = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function mesCurto(key) {
  const [y, m] = key.split('-').map(Number);
  const l = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
  return l.charAt(0).toUpperCase() + l.slice(1, 3);
}
function chaves6(mes) {
  const [y, m] = mes.split('-').map(Number);
  const ks = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1);
    ks.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return ks;
}
function janela(mes) {
  const ks = chaves6(mes);
  const [ey, em] = mes.split('-').map(Number);
  const ult = new Date(ey, em, 0).getDate();
  return { ini: `${ks[0]}-01`, fim: `${mes}-${String(ult).padStart(2, '0')}` };
}

// Workspace é um FILTRO LOCAL da tela (não o global): a tela vive no nav
// empresarial, mas permite espiar as despesas variáveis pessoais sem navegar pra
// fora. Default = empresarial.
function curWs() {
  return state.filters.despVarWs === 'pessoal' ? 'pessoal' : 'empresarial';
}
function catMap() {
  const idx = {};
  (state.data.categorias || []).forEach((c) => { idx[c.id] = c; });
  return idx;
}

// ── Carregamento (lazy, cache por workspace + mês) ─────────────────────────────
async function ensureDespVar(mes) {
  const ws = curWs();
  const cacheKey = `${ws}:${mes}`;
  state.data.despVar = state.data.despVar || {};
  if (state.data.despVar[cacheKey]) return;
  state.data.despVar[cacheKey] = { loading: true };
  try {
    const { ini, fim } = janela(mes);
    const resp = await api.transacoes({ data_inicio: ini, data_fim: fim, limit: 200 });
    state.data.despVar[cacheKey] = agregar(mes, ws, resp?.transacoes || []);
  } catch (e) {
    state.data.despVar[cacheKey] = { erro: e?.message || 'Falha ao carregar' };
  }
  if (typeof window.__renderApp === 'function') window.__renderApp();
}

function agregar(mes, ws, txs) {
  const cm = catMap();
  const ks = chaves6(mes);
  const varBucket = {};
  ks.forEach((k) => { varBucket[k] = 0; });
  const doMes = [];

  txs.forEach((t) => {
    if (t.tipo !== 'despesa') return;
    // Filtro de workspace: escopo da conta (legado sem escopo conta como pessoal).
    if ((t.conta_escopo || 'pessoal') !== ws) return;
    if (!isVariavel(cm[t.categoria_id])) return;
    const k = String(t.data || '').slice(0, 7);
    const val = Number(t.valor_base ?? t.valor ?? 0);
    if (k in varBucket) varBucket[k] += val;
    if (k === mes) doMes.push({
      id: t.id, data: t.data, valor: val, valor_original: Number(t.valor || 0), moeda: t.moeda,
      descricao: t.descricao,
      categoria_id: t.categoria_id || '',
      categoria_nome: t.categoria_nome || cm[t.categoria_id]?.nome || 'Sem categoria',
      conta_id: t.conta_id || '',
      conta_nome: t.conta_nome || '-'
    });
  });

  const trend = ks.map((k) => ({ key: k, label: mesCurto(k), total: varBucket[k] }));
  const porCat = {};
  doMes.forEach((t) => { porCat[t.categoria_nome] = (porCat[t.categoria_nome] || 0) + t.valor; });
  const ranking = Object.entries(porCat).map(([nome, total]) => ({ nome, total })).sort((a, b) => b.total - a.total);
  const lista = [...doMes].sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));

  return { trend, ranking, lista, total: varBucket[mes], count: doMes.length };
}

// ── Componentes visuais ───────────────────────────────────────────────────────
function trendChart(trend, mesKey) {
  if (trend.every((t) => t.total <= 0)) {
    return `<div class="tv-empty">Sem despesas variáveis nos últimos 6 meses.</div>`;
  }
  const W = 560, H = 200, padX = 16, padTop = 22, padBot = 26, innerH = H - padTop - padBot;
  const max = Math.max(1, ...trend.map((t) => t.total));
  const step = (W - padX * 2) / trend.length;
  const bw = Math.min(46, step * 0.52);
  const base = padTop + innerH;

  const grid = [0, 0.5, 1].map((f) => {
    const gy = (padTop + innerH - f * innerH);
    const lbl = (f > 0 && f < 1) ? formatCurrencyShort(f * max) : '';
    return `<line x1="${padX}" y1="${gy.toFixed(1)}" x2="${W - padX}" y2="${gy.toFixed(1)}" class="tv-grid"/>
      ${lbl ? `<text x="${padX.toFixed(1)}" y="${(gy - 3).toFixed(1)}" class="tv-axis" text-anchor="start">${lbl}</text>` : ''}`;
  }).join('');

  const bars = trend.map((t, i) => {
    const cx = padX + step * i + step / 2;
    const h = t.total > 0 ? Math.max(2, (t.total / max) * innerH) : 1.5;
    const yTop = base - h;
    const cls = t.key === mesKey ? 'tv-bar tv-bar--cur' : 'tv-bar';
    const lbl = t.total > 0
      ? `<text x="${cx.toFixed(1)}" y="${(yTop - 6).toFixed(1)}" class="tv-val" text-anchor="middle">${formatCurrencyShort(t.total)}</text>`
      : '';
    return `${lbl}
      <rect x="${(cx - bw / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" class="${cls}"><title>${escapeHtml(t.label)} ${formatCurrency(t.total)}</title></rect>
      <text x="${cx.toFixed(1)}" y="${(H - 8).toFixed(1)}" class="tv-axis" text-anchor="middle">${escapeHtml(t.label)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="tv-svg" role="img" aria-label="Tendência de despesas variáveis">${grid}${bars}</svg>`;
}

function rankingBlock(ranking, total) {
  if (!ranking.length) return `<div class="empty-state-sm">Sem despesas variáveis neste mês.</div>`;
  const maxCat = Math.max(1, ...ranking.map((r) => r.total));
  return ranking.map((r) => {
    const pct = total > 0 ? (r.total / total) * 100 : 0;
    const w = (r.total / maxCat) * 100;
    return `<div class="rank-row">
      <div class="rank-head">
        <span class="rank-name">${escapeHtml(r.nome)}</span>
        <span class="rank-val">${formatCurrency(r.total)} <small class="muted">${formatPercent(pct)}</small></span>
      </div>
      <div class="rank-track"><div class="rank-fill" style="width:${w.toFixed(1)}%"></div></div>
    </div>`;
  }).join('');
}

// ── Filtros ────────────────────────────────────────────────────────────────────
function filtrosBar(mes) {
  const ws = curWs();
  const cats = categoriasDoWorkspace(ws).filter((c) => isVariavel(c));
  const contas = contasDoWorkspace(ws);
  const fCat = state.filters.despVarCat || '';
  const fConta = state.filters.despVarConta || '';

  // "Empresarial"/"Pessoal" aqui é so um FILTRO LOCAL desta tela (que registros
  // mostrar), nao o ambiente ativo da sessao (o botao "Ambiente" na sidebar) —
  // por isso o rotulo "Nesta tela:" na frente, pra nao parecer o mesmo controle.
  const wsPills = `
    <span class="muted" style="font-size:11px;">Nesta tela:</span>
    <div class="seg" role="tablist" aria-label="Filtrar despesas variáveis por escopo (só nesta tela)">
      <button class="seg-btn ${ws === 'empresarial' ? 'active' : ''}" data-action="despvar-filter-ws" data-param="empresarial">Empresarial</button>
      <button class="seg-btn ${ws === 'pessoal' ? 'active' : ''}" data-action="despvar-filter-ws" data-param="pessoal">Pessoal</button>
    </div>`;

  const catOpts = ['<option value="">Todas as categorias</option>']
    .concat(cats.map((c) => `<option value="${escapeHtml(c.id)}" ${fCat === c.id ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`))
    .join('');
  const contaOpts = ['<option value="">Todas as contas</option>']
    .concat(contas.map((c) => `<option value="${escapeHtml(c.id)}" ${fConta === c.id ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`))
    .join('');

  return `
    <div class="dv-filters">
      ${wsPills}
      <div class="dv-month-nav">
        <button class="btn btn-ghost btn-sm" data-action="despvar-month-prev" title="Mês anterior" aria-label="Mês anterior">‹</button>
        <span class="chip" style="cursor:default;">${escapeHtml(mesLongo(mes))}</span>
        <button class="btn btn-ghost btn-sm" data-action="despvar-month-next" title="Próximo mês" aria-label="Próximo mês">›</button>
      </div>
      <select class="input input-sm" data-action="despvar-filter-cat" aria-label="Filtrar por categoria">${catOpts}</select>
      <select class="input input-sm" data-action="despvar-filter-conta" aria-label="Filtrar por conta">${contaOpts}</select>
    </div>`;
}

// ── View ──────────────────────────────────────────────────────────────────────
export function renderDespesasVariaveisView() {
  const mes = state.filters.despVarMes || (state.filters.despVarMes = defaultMes());
  const ws = curWs();
  ensureDespVar(mes);
  ensureDre(mes || dreDefaultMes());
  const a = state.data.despVar?.[`${ws}:${mes}`];

  const nav = `<button class="btn btn-primary btn-sm" data-action="open-modal-lancamento" data-param="variable">+ Nova despesa variável</button>`;
  const head = pageHeader({
    titulo: 'Despesas variáveis',
    subtitulo: 'Despesas que variam conforme a operação no período selecionado.',
    actions: nav
  });

  if (!a || a.loading) {
    return `<section class="page-section">${head}${filtrosBar(mes)}<div class="card">Carregando despesas variáveis…</div></section>`;
  }
  if (a.erro) {
    return `<section class="page-section">${head}${filtrosBar(mes)}<div class="card text-danger">${escapeHtml(a.erro)}</div></section>`;
  }

  // Estado vazio — só quando NÃO há nenhuma despesa variável no mês selecionado.
  if (a.count === 0) {
    return `<section class="page-section">${head}${filtrosBar(mes)}
      <div class="card dv-empty">
        <div class="dv-empty-ic">▦</div>
        <h3>Nenhuma despesa variável cadastrada para este período.</h3>
        <p class="dv-empty-txt">Cadastre uma despesa variável para incluí-la aqui, no DRE e no fluxo de caixa.</p>
        <button class="btn btn-primary" data-action="open-modal-lancamento" data-param="variable">+ Nova despesa variável</button>
      </div>
    </section>`;
  }

  // % da receita (denominador único = receita líquida do DRE do mês).
  const receitaLiquida = state.data.dreCache?.[mes]?.resumo?.receita_liquida;
  const pctReceita = calcularPercentualReceita(a.total, receitaLiquida);
  const principal = a.ranking[0]?.nome || '—';

  const cards = `
    <div class="kpi-grid">
      ${renderKpiCard({ label: 'Total no período', valor: formatCurrency(a.total), hint: escapeHtml(mesLongo(mes)), kind: 'primary' })}
      ${renderKpiCard({ label: 'Lançamentos', valor: String(a.count), hint: `${ws === 'empresarial' ? 'empresarial' : 'pessoal'}`, kind: 'info' })}
      ${renderKpiCard({ label: 'Principal categoria', valor: escapeHtml(principal), hint: a.ranking[0] ? formatCurrency(a.ranking[0].total) : '—', kind: 'neutral' })}
      ${renderKpiCard({ label: '% da receita', valor: pctReceita == null ? '—' : formatPercent(pctReceita), hint: 'sobre receita líquida', kind: 'info' })}
    </div>`;

  const meio = `
    <div class="dash-grid-2">
      <div class="card">
        <div class="card-header"><h3>Tendência — 6 meses</h3>
          <span class="muted" style="font-size:11.5px;">despesas variáveis por mês</span>
        </div>
        ${trendChart(a.trend, mes)}
      </div>
      <div class="card">
        <div class="card-header"><h3>Por categoria</h3>
          <span class="muted" style="font-size:11.5px;">${a.ranking.length} categoria${a.ranking.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="rank-list">${rankingBlock(a.ranking, a.total)}</div>
      </div>
    </div>`;

  // Tabela com filtros de categoria/conta aplicados (refino da lista).
  const fCat = state.filters.despVarCat || '';
  const fConta = state.filters.despVarConta || '';
  const linhas = a.lista.filter((t) =>
    (!fCat || t.categoria_id === fCat) && (!fConta || t.conta_id === fConta)
  );
  const totalFiltrado = linhas.reduce((s, t) => s + t.valor, 0);
  const filtrando = !!(fCat || fConta);

  const tabela = `
    <div class="card">
      <div class="card-header">
        <h3>Lançamentos — ${escapeHtml(mesLongo(mes))}</h3>
        <span class="muted" style="font-size:12px;">${linhas.length} lançamento${linhas.length !== 1 ? 's' : ''}${filtrando ? ` · ${formatCurrency(totalFiltrado)}` : ''}</span>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr>
            <th>Data</th><th>Descrição</th><th>Categoria</th><th>Conta</th>
            <th style="text-align:right">Valor</th><th>Status</th><th style="text-align:right">Ações</th>
          </tr></thead>
          <tbody>
            ${linhas.length === 0
              ? `<tr><td colspan="7" class="table-empty">Nenhum lançamento para os filtros selecionados.</td></tr>`
              : linhas.map((t) => `
                <tr>
                  <td>${formatDateBR(t.data)}</td>
                  <td>${escapeHtml(t.descricao || '-')}</td>
                  <td>${escapeHtml(t.categoria_nome)}</td>
                  <td>${escapeHtml(t.conta_nome)}</td>
                  <td style="text-align:right" class="text-danger">${formatCurrency(t.valor_original, t.moeda)}</td>
                  <td><span class="badge badge-success">Pago</span></td>
                  <td style="text-align:right; white-space:nowrap">
                    <button class="btn btn-ghost btn-sm" data-action="open-modal-transacao-edit" data-param="${escapeHtml(t.id)}">Editar</button>
                    <button class="btn btn-ghost btn-sm text-danger" data-action="delete-transacao" data-param="${escapeHtml(t.id)}">Excluir</button>
                  </td>
                </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  return `<section class="page-section">
    ${head}
    ${filtrosBar(mes)}
    ${cards}
    ${meio}
    ${tabela}
  </section>`;
}
