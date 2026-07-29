// ============================================================================
// views/usuarios-view.js — gestão de FinanceUser (admin only)
// ============================================================================

import { state, escapeHtml, formatDateBR } from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader, tableHeader, renderEmptyRow } from './shared.js?v=20260727-finance-v87';

export function renderUsuariosView() {
  if (state.currentUser?.role !== 'admin') {
    return `
      <section class="page-section">
        <div class="card">
          <h3>Sem permissão</h3>
          <p class="muted">Apenas administradores podem gerenciar usuários.</p>
        </div>
      </section>`;
  }

  const list = state.data.financeUsers || [];

  return `
    <section class="page-section">
      ${pageHeader({
        titulo: 'Usuários Finance',
        subtitulo: `${list.length} usuário(s) cadastrado(s)`,
        actions: `
          <button class="btn btn-ghost btn-sm" data-action="refresh-users">Atualizar</button>
          <button class="btn btn-primary" data-action="open-modal-finance-user">+ Novo usuário</button>
        `
      })}

      <div class="card">
        <table class="data-table">
          ${tableHeader(['Usuário', 'Nome', 'Função', 'Último login', ''])}
          <tbody>
            ${list.length === 0 ? renderEmptyRow(5, 'Nenhum usuário cadastrado.') : list.map((u) => `
              <tr>
                <td>${escapeHtml(u.username)}</td>
                <td>${escapeHtml(u.nome)}</td>
                <td><span class="badge badge-${u.role === 'admin' ? 'info' : 'neutral'}">${escapeHtml(u.role)}</span></td>
                <td>${u.last_login_at ? formatDateBR(u.last_login_at) : '-'}</td>
                <td>
                  <button class="btn btn-sm btn-ghost" data-action="open-modal-finance-user" data-param="${escapeHtml(u.id)}">Editar</button>
                  <button class="btn-icon" data-action="delete-finance-user" data-param="${escapeHtml(u.id)}" title="Excluir" aria-label="Excluir">&times;</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}
