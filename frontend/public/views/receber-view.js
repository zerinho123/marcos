// ============================================================================
// views/receber-view.js — FinContaReceber
// ============================================================================

import { state, escapeHtml, formatCurrency, formatCurrencyBase, originalCurrencyHint, formatDateBR, totalReceber } from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader, tableHeader, renderEmptyRow, renderStatusBadge } from './shared.js?v=20260727-finance-v87';

export function renderReceberView() {
  const list = state.data.contasReceber || [];
  const total = totalReceber();

  return `
    <section class="page-section">
      ${pageHeader({
        titulo: 'Contas a receber',
        subtitulo: `${list.length} item(ns) - ${formatCurrency(total)} em aberto`,
        actions: `<button class="btn btn-primary" data-action="open-modal-receber">+ Nova</button>`
      })}

      <div class="card">
        <table class="data-table">
          ${tableHeader(['Cliente', 'Descrição', 'Conta', 'Valor', 'Vencimento', 'Status', ''])}
          <tbody>
            ${list.length === 0 ? renderEmptyRow(7, 'Nada a receber.') : list.map((c) => `
              <tr>
                <td>${escapeHtml(c.devedor_nome)}</td>
                <td>${escapeHtml(c.descricao || '-')}</td>
                <td>${escapeHtml(c.conta_nome || '-')}</td>
                <td>${formatCurrencyBase(c)}${originalCurrencyHint(c) ? `<small class="muted" style="display:block;">orig. ${originalCurrencyHint(c)}</small>` : ''}</td>
                <td>${formatDateBR(c.vencimento)}</td>
                <td>${renderStatusBadge(c.status)}</td>
                <td>
                  <div class="row-actions">
                    ${c.status !== 'pago' ? `<button class="btn btn-sm btn-success" data-action="marcar-recebido" data-param="${escapeHtml(c.id)}">Receber</button>` : ''}
                    <button class="btn btn-sm btn-ghost" data-action="open-modal-receber-edit" data-param="${escapeHtml(c.id)}">Editar</button>
                    ${c.origem === 'crm' ? '' : `<button class="btn-icon" data-action="delete-receber" data-param="${escapeHtml(c.id)}" title="Excluir" aria-label="Excluir">&times;</button>`}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}
