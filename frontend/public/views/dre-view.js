// ============================================================================
// views/dre-view.js — DRE como RELATÓRIO (Conta | Valor | % da Receita)
// ----------------------------------------------------------------------------
// O DRE deixou de ser uma planilha editável de 10 colunas. Agora é um relatório
// limpo, somente leitura: três colunas (Conta, Valor, % da Receita) sobre a
// cascata canônica (Receita bruta → Deduções → Receita líquida → CMV →
// Despesas variáveis → Margem de contribuição → Despesas operacionais →
// Resultado operacional → EBITDA → LAIR → Lucro líquido). As linhas de TOTAL
// são calculadas e não editáveis.
//
// A edição (projetado, ajuste manual, mapeamento categoria→linha e fórmulas das
// linhas de total) foi movida para o drawer "Editar dados do DRE" (só admin).
// O backend (FinDreFormula/FinDreMeta/FinDreUserMapa, por escopo de usuário) é o
// mesmo — só mudou a apresentação. Os números usam os mesmos cálculos de
// categorias/lançamentos do relatório (GET /relatorios/dre).
// ============================================================================

import { state, escapeHtml, formatCurrency, formatPercent } from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader, renderKpiCard, renderCurrencyWarning } from './shared.js?v=20260727-finance-v87';
import { calcBreakEven } from './finance-calc.js?v=20260727-finance-v87';
import { api } from '../security-client.js?v=20260727-finance-v87';
import { defaultMes, mesLabel, ensureDre, dreCacheKey } from './dre-shared.js?v=20260727-finance-v87';

// Mapa nome-da-linha-total → chave de seção (p/ botão "adicionar linha" no drawer).
const SECAO_BY_ROW = {
  'RECEITA BRUTA': 'receita_bruta',
  'DEDUÇÕES DA RECEITA BRUTA': 'deducoes',
  'CMV': 'cmv',
  'SERVIÇOS DE TERCEIROS': 'servicos_terceiros',
  'DESPESAS OPERACIONAIS DIRETAS': 'operacionais_diretas',
  'DESPESAS ADMINISTRATIVAS': 'administrativas',
  'DESPESAS COMERCIAIS': 'comerciais',
  'DESPESAS NÃO OPERACIONAIS': 'nao_operacionais',
  'JUROS; EMPRÉSTIMOS; PARCELAMENTO': 'juros_emprestimos'
};

const SECAO_LABEL = {
  receita_bruta: 'Receita bruta', deducoes: 'Deduções', cmv: 'CMV',
  servicos_terceiros: 'Serviços de terceiros', comerciais: 'Comerciais',
  operacionais_diretas: 'Operacionais diretas', administrativas: 'Administrativas',
  nao_operacionais: 'Não operacionais', juros_emprestimos: 'Juros/Empréstimos', ir: 'IR'
};

const num = (v) => Number(v || 0);
const negClass = (v) => (num(v) < 0 ? 'dre-neg' : '');

function monthPicker(mes) {
  const [selectedYear, selectedMonth] = String(mes).split('-').map(Number);
  const year = Number(state.filters.dreCalendarYear || selectedYear || new Date().getFullYear());
  const open = !!state.filters.dreCalendarOpen;
  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  return `
    <div class="dre-month-control ${open ? 'open' : ''}">
      <button class="chip dre-month-trigger" data-action="dre-calendar-toggle" type="button" aria-haspopup="dialog" aria-expanded="${open ? 'true' : 'false'}">
        ${escapeHtml(mesLabel(mes))}
      </button>
      ${open ? `
        <div class="dre-calendar-popover" role="dialog" aria-label="Selecionar mês do DRE">
          <div class="dre-calendar-head">
            <button class="btn btn-ghost btn-sm" data-action="dre-calendar-prev-year" type="button" title="Ano anterior">‹</button>
            <strong>${year}</strong>
            <button class="btn btn-ghost btn-sm" data-action="dre-calendar-next-year" type="button" title="Próximo ano">›</button>
          </div>
          <div class="dre-month-grid">
            ${months.map((label, idx) => {
              const month = idx + 1;
              const value = `${year}-${String(month).padStart(2, '0')}`;
              const active = year === selectedYear && month === selectedMonth;
              return `<button class="dre-month-cell ${active ? 'active' : ''}" data-action="dre-calendar-select" data-param="${value}" type="button">${label}</button>`;
            }).join('')}
          </div>
        </div>` : ''}
    </div>`;
}

// Escopo do DRE no front: só admin escolhe. undefined = DRE pessoal do admin;
// 'template' = template da empresa (default de quem nunca customizou).
export function dreScopeParam() {
  if (state.currentUser?.role !== 'admin') return undefined;
  return state.filters.dreScope === 'template' ? 'template' : undefined;
}

async function ensureDreEstrutura() {
  if (state.data.dreEstrutura && !state.data.dreEstrutura.erro) return;
  state.data.dreEstrutura = { loading: true };
  try {
    state.data.dreEstrutura = await api.dreEstrutura(dreScopeParam());
  } catch (e) {
    state.data.dreEstrutura = { erro: e?.message || 'Falha ao carregar estrutura', linhas: [], categorias: [] };
  }
  if (typeof window.__renderApp === 'function') window.__renderApp();
}

function fmtMetric(v, kind = 'currency') {
  if (v === null || v === undefined || v === '') return '—';
  if (kind === 'percent') return `${formatPercent(num(v))}`;
  if (kind === 'volume') return String(Math.round(num(v))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return formatCurrency(num(v));
}

function rowClass(r, depth = 0) {
  const isTotal   = r.tipo === 'computed';
  const isReceita = r.tipo === 'receita';
  const isItem    = depth > 0;
  return isReceita ? 'dre-row dre-row--receita'
       : isTotal   ? 'dre-row dre-row--total'
       : isItem    ? 'dre-row dre-row--item'
       :             'dre-row dre-row--section';
}

// ----------------------------------------------------------------------------
// RELATÓRIO (somente leitura) — Conta | Valor | % da Receita
// ----------------------------------------------------------------------------
function reportRow(r, depth = 0) {
  const isReceita = r.tipo === 'receita';
  // Em leitura, esconde detalhes zerados e as métricas auxiliares (volume/preço,
  // que já aparecem no resumo e no ponto de equilíbrio).
  const children = (r.itens || []).filter((it) =>
    it.kind !== 'volume' && it.kind !== 'unit' && num(it.real) !== 0
  );
  // Detalhe mostra o realizado-base (lançamentos); total/seção mostra o efetivo.
  const valor = (depth > 0 && r.real_base !== undefined) ? r.real_base : r.real;
  const bucketTag = r.bucket ? ' <span class="dre-bucket-tag">a classificar</span>' : '';
  const head = `
    <div class="${rowClass(r, depth)}" style="--dre-indent:${Math.min(40, depth * 16)}px;">
      <span class="dre-label">${escapeHtml(r.nome)}${bucketTag}</span>
      <span class="dre-num ${negClass(valor)}">${fmtMetric(valor)}</span>
      <span class="dre-av">${isReceita ? '100%' : fmtMetric(r.real_pct, 'percent')}</span>
    </div>`;
  return head + children.map((it) => reportRow(it, depth + 1)).join('');
}

function reportCard(rows) {
  // Leitura: oculta seções zeradas; totais e receita sempre aparecem.
  const visible = rows.filter((r) => r.tipo !== 'section' || num(r.real) !== 0);
  return `
    <div class="card dre-card dre-report" style="--dre-grid:minmax(200px, 1.7fr) 160px 104px;">
      <div class="dre-head">
        <span class="dre-label">Conta</span>
        <span class="dre-num">Valor</span>
        <span class="dre-av">% da Receita</span>
      </div>
      <div class="dre-cascade">
        ${visible.map((r) => reportRow(r, 0)).join('')}
      </div>
    </div>`;
}

// ----------------------------------------------------------------------------
// DRAWER "Editar dados do DRE" (admin) — projetado, ajuste, mapeamento, fórmulas
// ----------------------------------------------------------------------------

// Valor pendente (não salvo) de uma célula editável; null se não houver edição.
function pendingVal(linhaId, field) {
  const cell = state.filters.drePending?.[linhaId];
  if (!cell || cell[field] === undefined) return null;
  return cell[field];
}
function drePendingCount() {
  const p = state.filters.drePending || {};
  return Object.keys(p).reduce((n, k) => n + Object.keys(p[k] || {}).length, 0);
}

// Linha editável (rename + mover + remover) — só para linhas de detalhe.
function lineLabelEdit(r) {
  return `
    <span class="dre-label dre-label--edit">
      <input class="dre-name-input" type="text" value="${escapeHtml(r.nome)}"
             data-action="dre-linha-rename" data-param="${escapeHtml(r.linha_id)}" />
      <span class="dre-line-tools">
        <button class="dre-tool" type="button" title="Subir"   data-action="dre-linha-move" data-param="${escapeHtml(r.linha_id)}|up">↑</button>
        <button class="dre-tool" type="button" title="Descer"  data-action="dre-linha-move" data-param="${escapeHtml(r.linha_id)}|down">↓</button>
        <button class="dre-tool dre-tool--danger" type="button" title="Remover" data-action="dre-linha-del" data-param="${escapeHtml(r.linha_id)}">×</button>
      </span>
    </span>`;
}

function planoInput(r) {
  const pend = pendingVal(r.linha_id, 'plano');
  const val = pend != null ? escapeHtml(pend) : (num(r.plano) ? num(r.plano).toFixed(2) : '');
  return `<input class="dre-meta-input${pend != null ? ' is-dirty' : ''}" type="number" step="0.01"
           inputmode="decimal" placeholder="0,00" value="${val}"
           data-linha="${escapeHtml(r.linha_id)}" data-field="plano" aria-label="Projetado" />`;
}
function ajusteInput(r) {
  const pend = pendingVal(r.linha_id, 'ajuste');
  const val = pend != null ? escapeHtml(pend) : (num(r.ajuste) ? num(r.ajuste).toFixed(2) : '');
  return `<input class="dre-ajuste-input${pend != null ? ' is-dirty' : ''}" type="number" step="0.01"
           inputmode="decimal" placeholder="0,00" value="${val}"
           data-linha="${escapeHtml(r.linha_id)}" data-field="ajuste" aria-label="Ajuste" />`;
}

function addLineRow(secao) {
  return `<button class="dre-addline-btn" type="button" data-action="dre-linha-add" data-param="${escapeHtml(secao)}">
      + adicionar linha em ${escapeHtml(SECAO_LABEL[secao] || secao)}
    </button>`;
}

// Um grupo editável = uma seção com suas linhas de detalhe (projetado + ajuste).
function editGroup(r) {
  const secao = SECAO_BY_ROW[r.nome];
  const items = (r.itens || []).filter((it) => it.linha_id && it.editable !== false);
  if (!secao && !items.length) return '';
  const lines = items.map((it) => `
    <div class="dre-edit-row">
      ${lineLabelEdit(it)}
      ${planoInput(it)}
      ${ajusteInput(it)}
    </div>`).join('');
  const adder = secao ? `<div class="dre-edit-row dre-edit-row--add">${addLineRow(secao)}</div>` : '';
  if (!lines && !adder) return '';
  return `<div class="dre-edit-group">
      <div class="dre-edit-group-title">${escapeHtml(r.nome)}</div>
      ${lines}${adder}
    </div>`;
}

// --- Construtor de fórmula (linhas de total) — prévia local + catálogo de refs ---
// Espelha o avaliador do backend (* / antes de + -; ÷0 → 0). Só p/ a prévia.
function evalFormulaLocal(terms, resolve) {
  if (!Array.isArray(terms) || !terms.length) return 0;
  const v = (t) => (t.ref != null && t.ref !== '' ? Number(resolve(t.ref) || 0) : Number(t.value || 0));
  const nums = [(terms[0].op === '-' ? -1 : 1) * v(terms[0])];
  const ops = [];
  for (let i = 1; i < terms.length; i++) { ops.push(terms[i].op); nums.push(v(terms[i])); }
  const n2 = [nums[0]];
  const o2 = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const n = nums[i + 1];
    if (op === '*') n2[n2.length - 1] *= n;
    else if (op === '/') { const d = n2[n2.length - 1]; n2[n2.length - 1] = n === 0 ? 0 : d / n; }
    else { o2.push(op); n2.push(n); }
  }
  let acc = n2[0];
  for (let i = 0; i < o2.length; i++) acc = o2[i] === '-' ? acc - n2[i + 1] : acc + n2[i + 1];
  return Number.isFinite(acc) ? acc : 0;
}
function refValue(ref) {
  const mes = state.filters.dreMes || defaultMes();
  const dre = state.data.dreCache?.[dreCacheKey(mes, dreScopeParam())];
  const found = (dre?.estrutura || []).find((r) => r.key === ref);
  return found ? Number(found.real || 0) : 0;
}
function formulaRefOptions(selected) {
  const refs = state.data.dreEstrutura?.refs;
  const grp = (label, arr) => `<optgroup label="${escapeHtml(label)}">` +
    arr.map((o) => `<option value="${escapeHtml(o.key)}" ${selected === o.key ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('') + `</optgroup>`;
  let html = `<option value="" ${!selected ? 'selected' : ''}>—</option>`;
  html += `<option value="__num__" ${selected === '__num__' ? 'selected' : ''}>número fixo…</option>`;
  if (refs?.secoes?.length) html += grp('Seções', refs.secoes);
  if (refs?.rows?.length) html += grp('Linhas de total', refs.rows);
  return html;
}
function formulaBuilderPanel() {
  const draft = state.filters.dreFormulaDraft;
  if (!draft) return '';
  const terms = draft.terms || [];
  const opSel = (op, idx) => `<select class="input dre-fb-op" data-action="dre-formula-term-op" data-param="${idx}">` +
    ['+', '-', '*', '/'].map((o) => `<option value="${o}" ${op === o ? 'selected' : ''}>${o}</option>`).join('') + `</select>`;
  const termRows = terms.map((t, i) => {
    const sel = (t.ref != null && t.ref !== '') ? t.ref : (t.value != null && t.value !== '' ? '__num__' : '');
    return `
      <div class="dre-fb-term">
        ${opSel(t.op || '+', i)}
        <select class="input dre-fb-ref" data-action="dre-formula-term-ref" data-param="${i}">${formulaRefOptions(sel)}</select>
        ${sel === '__num__' ? `<input class="input dre-fb-val" type="number" step="0.01" placeholder="0" value="${t.value != null ? escapeHtml(String(t.value)) : ''}" data-action="dre-formula-term-val" data-param="${i}" />` : ''}
        <button class="dre-tool dre-tool--danger" type="button" title="Remover termo" data-action="dre-formula-term-del" data-param="${i}">×</button>
      </div>`;
  }).join('');
  const previewTerms = terms.map((t) => (t.ref === '__num__' || (!t.ref && t.value != null)) ? { op: t.op, value: Number(t.value) || 0 } : t);
  const preview = evalFormulaLocal(previewTerms, refValue);
  return `
    <div class="card dre-fb-panel">
      <div class="card-header">
        <h3>${draft.id ? 'Editar' : 'Nova'} linha de total</h3>
        <span class="muted" style="font-size:11.5px;">monte a fórmula com seções e outras linhas de total — × ÷ antes de + −</span>
      </div>
      <div class="dre-fb-meta">
        <label>Nome <input class="input" value="${escapeHtml(draft.nome || '')}" data-action="dre-formula-name" placeholder="Ex.: MARGEM" /></label>
        <label>Formato
          <select class="input" data-action="dre-formula-format">
            <option value="currency" ${draft.formato !== 'percent' ? 'selected' : ''}>Moeda</option>
            <option value="percent" ${draft.formato === 'percent' ? 'selected' : ''}>% (percentual)</option>
          </select>
        </label>
      </div>
      <div class="dre-fb-terms">${termRows || '<span class="muted">Sem termos — adicione abaixo.</span>'}</div>
      <button class="btn btn-ghost btn-sm" data-action="dre-formula-term-add" type="button">+ termo</button>
      <div class="dre-fb-footer">
        <span class="dre-fb-preview">Prévia (mês atual): <strong>${escapeHtml(formatCurrency(preview))}</strong></span>
        <span>
          <button class="btn btn-ghost btn-sm" data-action="dre-formula-cancel" type="button">Cancelar</button>
          <button class="btn btn-primary btn-sm" data-action="dre-formula-save" type="button">Salvar fórmula</button>
        </span>
      </div>
    </div>`;
}

// Lista das linhas de total (computed) com ferramentas (ƒx / mover / remover).
function totalsAdvanced(rows) {
  const totals = rows.filter((r) => r.tipo === 'computed' && r.id);
  return `
    <details class="dre-drawer-adv">
      <summary>Linhas de total e fórmulas (avançado)</summary>
      <div class="dre-adv-body">
        <button class="btn btn-ghost btn-sm" data-action="dre-formula-new" type="button" title="Criar linha de total com fórmula">＋ Linha de total</button>
        <div class="dre-adv-list">
          ${totals.map((r) => `
            <div class="dre-adv-row">
              <span class="dre-label-text">${escapeHtml(r.nome)}</span>
              <span class="dre-line-tools">
                <button class="dre-tool dre-tool--fx" type="button" title="Editar fórmula" data-action="dre-formula-edit" data-param="${escapeHtml(r.id)}">ƒx</button>
                <button class="dre-tool" type="button" title="Subir"   data-action="dre-formula-move" data-param="${escapeHtml(r.id)}|up">↑</button>
                <button class="dre-tool" type="button" title="Descer"  data-action="dre-formula-move" data-param="${escapeHtml(r.id)}|down">↓</button>
                <button class="dre-tool dre-tool--danger" type="button" title="Remover" data-action="dre-formula-del" data-param="${escapeHtml(r.id)}">×</button>
              </span>
              <span class="dre-num">${fmtMetric(r.real)}</span>
            </div>`).join('')}
        </div>
      </div>
    </details>`;
}

function mappingPanel() {
  const est = state.data.dreEstrutura;
  if (!est || est.loading) return `<div class="dre-drawer-sec"><div class="dre-drawer-sec-head">Mapear categorias</div><p class="muted">Carregando categorias…</p></div>`;
  if (est.erro) return `<div class="dre-drawer-sec"><div class="dre-drawer-sec-head">Mapear categorias</div><p class="text-danger">${escapeHtml(est.erro)}</p></div>`;
  const linhas = est.linhas || [];
  const cats = (est.categorias || []).filter((c) => (c.tipo || 'pessoal') !== 'pessoal');

  const optionsFor = (selectedId) => {
    const bySecao = {};
    for (const l of linhas) (bySecao[l.secao] = bySecao[l.secao] || []).push(l);
    let html = `<option value="">— A classificar —</option>`;
    for (const secao of Object.keys(bySecao)) {
      html += `<optgroup label="${escapeHtml(SECAO_LABEL[secao] || secao)}">`;
      for (const l of bySecao[secao]) {
        const sel = String(selectedId || '') === String(l.id) ? 'selected' : '';
        html += `<option value="${escapeHtml(l.id)}" ${sel}>${escapeHtml(l.nome)}</option>`;
      }
      html += `</optgroup>`;
    }
    return html;
  };

  return `
    <div class="dre-drawer-sec">
      <div class="dre-drawer-sec-head">Mapear categorias → linhas do DRE</div>
      ${cats.length === 0 ? `<p class="muted">Nenhuma categoria empresarial cadastrada.</p>` : `
        <div class="dre-map-grid">
          ${cats.map((c) => `
            <div class="dre-map-row">
              <span class="dre-map-cat">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escapeHtml(c.cor || '#64748b')};margin-right:7px;"></span>
                ${escapeHtml(c.nome)}
              </span>
              <select class="input dre-map-select" data-action="dre-map-save" data-param="${escapeHtml(c.id)}">
                ${optionsFor(c.dre_linha_id)}
              </select>
            </div>`).join('')}
        </div>`}
    </div>`;
}

function editDrawer(dre) {
  if (!(state.currentUser?.role === 'admin' && state.filters.dreEdit)) return '';
  const rows = dre?.estrutura || [];
  const pend = drePendingCount();
  const groups = rows.map((r) => editGroup(r)).filter(Boolean).join('');

  return `
    <div class="dre-drawer-backdrop" data-action="dre-edit-close"></div>
    <aside class="dre-drawer" role="dialog" aria-label="Editar dados do DRE" aria-modal="true">
      <header class="dre-drawer-head">
        <div>
          <h3>Editar dados do DRE</h3>
          <span class="muted">Projetado, ajuste manual e mapeamento. As linhas de total são calculadas. Tudo é salvo só para você (escopo atual).</span>
        </div>
        <button class="dre-tool" type="button" data-action="dre-edit-close" title="Fechar">×</button>
      </header>
      <div class="dre-drawer-body">
        ${formulaBuilderPanel()}
        <div class="dre-drawer-sec">
          <div class="dre-drawer-sec-head">Projetado e ajuste por linha</div>
          <p class="muted" style="font-size:11.5px;margin:0 0 8px;">Ajuste = correção manual sobre o realizado (aceita negativo) e entra só no DRE. Navegue com Enter / setas ↑↓.</p>
          <div class="dre-edit-lines">
            <div class="dre-edit-head"><span>Linha</span><span>Projetado</span><span>Ajuste</span></div>
            ${groups || '<p class="muted">Sem linhas de detalhe.</p>'}
          </div>
        </div>
        ${mappingPanel()}
        ${totalsAdvanced(rows)}
      </div>
      <footer class="dre-drawer-foot">
        <span class="muted">${pend ? `${pend} alteração(ões) não salva(s)` : 'Sem alterações pendentes'}</span>
        <span class="dre-drawer-actions">
          <button class="btn btn-ghost btn-sm" data-action="dre-discard" ${pend ? '' : 'disabled'}>Descartar</button>
          <button class="btn btn-primary btn-sm" data-action="dre-save-batch" ${pend ? '' : 'disabled'}>${pend ? `Salvar (${pend})` : 'Salvar'}</button>
        </span>
      </footer>
    </aside>`;
}

// ----------------------------------------------------------------------------
// Ponto de equilíbrio (mantido) — reconcilia com o resumo do DRE.
// ----------------------------------------------------------------------------
function breakEvenCard(resumo) {
  const be = calcBreakEven(resumo);
  const peReceita = num(resumo.ponto_equilibrio) || be.peReceita || 0;
  const receitaLiquida = num(resumo.receita_liquida);
  const pctSeg = receitaLiquida > 0 && peReceita > 0 ? ((receitaLiquida - peReceita) / receitaLiquida) * 100 : null;

  return `
    <div class="card" style="margin-top:16px;">
      <div class="card-header"><h3>Ponto de equilíbrio</h3>
        <span class="muted" style="font-size:11.5px;">(Despesas fixas + juros) ÷ margem de contribuição</span>
      </div>
      <div class="kpi-grid" style="margin-top:8px;">
        ${renderKpiCard({ label: 'Volume', valor: String(Math.round(num(resumo.volume || 0))), kind: 'neutral' })}
        ${renderKpiCard({ label: 'Preço médio', valor: formatCurrency(resumo.preco_medio), kind: 'info' })}
        ${renderKpiCard({ label: 'Margem contrib. %', valor: formatPercent(num(resumo.margem_contrib_pct)), kind: 'info' })}
        ${renderKpiCard({
          label: 'Faturamento de equilíbrio',
          valor: peReceita > 0 ? formatCurrency(peReceita) : '—',
          hint: peReceita > 0 ? 'base do relatório DRE' : 'margem ≤ 0',
          kind: peReceita > 0 ? 'primary' : 'danger'
        })}
        ${renderKpiCard({
          label: 'Margem de segurança',
          valor: pctSeg == null ? '—' : formatPercent(pctSeg),
          hint: pctSeg == null ? '' : (pctSeg >= 0 ? 'acima do equilíbrio' : 'abaixo do equilíbrio'),
          kind: pctSeg == null ? 'neutral' : (pctSeg >= 0 ? 'success' : 'danger')
        })}
      </div>
      ${peReceita > 0 ? `
        <div style="margin-top:14px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--t2);margin-bottom:6px;">
            <span>Receita líquida: <strong style="color:var(--t0);">${formatCurrency(receitaLiquida)}</strong></span>
            <span>Equilíbrio: ${formatCurrency(peReceita)}</span>
          </div>
          <div class="progress">
            <span class="${receitaLiquida >= peReceita ? '' : 'progress-danger'}"
                  style="width:${Math.max(0, Math.min(100, peReceita > 0 ? (receitaLiquida / peReceita) * 100 : 0)).toFixed(1)}%;"></span>
          </div>
        </div>` : ''}
    </div>`;
}

// Mantidos exportados por compatibilidade com app-hotfix (config de colunas — não
// há mais UI de colunas no relatório, mas o backend e os handlers permanecem).
export function dreColumnsToggle() { return state.data.dreConfig?.config?.columns || []; }
export function dreColumnsMove(key, dir) {
  const order = (state.data.dreConfig?.config?.columns || []).map((c) => ({ key: c.key, visible: c.visible !== false }));
  const i = order.findIndex((it) => it.key === key);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= order.length) return order;
  [order[i], order[j]] = [order[j], order[i]];
  return order;
}

export function renderDREView() {
  const mes = state.filters.dreMes || (state.filters.dreMes = defaultMes());
  const isAdmin  = state.currentUser?.role === 'admin';
  const scope    = dreScopeParam();                 // undefined = pessoal; 'template' = empresa
  ensureDre(mes, scope);
  const dre = state.data.dreCache?.[dreCacheKey(mes, scope)];

  const drawerOpen = isAdmin && !!state.filters.dreEdit;
  if (drawerOpen) ensureDreEstrutura();

  const headerActions = `
    ${isAdmin ? `
      <button class="btn btn-sm btn-ghost" data-action="dre-scope-toggle" title="Alternar entre o seu DRE e o template da empresa">
        ${scope === 'template' ? '🏢 Template' : '👤 Meu DRE'}
      </button>
      <button class="btn btn-sm ${drawerOpen ? 'btn-primary' : 'btn-ghost'}" data-action="dre-edit-toggle" title="Editar projetado, ajuste e mapeamento">
        ✎ Editar dados do DRE
      </button>` : ''}
    <button class="btn btn-ghost btn-sm" data-action="dre-month-prev" title="Mês anterior">‹</button>
    ${monthPicker(mes)}
    <button class="btn btn-ghost btn-sm" data-action="dre-month-next" title="Próximo mês">›</button>`;

  const subtitulo = `Demonstrativo de resultado — ${escapeHtml(mesLabel(mes))}${scope === 'template' ? ' · template da empresa' : ''}`;

  if (!dre || dre.loading) {
    return `<section class="page-section">
      ${pageHeader({ titulo: 'DRE', subtitulo, actions: headerActions })}
      <div class="card">Carregando DRE…</div></section>`;
  }
  if (dre.erro) {
    return `<section class="page-section">
      ${pageHeader({ titulo: 'DRE', subtitulo, actions: headerActions })}
      <div class="card text-danger">DRE: ${escapeHtml(dre.erro)}</div></section>`;
  }

  const rows   = dre.estrutura || [];
  const resumo = dre.resumo || {};
  const lucro  = num(resumo.lucro_liquido);

  return `
    <section class="page-section">
      ${pageHeader({ titulo: 'DRE', subtitulo, actions: headerActions })}
      ${renderCurrencyWarning(dre.moeda_incompleta, dre.moeda_base)}

      <div class="kpi-grid">
        ${renderKpiCard({ label: 'Receita líquida',   valor: formatCurrency(resumo.receita_liquida), kind: 'primary' })}
        ${renderKpiCard({ label: 'Margem contrib.',   valor: formatCurrency(resumo.margem_bruta),    hint: `${escapeHtml(resumo.margem_contrib_pct ?? '0.00')}%`, kind: 'info' })}
        ${renderKpiCard({ label: 'EBITDA',            valor: formatCurrency(resumo.ebtda),           kind: num(resumo.ebtda) >= 0 ? 'success' : 'danger' })}
        ${renderKpiCard({ label: 'Lucro líquido',     valor: formatCurrency(lucro), hint: `${escapeHtml(resumo.margem_pct ?? '0.00')}% margem`, kind: lucro >= 0 ? 'success' : 'danger' })}
      </div>

      ${reportCard(rows)}
      ${breakEvenCard(resumo)}
      ${editDrawer(dre)}
    </section>`;
}
