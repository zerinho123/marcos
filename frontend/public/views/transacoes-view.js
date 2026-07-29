// ============================================================================
// views/transacoes-view.js — listagem real de FinTransacao
// ============================================================================

import {
  state, escapeHtml, formatCurrency, formatCurrencyBase, originalCurrencyHint, formatDateBR, transacoesFiltradas
} from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader, tableHeader, renderEmptyRow } from './shared.js?v=20260727-finance-v87';

export function renderTransacoesView() {
  const list = transacoesFiltradas();
  const f = state.filters.transacoes;

  // Recorte por categoria vindo de "Ver lançamentos" (tela Categorias).
  const catId = state.filters.transacoesCategoria;
  const catNome = catId
    ? ((state.data.categorias || []).find((c) => String(c.id) === String(catId))?.nome || 'categoria')
    : null;

  return `
    <section class="page-section">
      ${pageHeader({
        titulo: 'Transações',
        subtitulo: `${state.data.transacoes.length} lançamento(s) carregado(s)`,
        actions: `<button class="btn btn-primary" data-action="open-modal-transacao" data-param="despesa">+ Novo lançamento</button>`
      })}

      ${catNome ? `
        <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;padding:10px 14px;">
          <span>Filtrando por categoria: <strong>${escapeHtml(catNome)}</strong> — ${list.length} lançamento(s).</span>
          <button class="btn btn-ghost btn-sm" data-action="clear-tx-categoria">Limpar filtro</button>
        </div>
      ` : ''}

      <div class="filter-bar">
        <button class="chip ${f === 'todas' ? 'active' : ''}" data-action="filter-tx" data-param="todas">Todas</button>
        <button class="chip ${f === 'receitas' ? 'active' : ''}" data-action="filter-tx" data-param="receitas">Receitas</button>
        <button class="chip ${f === 'despesas' ? 'active' : ''}" data-action="filter-tx" data-param="despesas">Despesas</button>
      </div>

      <div class="card">
        <table class="data-table">
          ${tableHeader(['Data', 'Descrição', 'Categoria', 'Conta', 'Valor', ''])}
          <tbody>
            ${list.length === 0 ? renderEmptyRow(6, 'Nenhuma transação no filtro atual.') : list.map((t) => `
              <tr>
                <td>${formatDateBR(t.data)}</td>
                <td>${escapeHtml(t.descricao || '(sem descrição)')}</td>
                <td>${escapeHtml(t.categoria_nome || '-')}</td>
                <td>${escapeHtml(t.conta_nome || '-')}</td>
                <td class="${t.tipo === 'receita' ? 'text-success' : 'text-danger'}">
                  ${t.tipo === 'receita' ? '+' : '-'} ${formatCurrencyBase(t)}
                  ${originalCurrencyHint(t) ? `<small class="muted" style="display:block;font-weight:400;">orig. ${originalCurrencyHint(t)}</small>` : ''}
                </td>
                <td style="text-align:right; white-space:nowrap">
                  <button class="btn btn-ghost btn-sm" data-action="open-modal-transacao-edit" data-param="${escapeHtml(t.id)}">Editar</button>
                  <button class="btn-icon" data-action="delete-transacao" data-param="${escapeHtml(t.id)}" title="Excluir" aria-label="Excluir">&times;</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}
