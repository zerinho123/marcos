// ============================================================================
// views/painel-usuarios-view.js — coluna lateral direita: "Contas que eu
// comando" (delegação de usuários — ver security/ambiente.js no backend).
// ----------------------------------------------------------------------------
// Um gestor pode comandar N contas Pessoais de terceiros sem nunca saber a
// senha delas. Cada linha troca o ambiente ativo pra Pessoal daquele usuário
// (POST /auth/ambiente com usuario_id) — a sessão continua sendo a do gestor,
// só o empresa_id ativo muda (ver backend/security/ambiente.js).
// ============================================================================

import { state, escapeHtml } from '../finance-core.js?v=20260727-finance-v87';

function initials(nome) {
  return String(nome || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

// O conteudo e SEMPRE renderizado por completo — o colapso (so desktop) e
// puramente visual via CSS (.userpanel.is-collapsed), pra nao esvaziar a
// gaveta mobile quando a preferencia de colapso do desktop estiver salva
// (os dois estados sao independentes: um e largura de coluna, o outro e
// visibilidade de gaveta sobreposta — ver design-system.css/ui-foundation.css).
export function renderPainelUsuarios() {
  const delegacoes = state.currentUser?.delegacoes || [];
  if (!delegacoes.length) return '';

  const collapsed = state.userpanelOpen === false;
  const ownerId = state.currentUser?.ambiente?.owner_id || null;
  const vendoPropia = !ownerId;

  return `
    <aside class="userpanel ${collapsed ? 'is-collapsed' : ''}">
      <div class="userpanel-header">
        <span class="userpanel-title">Contas que eu comando</span>
        <button class="btn-icon" type="button" data-action="toggle-userpanel" title="${collapsed ? 'Expandir' : 'Recolher'}" aria-label="${collapsed ? 'Expandir painel' : 'Recolher painel'}">
          ${collapsed ? '‹' : '›'}
        </button>
      </div>
      <div class="userpanel-list">
        <button class="userpanel-item ${vendoPropia ? 'is-active' : ''}" type="button"
                data-action="trocar-usuario" data-param=""
                ${vendoPropia ? 'aria-current="true"' : ''}>
          <span class="userpanel-avatar">${escapeHtml(initials(state.currentUser?.nome))}</span>
          <span class="userpanel-info">
            <strong>Minha conta</strong>
            <small>${escapeHtml(state.currentUser?.nome || '')}</small>
          </span>
        </button>
        ${delegacoes.map((d) => {
          const active = String(ownerId) === String(d.usuario_id);
          const nome = d.nome || d.username;
          return `
            <button class="userpanel-item ${active ? 'is-active' : ''}" type="button"
                    data-action="trocar-usuario" data-param="${escapeHtml(d.usuario_id)}"
                    ${active ? 'aria-current="true"' : ''}>
              <span class="userpanel-avatar">${escapeHtml(initials(nome))}</span>
              <span class="userpanel-info">
                <strong>${escapeHtml(nome)}</strong>
                <small class="badge ${d.permissao === 'operar' ? 'badge-info' : 'badge-neutral'}">${d.permissao === 'operar' ? 'Operar' : 'Visualizar'}</small>
              </span>
            </button>`;
        }).join('')}
      </div>
    </aside>`;
}

