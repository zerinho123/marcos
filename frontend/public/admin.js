import { apiFetch, me, logout } from './security-client.js?v=20260727-finance-v87';
// esc/money reaproveitam os formatadores compartilhados de finance-core.js
// (mesma UI usada pelo app) em vez de reimplementar localmente.
import { MOEDAS, escapeHtml as esc, formatCurrency as money } from './finance-core.js?v=20260727-finance-v87';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const moedaOptions = () => MOEDAS.map((item) => [item.code, `${item.code} · ${item.nome}`]);

function moedaChip(code = 'BRL') {
  const normalizedCode = String(code || 'BRL').toUpperCase();
  const moeda = MOEDAS.find((item) => item.code === normalizedCode) || MOEDAS[0];
  return `<span class="badge badge-info" title="${esc(moeda.nome)}">${esc(moeda.code)}</span>`;
}

const dateBR = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('pt-BR');
};

const normalizeText = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .trim();

const qs = (params = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : '';
};

const adminApi = {
  empresas: () => apiFetch('/api/finance/empresas'),
  postEmpresa: (body) => apiFetch('/api/finance/empresas', { method: 'POST', body }),
  putEmpresa: (id, body) => apiFetch(`/api/finance/empresas/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  deleteEmpresa: (id) => apiFetch(`/api/finance/empresas/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  users: () => apiFetch('/api/finance/users'),
  postUser: (body) => apiFetch('/api/finance/users', { method: 'POST', body }),
  putUser: (id, body) => apiFetch(`/api/finance/users/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  resetSenha: (id, body) => apiFetch(`/api/finance/users/${encodeURIComponent(id)}/password`, { method: 'PATCH', body }),
  aprovarUser: (id, body) => apiFetch(`/api/finance/users/${encodeURIComponent(id)}/aprovacao`, { method: 'POST', body }),
  marcarPagamento: (id, body) => apiFetch(`/api/finance/users/${encodeURIComponent(id)}/pagamento`, { method: 'PATCH', body }),
  deleteUser: (id) => apiFetch(`/api/finance/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  restoreUser: (id) => apiFetch(`/api/finance/users/${encodeURIComponent(id)}/restore`, { method: 'POST' }),

  contas: (params) => apiFetch('/api/finance/contas-bancarias' + qs(params)),
  postConta: (body) => apiFetch('/api/finance/contas-bancarias', { method: 'POST', body }),
  putConta: (id, body) => apiFetch(`/api/finance/contas-bancarias/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  deleteConta: (id) => apiFetch(`/api/finance/contas-bancarias/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  categorias: (params) => apiFetch('/api/finance/categorias' + qs(params)),
  postCategoria: (body) => apiFetch('/api/finance/categorias', { method: 'POST', body }),
  putCategoria: (id, body) => apiFetch(`/api/finance/categorias/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  deleteCategoria: (id) => apiFetch(`/api/finance/categorias/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  lixeiraGlobal: (params) => apiFetch('/api/finance/lixeira/global' + qs(params)),
  restaurarLixeira: (id) => apiFetch(`/api/finance/lixeira/${encodeURIComponent(id)}/restaurar`, { method: 'POST', body: {} }),
  purgarLixeira: (id) => apiFetch(`/api/finance/lixeira/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  delegacoes: () => apiFetch('/api/finance/delegacoes'),
  postDelegacao: (body) => apiFetch('/api/finance/delegacoes', { method: 'POST', body }),
  putDelegacao: (id, body) => apiFetch(`/api/finance/delegacoes/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteDelegacao: (id) => apiFetch(`/api/finance/delegacoes/${encodeURIComponent(id)}`, { method: 'DELETE' })
};

const VIEW_META = {
  overview: { label: 'Visão geral', icon: icon('grid') },
  verificacao: { label: 'Verificação de cadastros', icon: icon('clipboard') },
  empresas: { label: 'Empresas', icon: icon('building') },
  usuarios: { label: 'Usuários', icon: icon('users') },
  contas: { label: 'Contas bancárias', icon: icon('wallet') },
  categorias: { label: 'Categorias', icon: icon('tags') },
  // Exclusivas do dono do sistema — filtradas em renderShell/renderMain.
  lixeira: { label: 'Lixeira', icon: icon('trash') },
  delegacoes: { label: 'Delegações', icon: icon('link') }
};

// Views que só o dono do sistema enxerga (o admin comum nem sabe que existem).
const OWNER_ONLY_VIEWS = new Set(['lixeira', 'delegacoes']);

const state = {
  user: null,
  view: 'overview',
  loading: false,
  error: '',
  data: { empresas: [], usuarios: [], contas: [], categorias: [], lixeira: [], delegacoes: [] },
  filters: {
    empresas: { q: '', sort: 'nome', dir: 'asc', page: 1 },
    verificacao: { q: '', sort: 'createdAt', dir: 'desc', page: 1 },
    usuarios: { q: '', role: '', access: '', status: '', empresa: '', sort: 'username', dir: 'asc', page: 1 },
    contas: { q: '', status: '', contexto: '', sort: 'nome', dir: 'asc', page: 1 },
    categorias: { q: '', status: '', contexto: '', sort: 'nome', dir: 'asc', page: 1 }
  },
  menuOpen: false,
  modal: null,
  busy: false,
  requestSeq: 0,
  verifSelection: new Set() // ids selecionados na Verificação (aprovação em massa)
};

const PAGE_SIZE = 10;
const TIPOS_CONTA = ['corrente', 'poupanca', 'carteira', 'investimento', 'outro'];
const TIPOS_CATEGORIA = ['pessoal', 'empresarial'];
const NATUREZAS = ['', 'receita', 'despesa'];
const DRE_SECOES = [
  '', 'receita_bruta', 'deducoes', 'cmv', 'servicos_terceiros',
  'comerciais', 'operacionais_diretas', 'administrativas',
  'nao_operacionais', 'juros_emprestimos', 'ir'
];
const LIXEIRA_ENTIDADE_LABELS = {
  transacao: 'Lançamento', categoria: 'Categoria', categoria_pessoal: 'Categoria',
  conta_bancaria: 'Conta bancária', orcamento: 'Orçamento', divida: 'Dívida',
  meta: 'Meta', investimento: 'Investimento', aporte: 'Aporte',
  conta_pagar: 'Conta a pagar', conta_receber: 'Conta a receber',
  empresa: 'Empresa', usuario: 'Usuário', vinculo_empresa: 'Vínculo de empresa',
  delegacao: 'Delegação'
};

boot();

async function boot() {
  try {
    const user = await me();
    if (!user) {
      window.location.replace('./login.html');
      return;
    }
    if (user.role !== 'admin') {
      renderDenied();
      return;
    }
    state.user = user;
    renderShell();
    await loadAll();
  } catch (_err) {
    window.location.replace('./login.html');
  }
}

function renderDenied() {
  $('#admin-root').innerHTML = `
    <main class="admin-denied">
      <section class="admin-denied-panel">
        <p class="admin-kicker">Acesso restrito</p>
        <h1>Painel administrativo</h1>
        <p>Este painel é exclusivo para administradores.</p>
        <button class="btn" id="back-app">Voltar ao app</button>
      </section>
    </main>`;
  $('#back-app').addEventListener('click', () => window.location.replace('./app.html'));
}

function renderShell() {
  const nav = Object.entries(VIEW_META)
    .filter(([key]) => !OWNER_ONLY_VIEWS.has(key) || state.user?.is_owner)
    .map(([key, item]) => `
      <button class="admin-nav-item" type="button" data-view="${key}" aria-current="${state.view === key ? 'page' : 'false'}">
        ${item.icon}<span>${item.label}</span>
      </button>
    `).join('');

  $('#admin-root').innerHTML = `
    <div class="admin-shell ${state.menuOpen ? 'is-menu-open' : ''}">
      <header class="admin-topbar">
        <button class="admin-icon-btn admin-menu-btn" type="button" data-action="toggle-menu" aria-label="Abrir menu">${icon('menu')}</button>
        <a class="admin-brand" href="./admin.html" aria-label="CF Finance Admin">
          <span class="admin-brand-mark">CF</span>
          <span>Finance</span>
        </a>
        <span class="admin-admin-badge">ADMIN</span>
        <span class="admin-top-spacer"></span>
        <span class="admin-user-name">${esc(state.user?.nome || state.user?.username || 'Admin')}</span>
        <button class="btn btn-ghost" type="button" data-action="open-app">Abrir app</button>
        <button class="btn" type="button" data-action="logout">Sair</button>
      </header>
      <div class="admin-backdrop" data-action="close-menu"></div>
      <div class="admin-layout">
        <aside class="admin-sidebar" aria-label="Navegação administrativa">
          <nav>${nav}</nav>
          <button class="admin-refresh" type="button" data-action="refresh">${icon('refresh')}<span>Atualizar dados</span></button>
        </aside>
        <main class="admin-main" id="adm-main" tabindex="-1"></main>
      </div>
    </div>`;

  bindShellEvents();
}

function bindShellEvents() {
  const root = $('#admin-root');
  root.onclick = onRootClick;
  root.oninput = onRootInput;
  root.onchange = onRootChange;
}

function onRootClick(event) {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'toggle-menu') {
    state.menuOpen = !state.menuOpen;
    renderShell();
    renderMain();
    return;
  }
  if (action === 'close-menu') {
    state.menuOpen = false;
    renderShell();
    renderMain();
    return;
  }
  if (action === 'open-app') {
    window.location.replace('./app.html');
    return;
  }
  if (action === 'logout') {
    logout();
    return;
  }
  if (action === 'refresh') {
    loadAll(true);
    return;
  }
  if (action === 'verif-aprovar-sel') { bulkDecideUsers('aprovar'); return; }
  if (action === 'verif-rejeitar-sel') { bulkDecideUsers('rejeitar'); return; }

  const nav = event.target.closest('[data-view]');
  if (nav) {
    const target = nav.dataset.view;
    if (OWNER_ONLY_VIEWS.has(target) && !state.user?.is_owner) return;
    state.view = target;
    state.menuOpen = false;
    renderShell();
    renderMain();
    $('#adm-main')?.focus({ preventScroll: true });
    if (state.view === 'lixeira') loadLixeiraAdmin();
    if (state.view === 'delegacoes') loadDelegacoesAdmin();
    return;
  }

  const sort = event.target.closest('[data-sort]');
  if (sort) {
    setSort(state.view, sort.dataset.sort);
    renderMain();
    return;
  }

  const pageBtn = event.target.closest('[data-page]');
  if (pageBtn) {
    state.filters[state.view].page = Number(pageBtn.dataset.page);
    renderMain();
    return;
  }

  const rowAction = event.target.closest('[data-row-action]');
  if (rowAction) handleRowAction(rowAction.dataset.rowAction, rowAction.dataset.id);
}

function onRootInput(event) {
  const control = event.target.closest('[data-filter]');
  if (!control) return;
  applyFilter(control);
}

function onRootChange(event) {
  const sel = event.target.closest('[data-verif-select]');
  if (sel) {
    const id = String(sel.dataset.verifSelect);
    if (sel.checked) state.verifSelection.add(id); else state.verifSelection.delete(id);
    renderMain();
    return;
  }
  const selAll = event.target.closest('[data-verif-select-all]');
  if (selAll) {
    const pendentes = state.data.usuarios.filter((u) => !isUserArchived(u) && (u.status || 'aprovado') === 'pendente');
    const f = state.filters.verificacao;
    const list = filterRows(pendentes, f.q, ['username', 'nome', 'email', 'empresa_solicitada', 'documento', 'telefone']);
    const rows = paginate(sortRows(list, f), f);
    rows.items.forEach((u) => { if (selAll.checked) state.verifSelection.add(String(u.id)); else state.verifSelection.delete(String(u.id)); });
    renderMain();
    return;
  }
  const control = event.target.closest('[data-filter]');
  if (!control) return;
  applyFilter(control);
}

function applyFilter(control) {
  const [view, key] = control.dataset.filter.split('.');
  state.filters[view][key] = control.value;
  state.filters[view].page = 1;
  renderMain();
  const nextControl = $(`[data-filter="${view}.${key}"]`);
  nextControl?.focus({ preventScroll: true });
  if (nextControl?.type === 'search') {
    const end = nextControl.value.length;
    nextControl.setSelectionRange(end, end);
  }
}

async function loadAll(force = false) {
  const seq = ++state.requestSeq;
  state.loading = true;
  state.error = '';
  renderMain();

  try {
    const [empresas, usuarios, contas, categorias, delegacoes] = await Promise.all([
      adminApi.empresas(),
      adminApi.users(),
      adminApi.contas({ incluir_inativas: 1 }),
      adminApi.categorias(),
      // So o dono enxerga /delegacoes (403 pra admin comum) — carrega aqui pra
      // alimentar o campo de delegacao dentro de "Editar usuario", sem depender
      // do usuario visitar a aba Delegacoes primeiro.
      state.user?.is_owner ? adminApi.delegacoes() : Promise.resolve([])
    ]);
    if (seq !== state.requestSeq) return;
    state.data.empresas = Array.isArray(empresas) ? empresas : [];
    state.data.usuarios = Array.isArray(usuarios) ? usuarios : [];
    state.data.contas = Array.isArray(contas) ? contas : [];
    state.data.categorias = Array.isArray(categorias) ? categorias : [];
    state.data.delegacoes = Array.isArray(delegacoes) ? delegacoes : [];
    state.loading = false;
    renderMain();
    if (force) toast('Dados atualizados.');
  } catch (error) {
    if (seq !== state.requestSeq) return;
    state.loading = false;
    state.error = error?.message || 'Falha ao carregar dados.';
    renderMain();
  }
}

function renderMain() {
  const main = $('#adm-main');
  if (!main) return;
  syncNavState();

  if (state.loading) {
    main.innerHTML = renderState('loading', 'Carregando dados administrativos...');
    return;
  }
  if (state.error) {
    main.innerHTML = renderState('error', state.error, '<button class="btn btn-primary" type="button" data-action="refresh">Tentar novamente</button>');
    return;
  }

  if (state.view === 'overview') main.innerHTML = renderOverview();
  if (state.view === 'verificacao') main.innerHTML = renderVerificacao();
  if (state.view === 'empresas') main.innerHTML = renderEmpresas();
  if (state.view === 'usuarios') main.innerHTML = renderUsuarios();
  if (state.view === 'contas') main.innerHTML = renderContas();
  if (state.view === 'categorias') main.innerHTML = renderCategorias();
  if (state.view === 'lixeira') main.innerHTML = renderLixeiraAdmin();
  if (state.view === 'delegacoes') main.innerHTML = renderDelegacoesAdmin();
}

function syncNavState() {
  $$('.admin-nav-item').forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

function renderOverview() {
  const empresas = state.data.empresas;
  const usuarios = state.data.usuarios;
  const activeUsers = usuarios.filter((u) => !isUserArchived(u));
  const contas = state.data.contas;
  const categorias = state.data.categorias;
  const admins = activeUsers.filter((u) => u.role === 'admin');
  const lockedUsers = activeUsers.filter(isUserLocked);

  return `
    ${pageHeader('Visão geral', 'Indicadores calculados a partir das APIs administrativas reais.', `
      <button class="btn btn-ghost" type="button" data-action="refresh">${icon('refresh')}Atualizar</button>
    `)}
    <section class="admin-kpi-grid" aria-label="Indicadores">
      ${kpi('Empresas', empresas.length, 'Cadastros normais')}
      ${kpi('Usuários', activeUsers.length, 'Contas ativas no financeiro')}
      ${kpi('Administradores', admins.length, 'Role admin')}
      ${kpi('Usuários ativos', Math.max(activeUsers.length - lockedUsers.length, 0), 'Não bloqueados')}
      ${kpi('Aguardando aprovação', activeUsers.filter((u) => (u.status || 'aprovado') === 'pendente').length, 'Auto-cadastros pendentes')}
      ${kpi('Pagamento pendente', activeUsers.filter((u) => (u.status || 'aprovado') === 'pendente' && (u.pagamento_status || 'pendente') === 'pendente').length, 'Pendentes sem pagamento confirmado')}
      ${kpi('Contas bancárias', contas.length, 'Total no sistema')}
      ${kpi('Categorias', categorias.length, 'Total no sistema')}
    </section>
    <section class="admin-grid-two">
      <article class="card">
        <div class="admin-panel-head">
          <h2>Usuários recentes</h2>
          <button class="admin-link-btn" type="button" data-view="usuarios">Ver usuários</button>
        </div>
        ${miniList(usuarios.slice(0, 5), (u) => `
          <div>
            <strong>${esc(u.nome || u.username)}</strong>
            <span>${esc(u.email || u.username)}</span>
          </div>
          ${rolePill(u)}
        `, 'Nenhum usuário cadastrado.')}
      </article>
      <article class="card">
        <div class="admin-panel-head">
          <h2>Empresas cadastradas</h2>
          <button class="admin-link-btn" type="button" data-view="empresas">Ver empresas</button>
        </div>
        ${miniList(empresas.slice(0, 5), (e) => `
          <div>
            <strong>${esc(e.nome)}</strong>
            <span>${esc(e.email || e.cnpj || '-')}</span>
          </div>
          <span class="badge badge-success">normal</span>
        `, 'Nenhuma empresa cadastrada.')}
      </article>
    </section>`;
}

function renderEmpresas() {
  const f = state.filters.empresas;
  const rows = paginate(sortRows(filterRows(state.data.empresas, f.q, ['nome', 'cnpj', 'email', 'telefone', 'moeda_base']), f), f);
  return `
    ${pageHeader('Empresas', 'Cadastro de empresas normais do CF Finance.', `
      <button class="btn btn-primary" type="button" data-row-action="new-empresa">Nova empresa</button>
    `)}
    <section class="admin-toolbar">
      ${inputFilter('empresas.q', 'Buscar por nome, documento ou e-mail', f.q)}
      ${selectFilter('empresas.sort', f.sort, [['nome', 'Nome'], ['createdAt', 'Cadastro']])}
    </section>
    <section class="card">
      ${table({
        columns: [['nome', 'Empresa'], ['cnpj', 'Documento'], ['email', 'E-mail'], ['telefone', 'Telefone'], ['moeda_base', 'Moeda-base'], ['createdAt', 'Cadastro'], ['actions', '']],
        rows: rows.items,
        empty: 'Nenhuma empresa encontrada.',
        render: (e) => [
          `<strong>${esc(e.nome)}</strong>`,
          esc(e.cnpj || '-'),
          esc(e.email || '-'),
          esc(e.telefone || '-'),
          moedaChip(e.moeda_base),
          dateBR(e.createdAt),
          actions([
            ['edit-empresa', e.id, 'Editar'],
            ['delete-empresa', e.id, 'Excluir', 'danger']
          ])
        ],
        sort: f.sort
      })}
      ${pagination(rows, 'empresas')}
    </section>`;
}

function renderUsuarios() {
  const f = state.filters.usuarios;
  let list = filterRows(state.data.usuarios, f.q, [
    'username', 'nome', 'email', 'role', 'telefone', 'documento',
    'empresa_solicitada', 'plano', 'pagamento_status', 'moeda_pessoal'
  ]);
  if (f.role) list = list.filter((u) => u.role === f.role);
  if (f.access) list = list.filter((u) => (u.role === 'admin' ? 'operacao' : (u.access_level || 'operacao')) === f.access);
  if (f.status === 'arquivado') list = list.filter(isUserArchived);
  else if (f.status === 'pendente' || f.status === 'rejeitado') list = list.filter((u) => !isUserArchived(u) && (u.status || 'aprovado') === f.status);
  else if (f.status === 'bloqueado') list = list.filter((u) => !isUserArchived(u) && isUserLocked(u));
  else if (f.status === 'ativo') list = list.filter((u) => !isUserArchived(u) && (u.status || 'aprovado') === 'aprovado' && !isUserLocked(u));
  if (f.empresa) list = list.filter((u) => (u.empresa_ids || []).includes(f.empresa) || u.empresa_id === f.empresa);
  const rows = paginate(sortRows(list, f), f);

  return `
    ${pageHeader('Usuários', 'Contas, permissões e vínculos empresariais.', `
      <button class="btn btn-primary" type="button" data-row-action="new-user">Novo usuário</button>
    `)}
    <section class="admin-toolbar admin-toolbar-wide">
      ${inputFilter('usuarios.q', 'Buscar usuário, nome ou e-mail', f.q)}
      ${selectFilter('usuarios.role', f.role, [['', 'Todas as funções'], ['admin', 'Administradores'], ['usuario', 'Usuários']])}
      ${selectFilter('usuarios.access', f.access, [['', 'Todas as permissões'], ['operacao', 'Pode alterar'], ['consulta', 'Somente leitura']])}
      ${selectFilter('usuarios.status', f.status, [['', 'Todos os status'], ['ativo', 'Ativos'], ['bloqueado', 'Bloqueados'], ['pendente', 'Aguardando aprovação'], ['rejeitado', 'Rejeitados'], ['arquivado', 'Arquivados']])}
      ${selectFilter('usuarios.empresa', f.empresa, [['', 'Todas as empresas'], ...state.data.empresas.map((e) => [e.id, e.nome])])}
    </section>
    <section class="card">
      ${table({
        columns: [['username', 'Usuário'], ['role', 'Função'], ['access_level', 'Permissão'], ['empresas', 'Acesso'], ['pagamento_status', 'Pagamento'], ['status', 'Status'], ['last_login_at', 'Último login'], ['actions', '']],
        rows: rows.items,
        empty: 'Nenhum usuário encontrado.',
        render: (u) => [
          `<div class="admin-id-cell"><strong>${esc(u.username)}</strong>${[u.nome, u.email].some(Boolean) ? `<small>${esc([u.nome, u.email].filter(Boolean).join(' · '))}</small>` : ''}</div>`,
          rolePill(u),
          accessLevelPill(u),
          accessChips(u),
          pagamentoChip(u.pagamento_status),
          userStatusChip(u),
          dateBR(u.last_login_at),
          actions(isUserArchived(u)
            ? [
                ['edit-user', u.id, 'Editar'],
                ['restore-user', u.id, 'Restaurar']
              ]
            : (u.status || 'aprovado') === 'pendente'
            ? [
                ['edit-user', u.id, 'Editar'],
                ['review-user', u.id, 'Revisar'],
                ['approve-user', u.id, 'Aprovar'],
                ['reject-user', u.id, 'Rejeitar', 'danger'],
                ['delete-user', u.id, 'Arquivar', 'danger']
              ]
            : [
                ['edit-user', u.id, 'Editar'],
                ['password-user', u.id, 'Senha'],
                ...(u.id === state.user.id ? [] : [['delete-user', u.id, 'Arquivar', 'danger']])
              ])
        ],
        sort: f.sort
      })}
      ${pagination(rows, 'usuarios')}
    </section>`;
}

function pagamentoChip(status) {
  const s = status || 'pendente';
  if (s === 'pago') return '<span class="badge badge-success">pago</span>';
  if (s === 'isento') return '<span class="badge badge-info">isento</span>';
  return '<span class="badge badge-warning">pendente</span>';
}

function renderVerificacao() {
  const f = state.filters.verificacao;
  const pendentes = state.data.usuarios.filter((u) => !isUserArchived(u) && (u.status || 'aprovado') === 'pendente');
  const list = filterRows(pendentes, f.q, ['username', 'nome', 'email', 'empresa_solicitada', 'documento', 'telefone']);
  const rows = paginate(sortRows(list, f), f);

  // Só mantém na seleção ids ainda pendentes/visíveis nesta página (evita agir
  // sobre quem saiu da lista desde a última interação).
  const idsPagina = new Set(rows.items.map((u) => String(u.id)));
  const sel = state.verifSelection;
  [...sel].forEach((id) => { if (!idsPagina.has(String(id))) sel.delete(id); });
  const n = sel.size;
  const todosMarcados = rows.items.length > 0 && rows.items.every((u) => sel.has(String(u.id)));

  return `
    ${pageHeader('Verificação de cadastros', 'Solicitações aguardando aprovação — confira os dados e o pagamento antes de liberar o acesso.', '')}
    <section class="admin-toolbar admin-toolbar-wide">
      ${inputFilter('verificacao.q', 'Buscar por nome, e-mail, empresa ou documento', f.q)}
      <div class="admin-bulk">
        <label class="admin-bulk-all"><input type="checkbox" data-verif-select-all ${todosMarcados ? 'checked' : ''} ${rows.items.length ? '' : 'disabled'}> Selecionar todos</label>
        <button class="btn btn-primary" type="button" data-action="verif-aprovar-sel" ${n ? '' : 'disabled'}>Aprovar selecionados${n ? ` (${n})` : ''}</button>
        <button class="btn btn-danger" type="button" data-action="verif-rejeitar-sel" ${n ? '' : 'disabled'}>Rejeitar selecionados${n ? ` (${n})` : ''}</button>
      </div>
    </section>
    <section class="card">
      ${table({
        columns: [['nome', 'Solicitante'], ['empresa_solicitada', 'Empresa'], ['plano', 'Plano'], ['pagamento_status', 'Pagamento'], ['createdAt', 'Recebido em'], ['actions', '']],
        rows: rows.items,
        empty: 'Nenhuma solicitação pendente. Tudo em dia.',
        render: (u) => [
          `<label class="admin-row-check"><input type="checkbox" data-verif-select="${esc(u.id)}" ${sel.has(String(u.id)) ? 'checked' : ''} aria-label="Selecionar ${esc(u.nome || u.username)}"></label>
           <span><strong>${esc(u.nome || u.username)}</strong><br><small style="color:var(--admin-muted)">${esc(u.email || '-')}</small></span>`,
          esc(u.empresa_solicitada || '-'),
          esc(u.plano || '-'),
          pagamentoChip(u.pagamento_status),
          dateBR(u.createdAt),
          actions([['review-user', u.id, 'Revisar']])
        ],
        sort: f.sort
      })}
      ${pagination(rows, 'verificacao')}
    </section>`;
}

// Modal de revisao de uma solicitacao pendente. Modal proprio (nao openFormModal)
// porque o rodape tem 3 acoes distintas: salvar pagamento, rejeitar, aprovar.
function openReviewModal(user) {
  if (!user) return;
  const root = $('#modal-root');
  const previous = document.activeElement;

  const detail = (label, value) =>
    `<div class="admin-mini-row"><span>${esc(label)}</span><strong>${value}</strong></div>`;

  const body = `
    <div class="admin-mini-list" style="border:1px solid var(--admin-line);border-radius:12px;margin-bottom:18px;">
      ${detail('Nome', esc(user.nome || '-'))}
      ${detail('Usuário', esc(user.username))}
      ${detail('E-mail', esc(user.email || '-'))}
      ${detail('Telefone', esc(user.telefone || '-'))}
      ${detail('CPF / CNPJ', esc(user.documento || '-'))}
      ${detail('Empresa', esc(user.empresa_solicitada || '-'))}
      ${detail('Plano informado', esc(user.plano || '-'))}
      ${detail('Recebido em', dateBR(user.createdAt))}
      ${detail('Pagamento atual', `<span id="review-pag-atual">${pagamentoChip(user.pagamento_status)}</span>`)}
    </div>
    <label class="admin-field">
      <span>Situação de pagamento</span>
      <select name="pagamento_status">
        <option value="pendente" ${(user.pagamento_status || 'pendente') === 'pendente' ? 'selected' : ''}>Pendente</option>
        <option value="pago" ${user.pagamento_status === 'pago' ? 'selected' : ''}>Pago</option>
        <option value="isento" ${user.pagamento_status === 'isento' ? 'selected' : ''}>Isento</option>
      </select>
      <small>Confira o pagamento no extrato e marque aqui. "Salvar pagamento" registra a situação sem aprovar o cadastro.</small>
    </label>`;

  root.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal-card admin-modal-scroll" role="dialog" aria-modal="true" aria-labelledby="admin-review-title" tabindex="-1">
        <header class="modal-header">
          <h2 class="modal-title" id="admin-review-title">Revisar solicitação</h2>
          <button class="btn-icon" type="button" data-review="close" aria-label="Fechar">${icon('x')}</button>
        </header>
        <div class="modal-body">
          ${body}
        </div>
        <footer class="modal-footer">
          <button class="btn btn-ghost" type="button" data-review="save-pagamento">Salvar pagamento</button>
          <button class="btn btn-danger" type="button" data-review="rejeitar">Rejeitar</button>
          <button class="btn btn-primary" type="button" data-review="aprovar">Aprovar</button>
        </footer>
      </section>
    </div>`;

  const close = () => {
    root.innerHTML = '';
    root.onclick = null;
    root.onkeydown = null;
    if (previous && typeof previous.focus === 'function') requestAnimationFrame(() => previous.focus());
  };
  const getStatus = () => $('select[name="pagamento_status"]', root)?.value || 'pendente';

  root.onkeydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  root.onclick = async (event) => {
    if (event.target.classList.contains('modal-backdrop')) { close(); return; }
    const act = event.target.closest('[data-review]')?.dataset.review;
    if (!act) return;
    if (act === 'close') { close(); return; }
    if (act === 'save-pagamento') {
      if (state.busy) return;
      state.busy = true;
      await runAction(async () => {
        const updated = await adminApi.marcarPagamento(user.id, { pagamento_status: getStatus() });
        const idx = state.data.usuarios.findIndex((x) => String(x.id) === String(user.id));
        if (idx >= 0) state.data.usuarios[idx] = updated;
        Object.assign(user, updated);
        const chip = $('#review-pag-atual', root);
        if (chip) chip.innerHTML = pagamentoChip(user.pagamento_status);
        toast('Situação de pagamento salva.');
      });
      state.busy = false;
      return;
    }
    if (act === 'aprovar' || act === 'rejeitar') {
      close();
      await decideUser(user, act);
    }
  };

  $('.modal-card', root)?.focus();
}

function renderContas() {
  const f = state.filters.contas;
  let list = filterRows(state.data.contas, f.q, ['nome', 'tipo', 'escopo', 'moeda']);
  if (f.status) list = list.filter((c) => f.status === 'ativa' ? Boolean(c.ativo) : !c.ativo);
  if (f.contexto) list = list.filter((c) => (c.escopo || 'pessoal') === f.contexto);
  const rows = paginate(sortRows(list, f), f);

  return `
    ${pageHeader('Contas bancárias', 'Contas do ambiente financeiro ativo.', `
      <button class="btn btn-primary" type="button" data-row-action="new-conta">Nova conta</button>
    `)}
    <section class="admin-toolbar">
      ${inputFilter('contas.q', 'Buscar conta ou banco', f.q)}
      ${selectFilter('contas.status', f.status, [['', 'Todos os status'], ['ativa', 'Ativas'], ['inativa', 'Inativas']])}
      ${selectFilter('contas.contexto', f.contexto, [['', 'Todos os contextos'], ['pessoal', 'Pessoal'], ['empresarial', 'Empresarial']])}
    </section>
    <section class="card">
      ${table({
        columns: [['nome', 'Conta'], ['tipo', 'Tipo'], ['escopo', 'Contexto'], ['moeda', 'Moeda'], ['saldo', 'Saldo'], ['status', 'Status'], ['actions', '']],
        rows: rows.items,
        empty: 'Nenhuma conta encontrada.',
        render: (c) => [
          `<strong>${esc(c.nome)}</strong>`,
          esc(c.tipo || '-'),
          contextChip(c.escopo),
          moedaChip(c.moeda),
          money(c.saldo, c.moeda),
          c.ativo ? '<span class="badge badge-success">ativa</span>' : '<span class="badge badge-neutral">inativa</span>',
          actions([
            ['edit-conta', c.id, 'Editar'],
            ...(c.ativo ? [['delete-conta', c.id, 'Desativar', 'danger']] : [])
          ])
        ],
        sort: f.sort
      })}
      ${pagination(rows, 'contas')}
    </section>`;
}

function renderCategorias() {
  const f = state.filters.categorias;
  let list = filterRows(state.data.categorias, f.q, ['nome', 'tipo', 'escopo', 'natureza']);
  if (f.status) list = list.filter((c) => f.status === 'ativa' ? Boolean(c.ativo) : !c.ativo);
  if (f.contexto) list = list.filter((c) => categoryContext(c) === f.contexto);
  const rows = paginate(sortRows(list, f), f);

  return `
    ${pageHeader('Categorias', 'Classificação financeira por contexto.', `
      <button class="btn btn-primary" type="button" data-row-action="new-categoria">Nova categoria</button>
    `)}
    <section class="admin-toolbar">
      ${inputFilter('categorias.q', 'Buscar categoria', f.q)}
      ${selectFilter('categorias.status', f.status, [['', 'Todos os status'], ['ativa', 'Ativas'], ['inativa', 'Inativas']])}
      ${selectFilter('categorias.contexto', f.contexto, [['', 'Todos os contextos'], ['pessoal', 'Pessoal'], ['empresarial', 'Empresarial']])}
    </section>
    <section class="card">
      ${table({
        columns: [['nome', 'Categoria'], ['natureza', 'Natureza'], ['contexto', 'Contexto'], ['dre_secao', 'DRE'], ['uso', 'Uso'], ['status', 'Status'], ['actions', '']],
        rows: rows.items,
        empty: 'Nenhuma categoria encontrada.',
        render: (c) => [
          `<span class="admin-color-dot" style="--dot:${esc(c.cor || '#22d3ee')}"></span><strong>${esc(c.nome)}</strong>`,
          esc(c.natureza || c.tipo || '-'),
          contextChip(categoryContext(c)),
          esc(c.dre_secao_efetiva || c.dre_secao || '-'),
          String(c.lancamentos_count ?? 0),
          c.ativo ? '<span class="badge badge-success">ativa</span>' : '<span class="badge badge-neutral">inativa</span>',
          actions([
            ['edit-categoria', c.id, 'Editar'],
            ['delete-categoria', c.id, 'Excluir', 'danger']
          ])
        ],
        sort: f.sort
      })}
      ${pagination(rows, 'categorias')}
    </section>`;
}

// Exclusiva do dono do sistema — lixeira de TODAS as empresas (ver OWNER_ONLY_VIEWS).
function renderLixeiraAdmin() {
  const list = state.data.lixeira || [];
  return `
    ${pageHeader('Lixeira', 'Tudo que foi excluído em todas as empresas. Restaure ou apague para sempre.', '')}
    <section class="card">
      ${table({
        columns: [['excluido_em', 'Excluído em'], ['entidade', 'Tipo'], ['rotulo', 'Descrição'], ['empresa_nome', 'Empresa'], ['valor', 'Valor'], ['excluido_por_nome', 'Excluído por'], ['actions', '']],
        rows: list,
        empty: 'Lixeira vazia.',
        render: (item) => [
          dateBR(item.excluido_em),
          `<span class="badge badge-neutral">${esc(LIXEIRA_ENTIDADE_LABELS[item.entidade] || item.entidade)}</span>`,
          esc(item.rotulo || '(sem descrição)'),
          esc(item.empresa_nome || '-'),
          item.valor != null ? money(item.valor) : '-',
          esc(item.excluido_por_nome || '-'),
          actions([
            ['restaurar-lixeira-adm', item.id, 'Restaurar'],
            ['purgar-lixeira-adm', item.id, 'Excluir definitivo', 'danger']
          ])
        ]
      })}
    </section>`;
}

// Exclusiva do dono — quem comanda a conta pessoal de quem (FinanceDelegacao).
function renderDelegacoesAdmin() {
  const list = state.data.delegacoes || [];
  return `
    ${pageHeader('Delegações', 'Quem comanda a conta pessoal de quem — concedido exclusivamente pelo dono do sistema.', `
      <button class="btn btn-primary" type="button" data-row-action="new-delegacao">Nova delegação</button>
    `)}
    <section class="card">
      ${table({
        columns: [['gestor', 'Gestor'], ['usuario', 'Conta comandada'], ['permissao', 'Permissão'], ['ativo', 'Status'], ['actions', '']],
        rows: list,
        empty: 'Nenhuma delegação concedida.',
        render: (d) => [
          `<strong>${esc(d.gestor_nome || d.gestor_username)}</strong>`,
          `<strong>${esc(d.usuario_nome || d.usuario_username)}</strong>`,
          `<span class="badge ${d.permissao === 'operar' ? 'badge-info' : 'badge-neutral'}">${esc(d.permissao === 'operar' ? 'Operar' : 'Visualizar')}</span>`,
          d.ativo ? '<span class="badge badge-success">ativa</span>' : '<span class="badge badge-neutral">revogada</span>',
          actions(d.ativo ? [['revoke-delegacao', d.id, 'Revogar', 'danger']] : [])
        ]
      })}
    </section>`;
}

async function loadLixeiraAdmin() {
  try {
    const resp = await adminApi.lixeiraGlobal({ limit: 200 });
    state.data.lixeira = Array.isArray(resp?.itens) ? resp.itens : [];
  } catch (error) {
    state.data.lixeira = [];
    toast(error?.message || 'Falha ao carregar a lixeira.', 'error');
  }
  renderMain();
}

async function loadDelegacoesAdmin() {
  try {
    const rows = await adminApi.delegacoes();
    state.data.delegacoes = Array.isArray(rows) ? rows : [];
  } catch (error) {
    state.data.delegacoes = [];
    toast(error?.message || 'Falha ao carregar delegações.', 'error');
  }
  renderMain();
}

async function restaurarLixeiraAdmin(id) {
  const ok = await openConfirm({
    title: 'Restaurar item?',
    message: 'O item volta a aparecer normalmente, junto com tudo que foi excluído na mesma operação.',
    confirmLabel: 'Restaurar'
  });
  if (!ok) return;
  await runAction(async () => {
    await adminApi.restaurarLixeira(id);
    toast('Item restaurado.');
    await loadLixeiraAdmin();
  });
}

async function purgarLixeiraAdmin(id) {
  const ok = await openConfirm({
    title: 'Excluir definitivamente?',
    message: 'Essa ação apaga o dado da lixeira para sempre. Não é possível desfazer.',
    confirmLabel: 'Excluir para sempre',
    danger: true
  });
  if (!ok) return;
  await runAction(async () => {
    await adminApi.purgarLixeira(id);
    toast('Item excluído definitivamente.');
    await loadLixeiraAdmin();
  });
}

function openDelegacaoModal() {
  const options = state.data.usuarios
    .filter((u) => !u.deleted_at)
    .map((u) => [u.id, `${u.nome || u.username} (${u.username})`]);
  openFormModal({
    title: 'Nova delegação',
    submitLabel: 'Conceder acesso',
    body: `
      ${formSection('Delegação', 'O gestor passa a comandar a conta Pessoal do usuário escolhido, sem nunca saber a senha dele.', `
        <div class="admin-form-grid">
          ${field('gestor_id', 'Gestor (quem vai comandar)', select('gestor_id', '', [['', 'Selecione...'], ...options]))}
          ${field('usuario_id', 'Conta comandada', select('usuario_id', '', [['', 'Selecione...'], ...options]))}
          ${field('permissao', 'Permissão', select('permissao', 'visualizar', [['visualizar', 'Somente visualizar'], ['operar', 'Lançar, editar e excluir']]))}
        </div>
      `)}
    `,
    onSubmit: async (form) => {
      const body = formValues(form);
      if (!body.gestor_id) fieldFail('gestor_id', 'Selecione o gestor.');
      if (!body.usuario_id) fieldFail('usuario_id', 'Selecione a conta comandada.');
      if (body.gestor_id === body.usuario_id) fieldFail('usuario_id', 'Gestor e conta comandada não podem ser a mesma pessoa.');
      await adminApi.postDelegacao(body);
      toast('Delegação concedida.');
      await loadDelegacoesAdmin();
    }
  });
}

async function revokeDelegacao(id) {
  const ok = await openConfirm({
    title: 'Revogar delegação?',
    message: 'O gestor perde o acesso a essa conta imediatamente.',
    confirmLabel: 'Revogar',
    danger: true
  });
  if (!ok) return;
  await runAction(async () => {
    await adminApi.deleteDelegacao(id);
    toast('Delegação revogada.');
    await loadDelegacoesAdmin();
  });
}

function pageHeader(title, subtitle, actionsHtml = '') {
  return `
    <section class="admin-page-head">
      <div>
        <p class="admin-kicker">Painel administrativo</p>
        <h1>${esc(title)}</h1>
        <p>${esc(subtitle)}</p>
      </div>
      <div class="admin-page-actions">${actionsHtml}</div>
    </section>`;
}

function kpi(label, value, hint) {
  return `
    <article class="admin-kpi">
      <span>${esc(label)}</span>
      <strong>${esc(value)}</strong>
      <small>${esc(hint)}</small>
    </article>`;
}

function table({ columns, rows, empty, render, sort }) {
  return `
    <div class="admin-table-wrap">
      <table class="data-table">
        <thead>
          <tr>${columns.map(([key, label]) => `
            <th scope="col">${key === 'actions' ? '' : `<button type="button" data-sort="${key}">${esc(label)}${sort === key ? '<span aria-hidden="true"> •</span>' : ''}</button>`}</th>
          `).join('')}</tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map((row) => {
            const cells = render(row);
            return `<tr>${cells.map((cell, i) => `<td data-label="${esc(columns[i][1])}">${cell}</td>`).join('')}</tr>`;
          }).join('') : `<tr><td class="admin-empty-cell" colspan="${columns.length}">${esc(empty)}</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

function pagination(result) {
  if (result.pages <= 1) return '';
  const pages = Array.from({ length: result.pages }, (_, i) => i + 1);
  return `
    <nav class="admin-pagination" aria-label="Paginação">
      ${pages.map((page) => `
        <button class="admin-page-btn ${page === result.page ? 'is-active' : ''}" type="button" data-page="${page}">${page}</button>
      `).join('')}
    </nav>`;
}

function inputFilter(key, placeholder, value) {
  return `
    <label class="admin-search">
      ${icon('search')}
      <input type="search" data-filter="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}" />
    </label>`;
}

function selectFilter(key, value, options) {
  return `
    <select class="admin-select" data-filter="${key}">
      ${options.map(([v, label]) => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(label)}</option>`).join('')}
    </select>`;
}

function miniList(items, render, empty) {
  if (!items.length) return `<div class="admin-empty">${esc(empty)}</div>`;
  return `<div class="admin-mini-list">${items.map((item) => `<div class="admin-mini-row">${render(item)}</div>`).join('')}</div>`;
}

// Aceita o usuario inteiro (pra ler is_owner) ou so a role, por compat com
// os dois pontos de chamada existentes.
function rolePill(userOrRole) {
  const isOwner = typeof userOrRole === 'object' && userOrRole?.is_owner;
  const role = typeof userOrRole === 'object' ? userOrRole?.role : userOrRole;
  const label = isOwner ? 'dono' : (role === 'admin' ? 'admin' : 'usuario');
  const cls = isOwner ? 'badge-warning' : (role === 'admin' ? 'badge-info' : 'badge-neutral');
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function accessLevelPill(user) {
  const level = user?.role === 'admin' ? 'operacao' : (user?.access_level || 'operacao');
  return `<span class="badge ${level === 'consulta' ? 'badge-neutral' : 'badge-info'}">${level === 'consulta' ? 'Somente leitura' : 'Pode alterar'}</span>`;
}

function contextChip(contexto) {
  return `<span class="badge ${contexto === 'empresarial' ? 'badge-info' : 'badge-neutral'}">${esc(contexto || 'pessoal')}</span>`;
}

function accessChips(user) {
  const empresas = user.empresas || [];
  const chips = [];
  if (['pessoal', 'ambos'].includes(user.workspaces || 'ambos')) {
    chips.push(`<span class="badge badge-neutral">Pessoal · ${esc(user.moeda_pessoal || 'BRL')}</span>`);
  }
  chips.push(...empresas.slice(0, 2).map((e) => `<span class="badge badge-neutral">${esc(e.nome)}</span>`));
  if (empresas.length > 2) chips.push(`<span class="badge badge-neutral">+${empresas.length - 2}</span>`);
  if (!chips.length && user.empresa_nome) chips.push(`<span class="badge badge-neutral">${esc(user.empresa_nome)}</span>`);
  return chips.length ? `<div class="admin-chip-list">${chips.join('')}</div>` : '-';
}

function actions(items) {
  return `<div class="admin-actions">${items.map(([action, id, label, kind]) => `
    <button class="admin-icon-action ${kind === 'danger' ? 'is-danger' : ''}" type="button" data-row-action="${action}" data-id="${esc(id || '')}">${esc(label)}</button>
  `).join('')}</div>`;
}

function renderState(kind, message, action = '') {
  const label = kind === 'loading' ? `<span class="admin-spinner" aria-hidden="true"></span>` : icon(kind === 'error' ? 'alert' : 'grid');
  return `
    <section class="admin-state" aria-live="polite">
      ${label}
      <p>${esc(message)}</p>
      ${action}
    </section>`;
}

function filterRows(rows, query, fields) {
  const q = normalizeText(query);
  if (!q) return [...rows];
  return rows.filter((row) => fields.some((field) => normalizeText(row[field]).includes(q)));
}

function sortRows(rows, filter) {
  const dir = filter.dir === 'desc' ? -1 : 1;
  const key = filter.sort;
  return [...rows].sort((a, b) => {
    const av = a[key] ?? '';
    const bv = b[key] ?? '';
    if (key === 'saldo') return (Number(av) - Number(bv)) * dir;
    return String(av).localeCompare(String(bv), 'pt-BR', { numeric: true }) * dir;
  });
}

function paginate(rows, filter) {
  const pages = Math.max(Math.ceil(rows.length / PAGE_SIZE), 1);
  const page = Math.min(Math.max(Number(filter.page || 1), 1), pages);
  const start = (page - 1) * PAGE_SIZE;
  return { items: rows.slice(start, start + PAGE_SIZE), page, pages, total: rows.length };
}

function setSort(view, key) {
  const filter = state.filters[view];
  if (!filter) return;
  if (filter.sort === key) filter.dir = filter.dir === 'asc' ? 'desc' : 'asc';
  else {
    filter.sort = key;
    filter.dir = 'asc';
  }
}

function isUserLocked(user) {
  return user?.locked_until && new Date(user.locked_until) > new Date();
}

function isUserArchived(user) {
  return Boolean(user?.deleted_at);
}

function userStatusChip(u) {
  if (isUserArchived(u)) return '<span class="badge badge-neutral">arquivado</span>';
  const status = u?.status || 'aprovado';
  if (status === 'pendente') return '<span class="badge badge-warning" title="Aguardando aprovação">aguardando</span>';
  if (status === 'rejeitado') return '<span class="badge badge-danger">rejeitado</span>';
  return isUserLocked(u)
    ? '<span class="badge badge-warning">bloqueado</span>'
    : '<span class="badge badge-success">ativo</span>';
}

async function decideUser(user, acao) {
  if (!user) return;
  const aprovar = acao === 'aprovar';
  const ok = await openConfirm({
    title: aprovar ? 'Aprovar cadastro' : 'Rejeitar cadastro',
    message: aprovar
      ? `Aprovar "${user.username}" (${user.nome || 'sem nome'})? A conta entra com acesso Pessoal; ajuste função/empresas depois em Editar.`
      : `Rejeitar "${user.username}"? A pessoa não vai conseguir entrar (a decisão fica registrada).`,
    confirmLabel: aprovar ? 'Aprovar' : 'Rejeitar',
    danger: !aprovar
  });
  if (!ok) return;
  await runAction(async () => {
    await adminApi.aprovarUser(user.id, { acao });
    toast(aprovar ? 'Cadastro aprovado.' : 'Cadastro rejeitado.');
    await loadAll();
  });
}

// Aprovação/rejeição em massa (SDD WS4.5): um único confirm, api.aprovarUser em
// Promise.allSettled, e o toast reporta sucessos/falhas.
async function bulkDecideUsers(acao) {
  const aprovar = acao === 'aprovar';
  const ids = [...state.verifSelection];
  const users = ids.map((id) => findById('usuarios', id)).filter(Boolean);
  if (!users.length) return;
  const ok = await openConfirm({
    title: aprovar ? `Aprovar ${users.length} cadastro(s)` : `Rejeitar ${users.length} cadastro(s)`,
    message: aprovar
      ? `Aprovar ${users.length} solicitação(ões) selecionada(s)? Cada conta entra com acesso Pessoal; ajuste função/empresas depois em Editar.`
      : `Rejeitar ${users.length} solicitação(ões) selecionada(s)? As pessoas não vão conseguir entrar (a decisão fica registrada).`,
    confirmLabel: aprovar ? 'Aprovar selecionados' : 'Rejeitar selecionados',
    danger: !aprovar
  });
  if (!ok) return;
  await runAction(async () => {
    const results = await Promise.allSettled(users.map((u) => adminApi.aprovarUser(u.id, { acao })));
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    const failCount = results.length - okCount;
    state.verifSelection.clear();
    await loadAll();
    if (failCount === 0) {
      toast(aprovar ? `${okCount} cadastro(s) aprovado(s).` : `${okCount} cadastro(s) rejeitado(s).`);
    } else {
      toast(`${okCount} ok, ${failCount} falha(s). Reveja os que restaram na lista.`, okCount ? 'ok' : 'error');
    }
  });
}

function categoryContext(cat) {
  return cat?.escopo || (cat?.tipo === 'empresarial' ? 'empresarial' : 'pessoal');
}

function handleRowAction(action, id) {
  const maps = {
    'new-empresa': () => openEmpresaModal(),
    'edit-empresa': () => openEmpresaModal(findById('empresas', id)),
    'delete-empresa': () => deleteEmpresa(findById('empresas', id)),
    'new-user': () => openUserModal(),
    'edit-user': () => openUserModal(findById('usuarios', id)),
    'password-user': () => openPasswordModal(findById('usuarios', id)),
    'approve-user': () => decideUser(findById('usuarios', id), 'aprovar'),
    'reject-user': () => decideUser(findById('usuarios', id), 'rejeitar'),
    'review-user': () => openReviewModal(findById('usuarios', id)),
    'delete-user': () => deleteUser(findById('usuarios', id)),
    'restore-user': () => restoreUser(findById('usuarios', id)),
    'new-conta': () => openContaModal(),
    'edit-conta': () => openContaModal(findById('contas', id)),
    'delete-conta': () => deleteConta(findById('contas', id)),
    'new-categoria': () => openCategoriaModal(),
    'edit-categoria': () => openCategoriaModal(findById('categorias', id)),
    'delete-categoria': () => deleteCategoria(findById('categorias', id)),
    'restaurar-lixeira-adm': () => restaurarLixeiraAdmin(id),
    'purgar-lixeira-adm': () => purgarLixeiraAdmin(id),
    'new-delegacao': () => openDelegacaoModal(),
    'revoke-delegacao': () => revokeDelegacao(id)
  };
  maps[action]?.();
}

function findById(collection, id) {
  return state.data[collection].find((item) => String(item.id) === String(id));
}

function openEmpresaModal(empresa = null) {
  openFormModal({
    title: empresa ? 'Editar empresa' : 'Nova empresa',
    submitLabel: empresa ? 'Salvar empresa' : 'Criar empresa',
    size: 'wide',
    body: `
      ${formSection('Dados da empresa', 'Identificação e contato usados no ambiente empresarial.', `
        <div class="admin-form-grid">
          ${field('nome', 'Nome', `<input name="nome" value="${esc(empresa?.nome || '')}" required maxlength="255" />`)}
          ${field('cnpj', 'Documento', `<input name="cnpj" value="${esc(empresa?.cnpj || '')}" maxlength="20" />`)}
          ${field('email', 'E-mail', `<input name="email" type="email" value="${esc(empresa?.email || '')}" maxlength="191" />`)}
          ${field('telefone', 'Telefone', `<input name="telefone" value="${esc(empresa?.telefone || '')}" maxlength="30" />`)}
          ${field('moeda_base', 'Moeda-base dos relatórios', select('moeda_base', empresa?.moeda_base || 'BRL', moedaOptions()), 'Contas em outras moedas serão consolidadas nesta moeda.')}
        </div>
      `)}
    `,
    onSubmit: async (form) => {
      const body = formValues(form);
      if (!body.nome.trim()) fieldFail('nome', 'Informe o nome da empresa.');
      if (empresa) await adminApi.putEmpresa(empresa.id, body);
      else await adminApi.postEmpresa(body);
      toast(empresa ? 'Empresa atualizada.' : 'Empresa criada.');
      await loadAll();
    }
  });
}

function openUserModal(user = null) {
  const selected = new Set(user?.empresa_ids || (user?.empresa_id ? [user.empresa_id] : []));
  const primaryCompanyId = user?.empresa_id || user?.empresa_ids?.[0] || '';
  openFormModal({
    title: user ? 'Editar usuário' : 'Novo usuário',
    submitLabel: user ? 'Salvar usuário' : 'Criar usuário',
    size: 'wide',
    body: `
      ${formSection('Identificação', 'Dados de login e contato do usuário.', `
        <div class="admin-form-grid">
          ${field('username', 'Usuário/login', `<input name="username" value="${esc(user?.username || '')}" autocomplete="off" required />`, 'Minúsculas, números, ponto, hífen e underscore.')}
          ${field('nome', 'Nome completo', `<input name="nome" value="${esc(user?.nome || '')}" required />`)}
          ${field('email', 'E-mail', `<input name="email" type="email" value="${esc(user?.email || '')}" autocomplete="off" />`)}
          ${field('telefone', 'Telefone', `<input name="telefone" value="${esc(user?.telefone || '')}" maxlength="32" />`)}
          ${field('documento', 'CPF / CNPJ', `<input name="documento" value="${esc(user?.documento || '')}" maxlength="32" />`)}
          <span data-business-only style="display:contents">
          ${field('empresa_solicitada', 'Empresa solicitada', `<input name="empresa_solicitada" value="${esc(user?.empresa_solicitada || '')}" maxlength="191" />`)}
          ${field('plano', 'Plano informado', `<input name="plano" value="${esc(user?.plano || '')}" maxlength="120" />`)}
          </span>
        </div>
      `)}
      ${formSection('Acesso e cobrança', 'Permissões, aprovação e situação financeira da conta.', `
        <div class="admin-form-grid">
          ${field('role', 'Função', select('role', (user?.is_owner ? 'dono' : (user?.role || 'usuario')), [
            ['usuario', 'Usuário'], ['admin', 'Administrador'],
            ...(state.user?.is_owner ? [['dono', 'Dono do sistema']] : [])
          ]), state.user?.is_owner ? 'Dono do sistema: acesso total, inclusive sobre outros admins.' : '')}
          ${field('status', 'Status do cadastro', select('status', user?.status || 'aprovado', [['aprovado', 'Aprovado'], ['pendente', 'Aguardando aprovação'], ['rejeitado', 'Rejeitado']]))}
          ${field('pagamento_status', 'Situação de pagamento', select('pagamento_status', user?.pagamento_status || 'pendente', [['pendente', 'Pendente'], ['pago', 'Pago'], ['isento', 'Isento']]))}
          ${field('workspaces', 'Áreas de acesso', select('workspaces', user?.workspaces || 'pessoal', [['pessoal', 'Somente pessoal'], ['empresarial', 'Somente empresarial'], ['ambos', 'Pessoal e empresarial']]), 'Contas pessoais funcionam sozinhas, sem vínculo com empresa. Escolha empresarial só quando precisar do ambiente da empresa.')}
          ${field('access_level', 'Permissão financeira', select('access_level', user?.role === 'admin' ? 'operacao' : (user?.access_level || 'operacao'), [['operacao', 'Criar, editar e excluir'], ['consulta', 'Somente visualizar']]), 'Administradores sempre possuem acesso completo. Alterar esta permissão encerra as sessões abertas do usuário.')}
          <div data-personal-currency-field>
            ${field('moeda_pessoal', 'Moeda do ambiente pessoal', select('moeda_pessoal', user?.moeda_pessoal || 'BRL', moedaOptions()), 'Aplicada aos saldos e relatórios pessoais.')}
          </div>
          ${user ? field('locked', 'Acesso ao sistema', select('locked', isUserLocked(user) ? '1' : '0', [['0', 'Ativo'], ['1', 'Bloqueado']]), 'Desbloquear também zera as tentativas de login falhas.') : ''}
        </div>
      `)}
      <section class="admin-multiselect" data-company-access>
        <div class="admin-multiselect-head">
          <div><label for="empresa-search">Empresas vinculadas</label><small>Definem os ambientes e moedas que o usuário pode acessar.</small></div>
          <input id="empresa-search" type="search" data-modal-action="filter-empresas" placeholder="Buscar empresa" />
        </div>
        <div class="admin-company-options">
          ${state.data.empresas.map((empresa) => `
            <label class="admin-company-option" data-company-name="${esc(normalizeText(empresa.nome))}" data-company-currency="${esc(empresa.moeda_base || 'BRL')}">
              <input type="checkbox" name="empresa_ids" value="${esc(empresa.id)}" ${selected.has(empresa.id) ? 'checked' : ''} />
              <span class="admin-company-option-copy"><strong>${esc(empresa.nome)}</strong><small>${esc(empresa.moeda_base || 'BRL')} · moeda-base</small></span>
            </label>
          `).join('') || '<p class="admin-empty">Nenhuma empresa disponível.</p>'}
        </div>
        <div class="admin-user-link-controls">
          ${field('empresa_principal', 'Empresa principal', select('empresa_principal', primaryCompanyId, [
            ['', 'Sem empresa principal'],
            ...state.data.empresas.filter((empresa) => selected.has(empresa.id)).map((empresa) => [empresa.id, empresa.nome])
          ]), 'Usada como vínculo inicial no ambiente empresarial.')}
          <div class="admin-currency-summary" data-user-currencies aria-live="polite"></div>
        </div>
        <p class="admin-field-hint" id="admin-error-empresa_ids" data-error-for="empresa_ids">Usuários somente pessoais podem ficar sem empresa. Acesso empresarial exige ao menos uma empresa, exceto administradores.</p>
      </section>
      ${state.user?.is_owner && user ? formSection(
        'Contas que este usuário comanda',
        'Delegação: quem for marcado abaixo passa a ter a conta Pessoal comandada por este usuário — ele vê (e, se marcado "operar", lança/edita/exclui) sem nunca saber a senha da outra pessoa. So o dono concede.',
        renderDelegacoesField(user)
      ) : ''}
      ${formSection('Segurança', user ? 'Estado atual da autenticação.' : 'Defina a senha provisória de primeiro acesso.', `
        ${user ? `<section class="admin-mini-list">
          ${adminMiniRow('Último login', dateBR(user.last_login_at))}
          ${adminMiniRow('MFA', user.mfa_enabled ? 'Ativo' : 'Inativo')}
          ${adminMiniRow('Cadastro', dateBR(user.createdAt))}
        </section>` : `<div class="admin-form-grid">
          ${field('password', 'Senha provisória', `<div class="admin-password-row"><input name="password" type="password" autocomplete="new-password" required minlength="8" /><button class="btn btn-ghost" type="button" data-modal-action="toggle-password">Mostrar</button></div>`)}
          ${field('password_confirm', 'Confirmar senha', `<input name="password_confirm" type="password" autocomplete="new-password" required minlength="8" />`)}
        </div>`}
      `)}
    `,
    afterOpen: (form) => {
      syncUserWorkspaceAccess(form);
      syncUserCompanyAccess(form);
      if (state.user?.is_owner && user) wireDelegacoesField(form);
    },
    onSubmit: async (form) => {
      const body = formValues(form);
      body.username = body.username.trim().toLowerCase();
      body.nome = body.nome.trim().replace(/\s+/g, ' ');
      body.email = body.email.trim() || null;
      body.telefone = body.telefone.trim() || null;
      body.documento = body.documento.trim() || null;
      body.empresa_solicitada = body.empresa_solicitada.trim() || null;
      body.plano = body.plano.trim() || null;
      if (user) body.locked = body.locked === '1';
      const hasBusiness = ['empresarial', 'ambos'].includes(body.workspaces);
      const empresaIds = hasBusiness ? checkedValues(form, 'empresa_ids') : [];
      const empresaPrincipal = hasBusiness ? (form.elements.empresa_principal?.value || '') : '';
      body.empresa_ids = empresaPrincipal
        ? [empresaPrincipal, ...empresaIds.filter((id) => id !== empresaPrincipal)]
        : empresaIds;
      // Conta somente pessoal nao carrega vinculo empresarial nenhum.
      body.empresa_id = hasBusiness ? (empresaPrincipal || body.empresa_ids[0] || null) : null;
      if (!['pessoal', 'ambos'].includes(body.workspaces)) delete body.moeda_pessoal;
      validateUserPayload(body, Boolean(user));
      if (user) await adminApi.putUser(user.id, body);
      else await adminApi.postUser(body);
      if (state.user?.is_owner && user) await syncDelegacoesField(form, user);
      toast(user ? 'Usuário atualizado.' : 'Usuário criado.');
      await loadAll();
    }
  });
}

// === Delegação inline em "Editar usuário" (v87) ============================
// Um checkbox por conta candidata + um select de permissão (habilitado só
// quando marcado). Mesmo padrão visual/estrutural do multiselect de
// "Empresas vinculadas" (checkedValues, admin-company-option) — ver
// openUserModal acima.

function renderDelegacoesField(user) {
  const candidatos = state.data.usuarios
    .filter((u) => u.id !== user.id && !u.is_owner && !isUserArchived(u))
    .sort((a, b) => (a.nome || a.username).localeCompare(b.nome || b.username, 'pt-BR'));
  if (!candidatos.length) {
    return '<p class="admin-empty">Nenhuma outra conta disponível para delegar.</p>';
  }
  const porUsuario = new Map(
    state.data.delegacoes.filter((d) => d.gestor_id === user.id && d.ativo).map((d) => [d.usuario_id, d])
  );
  return `
    <div class="admin-delegacoes-field">
      ${candidatos.map((c) => {
        const atual = porUsuario.get(c.id);
        const marcado = Boolean(atual);
        const permissao = atual?.permissao || 'visualizar';
        return `
          <label class="admin-delegacao-row">
            <input type="checkbox" name="delegacao_ids" value="${esc(c.id)}" data-delegacao-toggle="${esc(c.id)}" ${marcado ? 'checked' : ''} />
            <span class="admin-delegacao-nome">${esc(c.nome || c.username)}</span>
            <select name="delegacao_perm_${esc(c.id)}" data-delegacao-perm="${esc(c.id)}" ${marcado ? '' : 'disabled'}>
              <option value="visualizar" ${permissao === 'visualizar' ? 'selected' : ''}>Somente visualizar</option>
              <option value="operar" ${permissao === 'operar' ? 'selected' : ''}>Lançar, editar e excluir</option>
            </select>
          </label>`;
      }).join('')}
    </div>`;
}

function wireDelegacoesField(form) {
  $$('[data-delegacao-toggle]', form).forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const select = form.querySelector(`[data-delegacao-perm="${CSS.escape(checkbox.dataset.delegacaoToggle)}"]`);
      if (select) select.disabled = !checkbox.checked;
    });
  });
}

// Compara o estado marcado no form com as delegações atuais desse gestor e
// aplica só a diferença: concede as novas, atualiza permissão de quem mudou,
// revoga quem foi desmarcado. Nunca falha a submissão inteira por causa de
// uma delegação isolada — cada chamada roda independente.
async function syncDelegacoesField(form, user) {
  if (!$('[data-delegacao-toggle]', form)) return; // usuario sem candidatos (campo nem renderizou)
  const marcados = new Set(checkedValues(form, 'delegacao_ids'));
  const atuais = new Map(
    state.data.delegacoes.filter((d) => d.gestor_id === user.id && d.ativo).map((d) => [d.usuario_id, d])
  );

  const tarefas = [];
  for (const usuarioId of marcados) {
    const permissao = form.querySelector(`[data-delegacao-perm="${CSS.escape(usuarioId)}"]`)?.value || 'visualizar';
    const existente = atuais.get(usuarioId);
    if (!existente) {
      tarefas.push(adminApi.postDelegacao({ gestor_id: user.id, usuario_id: usuarioId, permissao }));
    } else if (existente.permissao !== permissao) {
      tarefas.push(adminApi.putDelegacao(existente.id, { permissao }));
    }
  }
  for (const [usuarioId, existente] of atuais) {
    if (!marcados.has(usuarioId)) tarefas.push(adminApi.deleteDelegacao(existente.id));
  }
  if (!tarefas.length) return;

  const resultados = await Promise.allSettled(tarefas);
  const falhas = resultados.filter((r) => r.status === 'rejected');
  if (falhas.length) {
    toast(`${falhas.length} delegação(ões) não puderam ser salvas: ${falhas[0].reason?.message || 'erro desconhecido'}`, 'error');
  }
}

function openPasswordModal(user) {
  if (!user) return;
  openFormModal({
    title: `Alterar senha de ${user.username}`,
    submitLabel: 'Alterar senha',
    body: `
      ${field('password', 'Nova senha', `<div class="admin-password-row"><input name="password" type="password" autocomplete="new-password" required minlength="8" /><button class="btn btn-ghost" type="button" data-modal-action="toggle-password">Mostrar</button></div>`)}
      ${field('password_confirm', 'Confirmar senha', `<input name="password_confirm" type="password" autocomplete="new-password" required minlength="8" />`)}
    `,
    onSubmit: async (form) => {
      const body = formValues(form);
      if (body.password.length < 8) fieldFail('password', 'Senha precisa de no mínimo 8 caracteres.');
      if (body.password !== body.password_confirm) fieldFail('password_confirm', 'As senhas não conferem.');
      await adminApi.resetSenha(user.id, { password: body.password });
      toast('Senha alterada.');
    }
  });
}

function openContaModal(conta = null) {
  openFormModal({
    title: conta ? 'Editar conta bancária' : 'Nova conta bancária',
    submitLabel: conta ? 'Salvar conta' : 'Criar conta',
    body: `
      ${formSection('Dados da conta', 'A moeda define como o saldo desta conta será exibido e convertido.', `
        ${field('nome', 'Nome da conta', `<input name="nome" value="${esc(conta?.nome || '')}" required />`)}
        ${field('tipo', 'Tipo', select('tipo', conta?.tipo || 'corrente', TIPOS_CONTA.map((t) => [t, t])))}
        ${field('moeda', 'Moeda da conta', select('moeda', conta?.moeda || 'BRL', moedaOptions()))}
        ${field('saldo', conta ? 'Saldo atual' : 'Saldo inicial', `<input name="saldo" type="number" step="0.01" value="${esc(conta?.saldo ?? 0)}" />`)}
        ${conta ? field('ativo', 'Status', select('ativo', conta.ativo ? '1' : '0', [['1', 'Ativa'], ['0', 'Inativa']])) : ''}
      `)}
    `,
    onSubmit: async (form) => {
      const values = formValues(form);
      if (!values.nome.trim()) fieldFail('nome', 'Informe o nome da conta.');
      const body = {
        nome: values.nome.trim(),
        tipo: values.tipo,
        moeda: values.moeda,
        saldo: Number(values.saldo || 0),
        ...(conta ? { ativo: values.ativo === '1' } : { saldo_inicial: Number(values.saldo || 0) })
      };
      if (conta) await adminApi.putConta(conta.id, body);
      else await adminApi.postConta(body);
      toast(conta ? 'Conta atualizada.' : 'Conta criada.');
      await loadAll();
    }
  });
}

function openCategoriaModal(categoria = null) {
  const contexto = categoryContext(categoria || {});
  openFormModal({
    title: categoria ? 'Editar categoria' : 'Nova categoria',
    submitLabel: categoria ? 'Salvar categoria' : 'Criar categoria',
    body: `
      ${formSection('Classificação', 'Contexto, natureza e vínculo com o DRE.', `
        ${field('nome', 'Nome', `<input name="nome" value="${esc(categoria?.nome || '')}" required />`)}
        ${field('tipo', 'Contexto', select('tipo', contexto || 'empresarial', TIPOS_CATEGORIA.map((t) => [t, t])))}
        ${field('natureza', 'Natureza', select('natureza', categoria?.natureza || '', NATUREZAS.map((t) => [t, t || 'Sem natureza'])))}
        <div data-category-extra>
          ${field('dre_secao', 'Seção DRE', select('dre_secao', categoria?.dre_secao || '', DRE_SECOES.map((s) => [s, s || 'Nenhuma'])))}
        </div>
        ${field('cor', 'Cor', `<input name="cor" value="${esc(categoria?.cor || '')}" placeholder="#22d3ee" />`)}
        ${categoria ? field('ativo', 'Status', select('ativo', categoria.ativo ? '1' : '0', [['1', 'Ativa'], ['0', 'Inativa']])) : ''}
      `)}
    `,
    afterOpen: syncCategoriaExtra,
    onSubmit: async (form) => {
      const values = formValues(form);
      if (!values.nome.trim()) fieldFail('nome', 'Informe o nome da categoria.');
      const pessoal = values.tipo === 'pessoal';
      const body = {
        nome: values.nome.trim(),
        tipo: values.tipo,
        natureza: values.natureza || null,
        cor: values.cor.trim() || null,
        ...(pessoal ? {} : { dre_secao: values.dre_secao || null }),
        ...(categoria ? { ativo: values.ativo === '1' } : {})
      };
      if (categoria) await adminApi.putCategoria(categoria.id, body);
      else await adminApi.postCategoria(body);
      toast(categoria ? 'Categoria atualizada.' : 'Categoria criada.');
      await loadAll();
    }
  });
}

async function deleteEmpresa(empresa) {
  if (!empresa) return;
  const ok = await openConfirm({
    title: 'Excluir empresa',
    message: `Excluir "${empresa.nome}"? O backend recusará a operação se houver vínculos ou registros protegidos.`,
    confirmLabel: 'Excluir',
    danger: true
  });
  if (!ok) return;
  await runAction(async () => {
    await adminApi.deleteEmpresa(empresa.id);
    toast('Empresa excluida.');
    await loadAll();
  });
}

async function deleteUser(user) {
  if (!user) return;
  const ok = await openConfirm({
    title: 'Arquivar usuário',
    message: `Arquivar "${user.username}"? O acesso será revogado, mas vínculos e histórico financeiro serão preservados.`,
    confirmLabel: 'Arquivar',
    danger: true
  });
  if (!ok) return;
  await runAction(async () => {
    await adminApi.deleteUser(user.id);
    toast('Usuário arquivado.');
    await loadAll();
  });
}

async function restoreUser(user) {
  if (!user) return;
  const ok = await openConfirm({
    title: 'Restaurar usuário',
    message: `Restaurar "${user.username}"? O acesso dependerá do status e das permissões atuais da conta.`,
    confirmLabel: 'Restaurar'
  });
  if (!ok) return;
  await runAction(async () => {
    await adminApi.restoreUser(user.id);
    toast('Usuário restaurado.');
    await loadAll();
  });
}

async function deleteConta(conta) {
  if (!conta) return;
  const ok = await openConfirm({
    title: 'Desativar conta',
    message: `Desativar "${conta.nome}"? O backend exige saldo zero e preserva histórico.`,
    confirmLabel: 'Desativar',
    danger: true
  });
  if (!ok) return;
  await runAction(async () => {
    await adminApi.deleteConta(conta.id);
    toast('Conta desativada.');
    await loadAll();
  });
}

async function deleteCategoria(categoria) {
  if (!categoria) return;
  const ok = await openConfirm({
    title: 'Excluir categoria',
    message: `Excluir "${categoria.nome}"? O backend bloqueia categorias em uso.`,
    confirmLabel: 'Excluir',
    danger: true
  });
  if (!ok) return;
  await runAction(async () => {
    await adminApi.deleteCategoria(categoria.id);
    toast('Categoria excluida.');
    await loadAll();
  });
}

async function runAction(fn) {
  try {
    await fn();
  } catch (error) {
    toast(error?.message || 'Falha na operação.', 'error');
  }
}

function validateUserPayload(body, editing) {
  if (!/^[a-z0-9._-]{3,191}$/.test(body.username)) {
    fieldFail('username', 'Use apenas minúsculas, números, ponto, hífen e underscore.');
  }
  if (!body.nome) fieldFail('nome', 'Informe o nome completo.');
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    fieldFail('email', 'Informe um e-mail válido.');
  }
  if (!editing) {
    if (body.password.length < 8) fieldFail('password', 'Senha precisa de no mínimo 8 caracteres.');
    if (body.password !== body.password_confirm) fieldFail('password_confirm', 'As senhas não conferem.');
  }
  if (!['admin', 'dono'].includes(body.role) && ['empresarial', 'ambos'].includes(body.workspaces) && body.empresa_ids.length === 0) {
    fieldFail('empresa_ids', 'Selecione ao menos uma empresa para acesso empresarial.');
  }
  delete body.password_confirm;
}

function formSection(title, description, content) {
  return `
    <section class="admin-form-section">
      <header class="admin-form-section-head">
        <h3>${esc(title)}</h3>
        ${description ? `<p>${esc(description)}</p>` : ''}
      </header>
      ${content}
    </section>`;
}

function field(name, label, control, hint = '') {
  return `
    <label class="admin-field">
      <span>${esc(label)}</span>
      ${control}
      <small id="admin-error-${esc(name)}" data-error-for="${esc(name)}">${hint ? esc(hint) : ''}</small>
    </label>`;
}

function adminMiniRow(label, value) {
  return `<div class="admin-mini-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function select(name, value, options) {
  return `
    <select name="${esc(name)}">
      ${options.map(([v, label]) => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(label)}</option>`).join('')}
    </select>`;
}

function formValues(form) {
  const data = new FormData(form);
  const values = {};
  for (const [key, value] of data.entries()) {
    if (key in values) continue;
    values[key] = String(value);
  }
  return values;
}

function checkedValues(form, name) {
  return $$(`input[name="${name}"]:checked`, form).map((input) => input.value);
}

function fieldFail(name, message) {
  const error = new Error(message);
  error.field = name;
  throw error;
}

function openFormModal({ title, body, submitLabel, onSubmit, size = '', afterOpen }) {
  const root = $('#modal-root');
  $('#toast-root')?.replaceChildren();
  state.modal = { dirty: false, previousFocus: document.activeElement };
  root.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal-card admin-modal-scroll ${size === 'wide' ? 'is-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="admin-modal-title" tabindex="-1">
        <header class="modal-header">
          <h2 class="modal-title" id="admin-modal-title">${esc(title)}</h2>
          <button class="btn-icon" type="button" data-modal-action="request-close" aria-label="Fechar">${icon('x')}</button>
        </header>
        <form class="admin-modal-form" novalidate>
          <div class="modal-body">
            <div class="admin-form-error" role="alert" tabindex="-1" hidden></div>
            ${body}
          </div>
          <footer class="modal-footer">
            <button class="btn btn-ghost" type="button" data-modal-action="request-close">Cancelar</button>
            <button class="btn btn-primary" type="submit">${esc(submitLabel)}</button>
          </footer>
        </form>
      </section>
    </div>`;

  const modal = $('.modal-card', root);
  const form = $('form', root);
  bindModalEvents({ form, onSubmit });
  afterOpen?.(form);
  modal.focus();
}

function bindModalEvents({ form, onSubmit }) {
  const root = $('#modal-root');
  root.onmousedown = onModalMouseDown;
  root.onclick = onModalClick;
  root.oninput = onModalInput;
  root.onchange = onModalInput;
  root.onkeydown = onModalKeydown;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.busy) return;
    clearFieldErrors(form);
    state.busy = true;
    setSubmitBusy(form, true);
    try {
      await onSubmit(form);
      closeModal(true);
    } catch (error) {
      showFormError(form, error);
    } finally {
      state.busy = false;
      setSubmitBusy(form, false);
    }
  });
}

function onModalMouseDown(event) {
  if (event.target.classList.contains('modal-backdrop')) requestCloseModal();
}

function onModalClick(event) {
  const action = event.target.closest('[data-modal-action]')?.dataset.modalAction;
  if (!action) return;
  if (action === 'request-close') requestCloseModal();
  if (action === 'toggle-password') {
    const input = event.target.closest('.admin-password-row')?.querySelector('input');
    if (input) {
      input.type = input.type === 'password' ? 'text' : 'password';
      event.target.textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar';
    }
  }
  if (action === 'filter-empresas') filterCompanyOptions(event.target.value);
}

function onModalInput(event) {
  if (event.target.dataset.modalAction === 'filter-empresas') {
    filterCompanyOptions(event.target.value);
    return;
  }
  state.modal.dirty = true;
  if (event.target.name === 'tipo') syncCategoriaExtra(event.target.form);
  if (event.target.name === 'empresa_ids') syncUserCompanyAccess(event.target.form);
  if (event.target.name === 'workspaces') {
    syncUserWorkspaceAccess(event.target.form);
    syncUserCompanyAccess(event.target.form);
  }
}

function onModalKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    requestCloseModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = modalFocusable();
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function requestCloseModal() {
  if (state.modal?.dirty) {
    const ok = await openConfirm({
      title: 'Descartar alterações',
      message: 'Existem alterações não salvas neste formulário.',
      confirmLabel: 'Descartar',
      danger: true
    });
    if (!ok) return;
  }
  closeModal();
}

function closeModal(saved = false) {
  const previous = state.modal?.previousFocus;
  const root = $('#modal-root');
  root.innerHTML = '';
  root.onmousedown = null;
  root.onclick = null;
  root.oninput = null;
  root.onchange = null;
  root.onkeydown = null;
  state.modal = null;
  state.busy = false;
  if (previous && typeof previous.focus === 'function') requestAnimationFrame(() => previous.focus());
  if (saved) renderMain();
}

function modalFocusable() {
  return $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', $('#modal-root'))
    .filter((el) => !el.disabled && el.offsetParent !== null);
}

function clearFieldErrors(form) {
  $('.admin-form-error', form).hidden = true;
  $$('[aria-invalid="true"]', form).forEach((control) => {
    control.removeAttribute('aria-invalid');
    control.removeAttribute('aria-errormessage');
  });
  $$('[data-error-for]', form).forEach((el) => {
    el.classList.remove('is-error');
    if (!el.dataset.originalHint) el.dataset.originalHint = el.textContent || '';
    el.textContent = el.dataset.originalHint;
  });
}

function showFormError(form, error) {
  let focusTarget = null;
  if (error?.field) {
    const target = $(`[data-error-for="${error.field}"]`, form);
    if (target) {
      target.classList.add('is-error');
      target.textContent = error.message;
    }
    focusTarget = error.field === 'empresa_ids'
      ? $('#empresa-search', form) || $('[name="empresa_ids"]', form)
      : form.elements.namedItem(error.field);
    if (focusTarget instanceof HTMLElement) {
      focusTarget.setAttribute('aria-invalid', 'true');
      if (target?.id) focusTarget.setAttribute('aria-errormessage', target.id);
    } else {
      focusTarget = null;
    }
  }
  const box = $('.admin-form-error', form);
  box.hidden = false;
  box.textContent = error?.message || 'Erro ao salvar.';
  focusTarget ||= box;
  requestAnimationFrame(() => {
    focusTarget.focus({ preventScroll: true });
    focusTarget.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
}

function setSubmitBusy(form, busy) {
  const button = $('button[type="submit"]', form);
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? 'Salvando...' : button.dataset.label || button.textContent;
}

function syncCategoriaExtra(form = $('.modal-card form')) {
  if (!form) return;
  const type = form.elements.tipo?.value;
  const extra = $('[data-category-extra]', form);
  if (extra) extra.hidden = type === 'pessoal';
}

function filterCompanyOptions(value) {
  const q = normalizeText(value);
  $$('.admin-company-option').forEach((option) => {
    option.hidden = q && !option.dataset.companyName.includes(q);
  });
}

function syncUserWorkspaceAccess(form = $('.modal-card form')) {
  if (!form?.elements?.workspaces) return;
  const workspaces = form.elements.workspaces.value;
  const hasPersonal = ['pessoal', 'ambos'].includes(workspaces);
  const hasBusiness = ['empresarial', 'ambos'].includes(workspaces);
  const personalCurrency = $('[data-personal-currency-field]', form);
  const companyAccess = $('[data-company-access]', form);
  if (personalCurrency) personalCurrency.hidden = !hasPersonal;
  // Conta pessoal e totalmente independente: esconde todo o bloco empresarial
  // (empresa solicitada, plano e vinculo de empresas) quando nao ha acesso empresarial.
  $$('[data-business-only]', form).forEach((el) => { el.style.display = hasBusiness ? 'contents' : 'none'; });
  if (companyAccess) {
    companyAccess.hidden = !hasBusiness;
    companyAccess.classList.toggle('is-optional', !hasBusiness);
  }
}

function syncUserCompanyAccess(form = $('.modal-card form')) {
  if (!form?.elements?.empresa_principal) return;
  const selectedIds = checkedValues(form, 'empresa_ids');
  const current = form.elements.empresa_principal.value;
  const selectedCompanies = selectedIds
    .map((id) => state.data.empresas.find((empresa) => String(empresa.id) === String(id)))
    .filter(Boolean);
  const primary = selectedIds.includes(current) ? current : (selectedIds[0] || '');
  form.elements.empresa_principal.innerHTML = [
    '<option value="">Sem empresa principal</option>',
    ...selectedCompanies.map((empresa) => `<option value="${esc(empresa.id)}" ${String(empresa.id) === String(primary) ? 'selected' : ''}>${esc(empresa.nome)}</option>`)
  ].join('');

  const currencies = [...new Set(selectedCompanies.map((empresa) => empresa.moeda_base || 'BRL'))];
  const target = $('[data-user-currencies]', form);
  if (!target) return;
  const hasBusiness = ['empresarial', 'ambos'].includes(form.elements.workspaces?.value || 'ambos');
  target.innerHTML = `
    <span>${hasBusiness ? 'Moedas empresariais' : 'Vinculos empresariais'}</span>
    <div>${(currencies.length ? currencies : ['BRL']).map(moedaChip).join('')}</div>
    <small>${!hasBusiness
      ? 'Estes vínculos ficam guardados, mas não são usados no acesso Somente pessoal.'
      : currencies.length
      ? 'Herdadas das empresas selecionadas. Altere a moeda-base no cadastro da empresa.'
      : 'Selecione uma empresa para definir o acesso empresarial.'}</small>`;
}

function openConfirm({ title, message, confirmLabel = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const previous = document.activeElement;
    const layer = document.createElement('div');
    layer.className = 'admin-confirm-layer';
    layer.innerHTML = `
      <div class="modal-backdrop">
        <section class="modal-card is-confirm" role="dialog" aria-modal="true" aria-labelledby="admin-confirm-title" tabindex="-1">
          <header class="modal-header">
            <h2 class="modal-title" id="admin-confirm-title">${esc(title)}</h2>
          </header>
          <div class="modal-body">
            <p>${esc(message)}</p>
          </div>
          <footer class="modal-footer">
            <button class="btn btn-ghost" type="button" data-confirm="cancel">Cancelar</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-confirm="ok">${esc(confirmLabel)}</button>
          </footer>
        </section>
      </div>`;
    root.appendChild(layer);
    const done = (value) => {
      layer.remove();
      resolve(value);
      if (previous && typeof previous.focus === 'function') requestAnimationFrame(() => previous.focus());
    };
    layer.addEventListener('click', function handler(event) {
      const action = event.target.closest('[data-confirm]')?.dataset.confirm;
      if (!action) return;
      layer.removeEventListener('click', handler);
      done(action === 'ok');
    });
    layer.addEventListener('keydown', function keyHandler(event) {
      if (event.key !== 'Escape') return;
      layer.removeEventListener('keydown', keyHandler);
      done(false);
    });
    $('.modal-card', layer).focus();
  });
}

function toast(message, kind = 'ok') {
  const root = $('#toast-root');
  root.replaceChildren();
  const el = document.createElement('div');
  el.className = `admin-toast ${kind === 'error' ? 'is-error' : ''}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 180);
  }, 3200);
}

function icon(name) {
  const paths = {
    grid: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
    building: '<path d="M4 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2M2 21h20"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    wallet: '<path d="M3 7h15a3 3 0 0 1 3 3v8H6a3 3 0 0 1-3-3zM3 7V5a2 2 0 0 1 2-2h12v4M17 13h.01"/>',
    tags: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01"/>',
    refresh: '<path d="M20 12a8 8 0 0 1-14.9 4M4 12A8 8 0 0 1 18.9 8M19 4v4h-4M5 20v-4h4"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    search: '<path d="m21 21-4.3-4.3M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15z"/>',
    alert: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    clipboard: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1zM8 6H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2M9 13l2 2 4-4"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14zM10 11v6M14 11v6"/>',
    link: '<path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8"/>'
  };
  return `<svg class="admin-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
}
