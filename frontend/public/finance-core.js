// ============================================================================
// finance-core.js — estado global + constantes + helpers do CF Finance
// ----------------------------------------------------------------------------
// Sem framework, sem build. Mutar `state.x = y` e chamar `renderApp()`.
// ============================================================================

import { api, apiFetch } from './security-client.js?v=20260727-finance-v87';
import { soma, sub } from './lib/money.js?v=20260727-finance-v87';

export const API_ORIGIN = window.__CF_API_ORIGIN__ || 'https://apifinanceiro.cfsistema.site';
export const UI_PREFS_KEY = 'cf-finance-ui-prefs-v1';
// Ambiente inicial antes do boot resolver o acesso real do usuario (workspaces
// em FinanceUser: 'pessoal' | 'empresarial' | 'ambos') — ver boot() em
// app-hotfix.js, que ajusta state.workspace assim que /auth/me responde.
export const DEFAULT_WORKSPACE = 'empresarial';
export const DEFAULT_VIEW = 'dashboard';

// Usuario "hibrido": tem acesso aos dois ambientes (Pessoal e Empresarial).
// So esse perfil ve o botao de alternar — os demais ficam fixos no unico
// ambiente que `workspaces` permite (ver admin.js: campo "Areas de acesso").
export function isHybridUser() {
  return state.currentUser?.workspaces === 'ambos';
}

export function canWriteFinance() {
  // Ambiente Pessoal DELEGADO com permissao 'visualizar': somente leitura,
  // mesmo que o gestor seja admin — o backend ja aplica essa regra primeiro
  // que o bypass de admin (requireFinanceWriteAccess), a UI precisa espelhar.
  const ambiente = state.currentUser?.ambiente;
  if (ambiente?.owner_id && ambiente.permissao !== 'operar') return false;
  return state.currentUser?.role === 'admin' || (state.currentUser?.access_level || 'operacao') === 'operacao';
}

// === Estado global ===
export const state = {
  ready: false,
  bootError: null,        // mensagem de falha de conexão no boot (tela de erro)
  health: null,
  currentUser: null,
  workspace: DEFAULT_WORKSPACE,
  activeNav: DEFAULT_VIEW,
  userpanelOpen: true,     // painel lateral "Contas que eu comando" (delegação)
  filters: {
    transacoes: 'todas',     // todas | receitas | despesas
    transacoesCategoria: null, // id de categoria p/ "Ver lançamentos" (null => todas)
    transacoesConta: null,   // id de conta p/ "Ver movimentações" (null => todas)
    // Tela Categorias (filtros locais, em memória — não chamam o backend)
    categorias: { busca: '', natureza: 'todas', comportamento: 'todas', grupo: 'todas', status: 'todas', uso: 'todas' },
    aReceber:   'todos',
    dreMes:     null,        // YYYY-MM selecionado no DRE (null => mês corrente)
    despVarMes: null,        // YYYY-MM selecionado em Despesas Variáveis
    // Dashboard empresarial (cascata tipo DRE)
    dashMes:        null,    // YYYY-MM da cascata (null => mês corrente)
    // Período do dashboard (KPIs receitas/despesas/lucro). Persistido no backend
    // por empresa/usuário/escopo via /dashboard-config. tipo 'mes' = mês corrente
    // (default); 'custom' = intervalo livre dia-a-dia (dataInicio..dataFim).
    dashPeriodo:    { tipo: 'mes', dataInicio: null, dataFim: null },
    dashCalendarOpen: false,
    dashCalendarYear: null,
    dashExpanded:   {},      // { [chaveDoNó]: true } — seções expandidas
    // Inadimplência (dashboard)
    inadMinDias:    30,      // atraso mínimo p/ contar como inadimplência ("1 mês")
    inadDataInicio: null,    // recorte de período por vencimento (YYYY-MM-DD)
    inadDataFim:    null,
    lixeiraEntidade: 'todas', // filtro local da tela Lixeira (ver lixeiraFiltrada)
    lixeiraGlobal:   false    // dono: alterna entre "meu ambiente" e "todas as empresas"
  },
  modal: null,
  dialog: null,            // diálogo interno (confirm/prompt) — substitui window.confirm/alert/prompt
  toasts: [],
  pending: {},
  fieldErrors: {},
  // Dashboard modular (layout editável de widgets)
  dashEdit: false,          // modo edição do layout (não persistido)
  dashAddOpen: false,       // paleta "adicionar card" aberta
  dashLayout: {},           // { empresarial: Array<{uid,type,w,h}>, pessoal: [...] } — persistido
  dashProfiles: {},         // { empresarial: {nome: Item[]}, pessoal: {...} } — persistido
  dashCambioResults: {},    // { [widgetUid]: { status, data?, error? } } — somente na sessão
  // Empresa ativa (multi-empresa). Default = empresa do usuario logado.
  activeEmpresaId: null,
  pricing: {
    loaded: false, loading: false, error: '', items: [], categories: [], functions: [], config: null,
    search: '', typeFilter: '', selected: null, editor: null, tab: 'dados', management: false,
    dirty: false, result: null
  },
  // Dados crus do backend
  data: {
    empresas:      [],   // Empresa (lista p/ seletor — admin)
    contas:        [],   // FinContaBancaria
    categorias:    [],   // FinCategoria
    transacoes:    [],   // FinTransacao (últimas 50)
    contasReceber: [],   // FinContaReceber
    contasPagar:   [],   // FinContaPagar
    dividas:       [],   // FinDividaPessoal
    metas:         [],   // FinMeta
    orcamentos:    [],   // FinOrcamento (mês corrente)
    dashboard:     null, // /relatorios/dashboard
    currency:      { moeda_base: 'BRL', moeda_incompleta: false },
    dre:           null, // /relatorios/dre (legado — não usado pela view nova)
    dreCache:      {},   // { 'YYYY-MM': respostaDRE } — cache por mês
    despVar:       {},   // { 'YYYY-MM': agregado de despesas variáveis } — cache por mês
    fluxo:         null, // /relatorios/fluxo-de-caixa (realizado 30d)
    financeUsers:  [],   // admin only
    lixeira:       []    // FinLixeira do ambiente ativo (ou global, p/ o dono)
  }
};

// === Navegação ===
export const NAV_PESSOAL = [
  { section: 'Pessoal', items: [
    { id: 'dashboard',  label: 'Dashboard',  icon: 'square-grid' },
    { id: 'transacoes', label: 'Transações', icon: 'arrows-vert' },
    { id: 'contas',     label: 'Contas',     icon: 'wallet' },
    { id: 'categorias', label: 'Categorias', icon: 'tags' },
    { id: 'orcamento',  label: 'Orçamento',  icon: 'pie' },
    { id: 'dividas',    label: 'Dívidas',    icon: 'card' },
    { id: 'metas',      label: 'Metas',      icon: 'flag' },
    { id: 'pendencias', label: 'Pendências', icon: 'shield' },
    { id: 'lixeira',    label: 'Lixeira',    icon: 'trash' }
  ]}
];

// 'Empresa' e placeholder: renderSidebar troca pelo nome da empresa ativa.
export const NAV_EMPRESARIAL = [
  { section: 'Empresa', items: [
    { id: 'dashboard', label: 'Dashboard',      icon: 'square-grid' },
    { id: 'contas',    label: 'Contas',         icon: 'wallet' },
    { id: 'categorias',label: 'Categorias',     icon: 'tags' },
    { id: 'receber',   label: 'A Receber',      icon: 'down' },
    { id: 'pagar',     label: 'A Pagar',        icon: 'up' },
    { id: 'fluxo',     label: 'Fluxo de caixa', icon: 'flow' }
  ]},
  { section: 'Análise', items: [
    { id: 'precificacao',        label: 'Precificação',       icon: 'tag-price' },
    { id: 'despesas-variaveis', label: 'Despesas Variáveis', icon: 'pie' },
    { id: 'dre',                label: 'DRE',                icon: 'chart' },
    { id: 'pendencias',         label: 'Pendências',         icon: 'shield' },
    { id: 'lixeira',            label: 'Lixeira',            icon: 'trash' }
  ]}
];

export const NAV_ADMIN = {
  section: 'Administração',
  items: [
    { id: 'admin', label: 'Painel administrativo', icon: 'shield', href: './admin.html' }
  ]
};

// === Formatadores ===
// Moedas suportadas (ISO 4217) — espelha a whitelist do backend (security/cambio.js).
export const MOEDAS = [
  { code: 'BRL', simbolo: 'R$',  nome: 'Real brasileiro' },
  { code: 'USD', simbolo: 'US$', nome: 'Dólar americano' },
  { code: 'EUR', simbolo: '€',   nome: 'Euro' },
  { code: 'GBP', simbolo: '£',   nome: 'Libra esterlina' },
  { code: 'JPY', simbolo: '¥',   nome: 'Iene japonês' },
  { code: 'CHF', simbolo: 'CHF', nome: 'Franco suíço' },
  { code: 'CAD', simbolo: 'C$',  nome: 'Dólar canadense' },
  { code: 'AUD', simbolo: 'A$',  nome: 'Dólar australiano' },
  { code: 'CNY', simbolo: '¥',   nome: 'Yuan chinês' },
  { code: 'MXN', simbolo: 'MX$', nome: 'Peso mexicano' }
];
const MOEDA_SIMBOLO = Object.fromEntries(MOEDAS.map((m) => [m.code, m.simbolo]));

export function moedaAtiva() {
  return String(
    state.data.dashboard?.moeda_base
    || state.data.fluxo?.moeda_base
    || state.data.currency?.moeda_base
    || 'BRL'
  ).toUpperCase();
}

export function moedaIncompleta() {
  return Boolean(
    state.data.dashboard?.moeda_incompleta
    || state.data.fluxo?.moeda_incompleta
    || state.data.currency?.moeda_incompleta
  );
}

// Cache de Intl.NumberFormat por moeda (criar formatter é caro).
const _fmtCache = new Map();
function fmtFor(moeda) {
  const code = (moeda || 'BRL').toUpperCase();
  if (!_fmtCache.has(code)) {
    try {
      _fmtCache.set(code, new Intl.NumberFormat('pt-BR', { style: 'currency', currency: code }));
    } catch {
      _fmtCache.set(code, new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }));
    }
  }
  return _fmtCache.get(code);
}

export function formatCurrency(n, moeda = moedaAtiva()) {
  const v = Number(n);
  const fmt = fmtFor(moeda);
  return fmt.format(Number.isFinite(v) ? v : 0);
}

// Formata um registro monetário na MOEDA-BASE de exibição (a moeda padrão do
// usuário / consolidação do ambiente). Usa o campo já convertido pelo backend
// (`<campo>_base`); cai no valor nominal só como defesa — nesse caso o backend
// também sinaliza moeda_incompleta e a UI mostra o aviso de câmbio.
export function formatCurrencyBase(row, campo = 'valor') {
  if (row == null) return formatCurrency(0, moedaAtiva());
  const base = row[`${campo}_base`];
  return formatCurrency(base != null ? base : row[campo], moedaAtiva());
}

// Rótulo discreto com o valor ORIGINAL quando a moeda do registro difere da base
// de exibição — preserva a verdade ("isto foi € 10,00") sem quebrar a
// consistência visual. Vazio quando a moeda já é a base (nada a mostrar).
export function originalCurrencyHint(row, campo = 'valor') {
  const base = moedaAtiva();
  const moeda = String(row?.moeda || base).toUpperCase();
  if (moeda === base || row == null || row[`${campo}_base`] == null) return '';
  return formatCurrency(row[campo], moeda);
}

export function formatCurrencyShort(n, moeda = moedaAtiva()) {
  const v = Number(n);
  const fmt = fmtFor(moeda);
  if (!Number.isFinite(v)) return fmt.format(0);
  if (Math.abs(v) >= 1000) {
    const simbolo = MOEDA_SIMBOLO[(moeda || 'BRL').toUpperCase()] || 'R$';
    return simbolo + ' ' + (v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'k';
  }
  return fmt.format(v);
}

export function formatPercent(n, digits = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0%';
  return `${v.toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}%`;
}

export function formatDateBR(s) {
  if (!s) return '-';
  // As datas chegam como 'YYYY-MM-DD' ou ISO 'YYYY-MM-DDTHH:mm:ss.sssZ'.
  // Tratamos como date-only: extrair Y-M-D direto da string evita o recuo de
  // 1 dia que `new Date(...).toLocaleDateString` causa ao converter a meia-noite
  // UTC para o fuso local (UTC-3 vira 21h do dia anterior).
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function todayInputValue() {
  return dateToInput(new Date());
}

// Deriva "YYYY-MM-DD" no fuso LOCAL. NUNCA usar toISOString().slice(0,10) pra data
// de lançamento/agrupamento — converte pra UTC e no Brasil (UTC-3) um horário
// noturno pode cair no dia seguinte (D10 do SDD-UPDATE-cf-finance.md).
export function dateToInput(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// === UI prefs ===
export function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

export function saveUiPrefs(patch) {
  const prev = loadUiPrefs();
  const next = { ...prev, ...patch };
  try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}

// === Toasts ===
let toastSeq = 0;
export function pushToast(message, kind = 'info', ttl = 3500, { toastOnly = false } = {}) {
  const id = ++toastSeq;
  state.toasts.push({ id, message: String(message), kind });
  const render = () => {
    if (toastOnly && typeof window.__renderToasts === 'function') window.__renderToasts();
    else if (typeof window.__renderApp === 'function') window.__renderApp();
  };
  render();
  setTimeout(() => {
    state.toasts = state.toasts.filter((t) => t.id !== id);
    render();
  }, ttl);
  return id;
}

// === Diálogos internos (substituem window.confirm/alert/prompt) ===
// Retornam Promise: appConfirm → boolean; appPrompt → string|null. O diálogo é
// renderizado pelo renderApp (camada própria) e resolvido por dialog-ok/cancel.
export function appConfirm({ title, description = '', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', variant = 'default' } = {}) {
  return new Promise((resolve) => {
    state.dialog = { kind: 'confirm', title, description, confirmLabel, cancelLabel, variant, _resolve: resolve };
    if (typeof window.__renderApp === 'function') window.__renderApp();
  });
}
export function appPrompt({ title, label = '', placeholder = '', value = '', confirmLabel = 'Salvar', cancelLabel = 'Cancelar' } = {}) {
  return new Promise((resolve) => {
    state.dialog = { kind: 'prompt', title, label, placeholder, value, confirmLabel, cancelLabel, variant: 'default', _resolve: resolve };
    if (typeof window.__renderApp === 'function') window.__renderApp();
  });
}
export function resolveDialog(result) {
  const d = state.dialog;
  state.dialog = null;
  if (typeof window.__renderApp === 'function') window.__renderApp();
  d?._resolve?.(result);
}

// === Carregamento de dados REAIS ===

/** Carrega TUDO necessário pros 2 workspaces. Cada chamada protegida com catch
 *  individual pra não derrubar tudo se 1 endpoint falhar. */
// Monta os params de período do dashboard a partir de state.filters.dashPeriodo.
// Só manda data_inicio/data_fim quando o modo é 'custom' e ambas as datas existem;
// caso contrário o backend cai no default (mês corrente).
function dashboardPeriodoParams() {
  const p = state.filters.dashPeriodo;
  if (p?.tipo === 'custom' && p.dataInicio && p.dataFim) {
    return { data_inicio: p.dataInicio, data_fim: p.dataFim };
  }
  return {};
}

// Carrega a preferência de período salva do escopo ativo e aplica em
// state.filters.dashPeriodo. Silencioso em erro (mantém o default mês corrente).
export async function loadDashboardConfig() {
  const escopo = state.workspace === 'empresarial' ? 'empresarial' : 'pessoal';
  try {
    const resp = await api.dashboardConfig({ escopo });
    const cfg = resp?.config || {};
    if (cfg.tipo === 'custom' && cfg.dataInicio && cfg.dataFim) {
      state.filters.dashPeriodo = { tipo: 'custom', dataInicio: cfg.dataInicio, dataFim: cfg.dataFim };
    } else {
      state.filters.dashPeriodo = { tipo: 'mes', dataInicio: null, dataFim: null };
    }
  } catch (e) {
    logErr('dashboard-config', e);
  }
  return state.filters.dashPeriodo;
}

// Recarrega só o /dashboard com o período atual (usado ao trocar o período sem
// refazer o loadAllData inteiro). Atualiza state.data.dashboard in-place.
export async function reloadDashboard() {
  const escopo = state.workspace === 'empresarial' ? 'empresarial' : 'pessoal';
  try {
    state.data.dashboard = await api.dashboard({ escopo, ...dashboardPeriodoParams() });
    state.data.currency = {
      moeda_base: state.data.dashboard?.moeda_base || state.data.currency?.moeda_base || 'BRL',
      moeda_incompleta: Boolean(state.data.dashboard?.moeda_incompleta)
    };
  } catch (e) {
    logErr('dashboard', e);
  }
  return state.data.dashboard;
}

export async function loadAllData() {
  const escopo = state.workspace === 'empresarial' ? 'empresarial' : 'pessoal';
  // Período do dashboard: carrega a preferência salva antes de bater no /dashboard,
  // pra que os KPIs já venham no intervalo escolhido (default: mês corrente).
  await loadDashboardConfig();
  const [
    contas,
    categorias,
    transacoesResp,
    receber,
    pagar,
    dividasResp,
    metas,
    dashboard
  ] = await Promise.all([
    api.contas({ escopo })                 .catch((e) => { logErr('contas', e);          return []; }),
    api.categorias({ escopo })             .catch((e) => { logErr('categorias', e);      return []; }),
    api.transacoes({ limit: 50, escopo })  .catch((e) => { logErr('transacoes', e);      return { transacoes: [], total: 0 }; }),
    escopo === 'empresarial'
      ? api.contasReceber({ escopo }).catch((e) => { logErr('contas-receber', e); return { contas: [] }; })
      : Promise.resolve({ contas: [] }),
    escopo === 'empresarial'
      ? api.contasPagar({ escopo }).catch((e) => { logErr('contas-pagar', e); return { contas: [] }; })
      : Promise.resolve({ contas: [] }),
    escopo === 'pessoal'
      ? api.dividas().catch((e) => { logErr('dividas', e); return { dividas: [] }; })
      : Promise.resolve({ dividas: [] }),
    escopo === 'pessoal'
      ? api.metas().catch((e) => { logErr('metas', e); return []; })
      : Promise.resolve([]),
    api.dashboard({ escopo, ...dashboardPeriodoParams() }).catch((e) => { logErr('dashboard', e); return null; })
  ]);

  state.data.contas        = Array.isArray(contas) ? contas : (contas?.contas || []);
  state.data.categorias    = Array.isArray(categorias) ? categorias : [];
  state.data.transacoes    = transacoesResp?.transacoes || [];
  state.data.contasReceber = receber?.contas  || [];
  state.data.contasPagar   = pagar?.contas    || [];
  state.data.dividas       = dividasResp?.dividas || [];
  state.data.metas         = Array.isArray(metas) ? metas : (metas?.metas || []);
  state.data.dashboard     = dashboard || null;
  state.data.currency      = {
    moeda_base: dashboard?.moeda_base || transacoesResp?.moeda_base || receber?.moeda_base || pagar?.moeda_base || 'BRL',
    moeda_incompleta: Boolean(
      dashboard?.moeda_incompleta
      || transacoesResp?.moeda_incompleta
      || receber?.moeda_incompleta
      || pagar?.moeda_incompleta
    )
  };

  // Invalida caches derivados do dashboard empresarial (cashflow6m, donut, recentes).
  // Força o seedDashboardData() a reconstruir a partir dos dados frescos — fecha o ciclo
  // lançamento otimista → reconciliação. Ver views/dashboard-store.js.
  state.data.cashflow6m       = null;
  state.data.expenseBreakdown = null;
  state.data.variableRecent   = null;
  state.data.despVar          = {};   // recarrega despesas variáveis por mês na próxima visita
  // Invalida o cache do DRE também: a cascata "Resultado do mês" do dashboard e a
  // view DRE leem state.data.dreCache[mes]. Sem isso, criar/baixar um recebimento
  // ou pagamento não refletia no resultado ("lancei e não veio pra cá"). Zerado
  // aqui, o próximo render chama ensureDre() e busca os números atualizados.
  state.data.dreCache         = {};

  // Orçamento do mês corrente
  const hoje = new Date();
  const mes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
  try {
    const orc = await api.orcamentos(mes);
    state.data.orcamentos = Array.isArray(orc) ? orc : (orc?.orcamentos || []);
  } catch (e) {
    logErr('orcamentos', e);
    state.data.orcamentos = [];
  }
}

function logErr(scope, e) {
  console.warn(`[load:${scope}]`, e?.status || '', e?.message || e);
}

/** Carrega lista de empresas pro seletor multi-empresa. Só admin. */
export async function loadEmpresas() {
  try {
    const empresas = await api.empresas();
    state.data.empresas = Array.isArray(empresas) ? empresas : [];
  } catch (err) {
    state.data.empresas = [];
    if (err.status !== 403 && err.status !== 401) {
      console.warn('[loadEmpresas]', err.message);
    }
  }
  return state.data.empresas;
}

/** Carrega lista de FinanceUser. Só admin. */
export async function loadFinanceUsers() {
  try {
    const users = await apiFetch('/api/finance/users', { silent401: true });
    state.data.financeUsers = Array.isArray(users) ? users : [];
  } catch (err) {
    state.data.financeUsers = [];
    if (err.status !== 403 && err.status !== 401) {
      console.warn('[loadFinanceUsers]', err.message);
    }
  }
  return state.data.financeUsers;
}

// Carrega a Lixeira do ambiente ativo (ou global, se o dono ligou o toggle).
// Chamado ao entrar na view (change-view) — não faz parte do loadAllData
// principal pra não pesar o boot com uma tela que a maioria nunca abre.
export async function loadLixeira() {
  try {
    const resp = state.filters.lixeiraGlobal && state.currentUser?.is_owner
      ? await api.lixeiraGlobal({ limit: 200 })
      : await api.lixeira({ limit: 200 });
    state.data.lixeira = Array.isArray(resp?.itens) ? resp.itens : [];
  } catch (err) {
    state.data.lixeira = [];
    console.warn('[loadLixeira]', err.message);
  }
  return state.data.lixeira;
}

export function lixeiraFiltrada() {
  const f = state.filters.lixeiraEntidade;
  const list = state.data.lixeira || [];
  if (!f || f === 'todas') return list;
  return list.filter((item) => item.entidade === f);
}

export async function loadPricingData({ force = false } = {}) {
  const pricing = state.pricing;
  if (pricing.loading || (pricing.loaded && !force)) return pricing;
  pricing.loading = true;
  pricing.error = '';
  if (typeof window.__renderApp === 'function') window.__renderApp();
  try {
    const [config, categories, functions, items] = await Promise.all([
      api.pricingConfig(), api.pricingCategories(), api.pricingFunctions(), api.pricingItems()
    ]);
    pricing.config = config;
    pricing.categories = Array.isArray(categories) ? categories : [];
    pricing.functions = Array.isArray(functions) ? functions : [];
    pricing.items = Array.isArray(items) ? items : [];
    pricing.loaded = true;
  } catch (error) {
    pricing.error = error?.message || 'Falha ao carregar precificação.';
  } finally {
    pricing.loading = false;
  }
  return pricing;
}

// === Deriva totais a partir de data ===

/** Contas visíveis no workspace ativo. Contas sem `escopo` (legado) contam como
 *  pessoais — coerente com o DEFAULT 'pessoal' da coluna no banco. */
export function contasDoWorkspace(ws = state.workspace) {
  const alvo = ws === 'empresarial' ? 'empresarial' : 'pessoal';
  // Esconde contas excluidas (soft-delete, ativo=0) — defesa no cliente, casando
  // com o filtro padrao do backend (GET /contas-bancarias só traz ativas).
  return (state.data.contas || [])
    .filter((c) => c.ativo !== 0)
    .filter((c) => (c.escopo || 'pessoal') === alvo);
}

export function saldoTotal() {
  const consolidado = Number(state.data.dashboard?.saldo_total);
  if (Number.isFinite(consolidado)) return consolidado;
  const contas = contasDoWorkspace();
  const moedas = new Set(contas.map((conta) => String(conta.moeda || moedaAtiva()).toUpperCase()));
  if (moedas.size > 1) return 0;
  return soma(contas, (c) => c.saldo || 0);
}

export function receitasMes() {
  return Number(state.data.dashboard?.mes_atual?.receitas || 0);
}

export function despesasMes() {
  return Number(state.data.dashboard?.mes_atual?.despesas || 0);
}

export function totalDividas() {
  return soma(state.data.dividas || [], (d) => d.saldo_devedor || 0);
}

// saldo_base = valor já convertido pra moeda-base pelo backend; fallback local
// só quando ausente. money.soma() garante a soma sem erro de float.
function saldoEmAberto(c) {
  return Number.isFinite(Number(c.saldo_base))
    ? Number(c.saldo_base)
    : sub(c.valor, c.valor_pago || 0);
}

export function totalReceber() {
  return soma(
    (state.data.contasReceber || []).filter((c) => c.status === 'pendente' || c.status === 'vencido' || c.status === 'parcial'),
    saldoEmAberto
  );
}

export function totalPagar() {
  return soma(
    (state.data.contasPagar || []).filter((c) => c.status === 'pendente' || c.status === 'vencido' || c.status === 'parcial'),
    saldoEmAberto
  );
}

// Ordena por data desc, desempate por id (Array.sort é estável — ES2019+). Não
// confia na ordem do backend (D10.c do SDD): listagem e widgets de "últimas
// transações" chamam isto em vez de usar state.data.transacoes cru.
export function sortTransacoesDesc(list) {
  return [...(list || [])].sort((a, b) => {
    const cmp = String(b.data || '').localeCompare(String(a.data || ''));
    if (cmp !== 0) return cmp;
    return String(b.id ?? '').localeCompare(String(a.id ?? ''));
  });
}

export function transacoesFiltradas() {
  const f = state.filters.transacoes;
  const catId = state.filters.transacoesCategoria;
  const contaId = state.filters.transacoesConta;
  let list = state.data.transacoes || [];
  // "Ver lançamentos" da tela Categorias recorta por uma categoria específica.
  if (catId) list = list.filter((t) => String(t.categoria_id) === String(catId));
  // "Ver movimentações" da tela Contas recorta por uma conta específica.
  if (contaId) list = list.filter((t) => String(t.conta_id) === String(contaId));
  if (f === 'receitas') list = list.filter((t) => t.tipo === 'receita');
  else if (f === 'despesas') list = list.filter((t) => t.tipo === 'despesa');
  return sortTransacoesDesc(list);
}

export function categoriasFor(tipo /* receita|despesa */) {
  return (state.data.categorias || []).filter((c) => {
    if (!c.ativo) return false;
    // categorias usam tipo: pessoal | empresarial | ambos — não receita/despesa.
    // Filtramos só por ativas. O usuário escolhe livremente.
    return true;
  });
}

/** Categorias visíveis no workspace ativo. Segrega por escopo pra evitar que um
 *  lançamento Pessoal use categoria Empresarial (e vice-versa) — o que deixava
 *  os relatórios empresariais (DRE / Fluxo) zerados. `ambos` aparece nos dois. */
export function categoriasDoWorkspace(ws = state.workspace) {
  const alvo = ws === 'empresarial' ? 'empresarial' : 'pessoal';
  return (state.data.categorias || []).filter((c) => {
    if (c.ativo === 0) return false;
    const t = c.tipo || 'pessoal';
    return t === alvo || t === 'ambos';
  });
}
