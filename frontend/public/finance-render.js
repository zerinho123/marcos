// ============================================================================
// finance-render.js — roteador de views + shell do CF Finance
// ============================================================================

import { state, escapeHtml, NAV_PESSOAL, NAV_EMPRESARIAL, NAV_ADMIN, isHybridUser, canWriteFinance } from './finance-core.js?v=20260727-finance-v87';
import { renderDashboardPessoalModular, renderDashboardEmpresarialModular } from './views/dashboard-modular.js?v=20260727-finance-v87';
import { renderTransacoesView }           from './views/transacoes-view.js?v=20260727-finance-v87';
import { renderContasView }               from './views/contas-view.js?v=20260727-finance-v87';
import { renderCategoriasView }            from './views/categorias-view.js?v=20260727-finance-v87';
import { renderOrcamentoView }            from './views/orcamento-view.js?v=20260727-finance-v87';
import { renderDividasView }              from './views/dividas-view.js?v=20260727-finance-v87';
import { renderMetasView }                from './views/metas-view.js?v=20260727-finance-v87';
import { renderReceberView }              from './views/receber-view.js?v=20260727-finance-v87';
import { renderPagarView }                from './views/pagar-view.js?v=20260727-finance-v87';
import { renderFluxoView }                from './views/fluxo-view.js?v=20260727-finance-v87';
import { renderDREView }                  from './views/dre-view.js?v=20260727-finance-v87';
import { renderDespesasVariaveisView }    from './views/despesas-variaveis-view.js?v=20260727-finance-v87';
import { renderPipelineView }             from './views/pipeline-view.js?v=20260727-finance-v87';
import { renderPendenciasView }           from './views/pendencias-view.js?v=20260727-finance-v87';
import { renderStubView }                 from './views/shared.js?v=20260727-finance-v87';
import { renderModal, renderDialog }      from './views/modal-view.js?v=20260727-finance-v87';
import { renderUsuariosView }             from './views/usuarios-view.js?v=20260727-finance-v87';
import { renderPricingView }              from './views/pricing-view.js?v=20260727-finance-v87';
import { renderLixeiraView }              from './views/lixeira-view.js?v=20260727-finance-v87';
import { renderPainelUsuarios }           from './views/painel-usuarios-view.js?v=20260727-finance-v87';

const ROUTES_PESSOAL = {
  dashboard:  renderDashboardPessoalModular,
  transacoes: renderTransacoesView,
  contas:     renderContasView,
  categorias: renderCategoriasView,
  orcamento:  renderOrcamentoView,
  dividas:    renderDividasView,
  metas:      renderMetasView,
  pendencias: renderPendenciasView,
  usuarios:   renderUsuariosView,
  lixeira:    renderLixeiraView
};

const ROUTES_EMPRESARIAL = {
  dashboard: renderDashboardEmpresarialModular,
  contas:    renderContasView,
  transacoes: renderTransacoesView,  // sem item no menu; acessível via "Ver movimentações"
  categorias: renderCategoriasView,
  receber:   renderReceberView,
  pagar:     renderPagarView,
  fluxo:     renderFluxoView,
  pipeline:  renderPipelineView,
  dre:       renderDREView,
  precificacao: renderPricingView,
  'despesas-variaveis': renderDespesasVariaveisView,
  pendencias: renderPendenciasView,
  usuarios:  renderUsuariosView,
  lixeira:   renderLixeiraView
};

function iconFor(name) {
  const map = {
    'square-grid': '▦', 'arrows-vert': '⇅', 'wallet': '◉',
    'pie': '◐', 'card': '◑', 'flag': '►',
    'chart': '◕', 'trending': '▲', 'down': '↓', 'up': '↑',
    'flow': '↕', 'users': '◔', 'funnel': '◍', 'file': '◌',
    'report': '◗', 'shield': '◖', 'tags': '◆', 'tag-price': '◈', 'trash': '⌫'
  };
  return map[name] || '·';
}

// Nome da empresa ativa (unica, sem seletor): fallback na lista admin quando
// disponivel.
function activeEmpresaNome() {
  const id = state.activeEmpresaId || state.currentUser?.empresa_id || null;
  if (!id) return '';
  const emp = (state.data.empresas || []).find((e) => e.id === id);
  return emp?.nome || '';
}

function renderSidebar() {
  const isEmp = state.workspace === 'empresarial';
  const nav = isEmp ? NAV_EMPRESARIAL : NAV_PESSOAL;
  const initials = (state.currentUser?.nome || 'CF').split(' ').map((w) => w[0]).slice(0, 2).join('');
  const empresaNome = isEmp ? activeEmpresaNome() : '';
  // Configurações (moeda padrão pessoal) só p/ quem tem ambiente pessoal.
  const canOpenSettings = (state.currentUser?.workspaces || 'ambos') !== 'empresarial';

  return `
    <aside class="sidebar">
      <div class="sidebar-logo">
        <div class="sidebar-logo-mark">CF</div>
        <span>CF Finance</span>
      </div>

      <div class="sidebar-section" style="padding:4px 6px;">
        <div class="sidebar-userbox${canOpenSettings ? ' sidebar-userbox-clickable' : ''}"
             ${canOpenSettings ? 'data-action="open-modal-settings" role="button" tabindex="0" title="Configurações da conta"' : ''}>
          <div class="topbar-avatar">${escapeHtml(initials)}</div>
          <div style="display:flex;flex-direction:column;min-width:0;flex:1;">
            <span style="font-size:12.5px;color:var(--t0);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(state.currentUser?.nome || 'Conta')}</span>
            <span style="font-size:10.5px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${isEmp ? escapeHtml(empresaNome || 'Empresarial') : 'Pessoal'}</span>
          </div>
          ${canOpenSettings ? '<span class="sidebar-user-gear" aria-hidden="true">⚙</span>' : ''}
        </div>
      </div>

      ${isHybridUser() ? `
        <div class="sidebar-section">
          <span class="sidebar-section-title">Ambiente</span>
          <button type="button" class="sidebar-ambiente-toggle sidebar-ambiente-toggle-${isEmp ? 'empresarial' : 'pessoal'}"
                  data-action="toggle-workspace"
                  title="Você está no ambiente ${isEmp ? 'Empresarial' : 'Pessoal'}. Clique para alternar.">
            <span class="sidebar-link-icon">⇄</span>
            <span>${isEmp ? 'Empresarial' : 'Pessoal'}</span>
          </button>
        </div>
      ` : ''}

      ${nav.map((group) => `
        <div class="sidebar-section">
          <span class="sidebar-section-title">${escapeHtml(group.section === 'Empresa' && empresaNome ? empresaNome : group.section)}</span>
          ${group.items.map((item) => `
            <a class="sidebar-link ${state.activeNav === item.id ? 'active' : ''}"
               data-action="change-view" data-param="${escapeHtml(item.id)}">
              <span class="sidebar-link-icon">${iconFor(item.icon)}</span>
              <span>${escapeHtml(item.label)}</span>
            </a>
          `).join('')}
        </div>
      `).join('')}

      ${state.currentUser?.role === 'admin' ? `
        <div class="sidebar-section">
          <span class="sidebar-section-title">${escapeHtml(NAV_ADMIN.section)}</span>
          ${NAV_ADMIN.items.map((item) => `
            <a class="sidebar-link" href="${escapeHtml(item.href || './admin.html')}"
               title="Abrir painel administrativo">
              <span class="sidebar-link-icon">${iconFor(item.icon)}</span>
              <span>${escapeHtml(item.label)}</span>
            </a>
          `).join('')}
        </div>
      ` : ''}

      <div style="margin-top:auto;padding-top:12px;border-top:1px solid var(--b1);">
        <a class="sidebar-link" data-action="logout">
          <span class="sidebar-link-icon">&larr;</span><span>Sair</span>
        </a>
      </div>
    </aside>`;
}


function renderDelegadoBanner() {
  const ambiente = state.currentUser?.ambiente;
  if (!ambiente?.owner_id) return '';
  const somenteLeitura = ambiente.permissao !== 'operar';
  return `
    <div class="delegado-banner ${somenteLeitura ? 'is-readonly' : ''}" role="status">
      <span>Você está vendo a conta de <strong>${escapeHtml(ambiente.owner_nome || 'outro usuário')}</strong>${somenteLeitura ? ' (somente leitura)' : ''}.</span>
      <button class="btn btn-ghost btn-sm" data-action="trocar-usuario" data-param="">Voltar para minha conta</button>
    </div>`;
}

function renderTopbar() {
  const isEmp = state.workspace === 'empresarial';
  const empresaNome = isEmp ? activeEmpresaNome() : '';
  return `
    ${renderDelegadoBanner()}
    <header class="topbar">
      <div class="topbar-left">
        <button class="btn btn-ghost btn-sm nav-toggle" data-action="toggle-nav"
                aria-label="Abrir menu" title="Menu">&#9776;</button>
        <span class="page-subtitle" style="margin:0;">${isEmp ? 'Empresarial' + (empresaNome ? ' — ' + escapeHtml(empresaNome) : '') : 'Pessoal'}</span>
      </div>
      <div class="topbar-right" style="display:flex;align-items:center;gap:12px;">
        ${canWriteFinance() ? '' : '<span class="badge badge-warning">Somente leitura</span>'}
        ${state.currentUser?.role === 'admin'
          ? `<a class="btn btn-primary btn-sm" href="./admin.html" title="Abrir painel administrativo" style="text-decoration:none;">Painel administrativo</a>`
          : ''}
        <button class="btn btn-ghost btn-sm" data-action="refresh">Atualizar</button>
      </div>
    </header>`;
}

function renderToasts() {
  return (state.toasts || []).map((t) => `
    <div class="toast toast-${escapeHtml(t.kind || 'info')}">${escapeHtml(t.message)}</div>
  `).join('');
}

export function renderToastLayer() {
  const toastRoot = document.getElementById('toast-root');
  if (toastRoot) toastRoot.innerHTML = renderToasts();
}

export function renderApp() {
  // renderApp substitui a árvore inteira; referências de um drag ativo ficariam órfãs.
  window.__cancelDashDrag?.();
  const root      = document.getElementById('root');
  const modalRoot = document.getElementById('modal-root');
  const toastRoot = document.getElementById('toast-root');
  if (!root) return;

  if (!state.ready) {
    root.innerHTML = `<div class="auth-shell"><span class="loading"></span></div>`;
    return;
  }

  if (!state.currentUser) {
    // Falha de conexão no boot → tela de erro acionável (não spinner infinito).
    if (state.bootError) {
      root.innerHTML = `
        <div class="auth-shell">
          <div class="card" style="max-width:440px;text-align:center;">
            <div style="font-size:30px;line-height:1;color:var(--red);margin-bottom:10px;">⚠</div>
            <h3 style="color:var(--t0);margin-bottom:6px;">Não foi possível conectar ao servidor</h3>
            <p class="muted" style="font-size:12.5px;margin-bottom:14px;">${escapeHtml(state.bootError)}</p>
            <a class="btn btn-primary" href="./app.html">Tentar novamente</a>
          </div>
        </div>`;
      return;
    }
    root.innerHTML = `<div class="auth-shell"><span class="loading"></span></div>`;
    return;
  }

  const routes = state.workspace === 'empresarial' ? ROUTES_EMPRESARIAL : ROUTES_PESSOAL;
  const renderView = routes[state.activeNav] || routes.dashboard;
  const temPainelUsuarios = Boolean(state.currentUser?.delegacoes?.length);
  const userpanelCollapsed = state.userpanelOpen === false;

  root.innerHTML = `
    <div class="app-shell ${temPainelUsuarios ? 'has-userpanel' : ''} ${temPainelUsuarios && userpanelCollapsed ? 'userpanel-collapsed' : ''}">
      ${renderSidebar()}
      <div class="nav-backdrop" data-action="close-nav" aria-hidden="true"></div>
      <div class="app-main">
        ${renderTopbar()}
        <main class="app-content">
          ${renderView(state)}
        </main>
      </div>
      ${temPainelUsuarios ? renderPainelUsuarios() : ''}
      ${temPainelUsuarios ? '<div class="userpanel-backdrop" data-action="toggle-userpanel" aria-hidden="true"></div>' : ''}
    </div>`;

  if (modalRoot) modalRoot.innerHTML = (state.modal ? renderModal(state.modal) : '') + (state.dialog ? renderDialog(state.dialog) : '');
  if (toastRoot) toastRoot.innerHTML = renderToasts();
}

window.__renderApp = renderApp;
window.__renderToasts = renderToastLayer;
