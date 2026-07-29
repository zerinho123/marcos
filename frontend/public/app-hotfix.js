// ============================================================================
// app-hotfix.js — boot + handlers globais do CF Finance
// ----------------------------------------------------------------------------
// Boot: confere sessão, carrega TUDO da API real, dispara render.
// Handlers: [data-action] delegado no document. Cada action recebe (param, el, evt).
// ============================================================================

import {
  state, loadAllData, loadFinanceUsers, loadEmpresas, loadPricingData, loadLixeira, reloadDashboard,
  pushToast, saveUiPrefs, loadUiPrefs, todayInputValue, dateToInput, formatCurrency, moedaAtiva,
  contasDoWorkspace, categoriasDoWorkspace, isHybridUser, canWriteFinance,
  appConfirm, appPrompt, resolveDialog
} from './finance-core.js?v=20260727-finance-v87';
import { renderApp } from './finance-render.js?v=20260727-finance-v87';
import { me, logout, apiFetch, api, setActiveEmpresa, trocarAmbiente } from './security-client.js?v=20260727-finance-v87';
import { isVariavel } from './views/despesa-classificacao.js?v=20260727-finance-v87';
import {
  dashAddWidget, dashRemoveWidget, dashMoveWidget, dashPreviewPlacement, dashSetWidgetSize,
  dashSetGridColumns, dashOrganizeLayout, dashSetNota, dashResetLayout, dashApplyPreset,
  dashSaveProfile, dashLoadProfile, dashDeleteProfile, dashGetCambioConfig,
  dashSetCambioConfig, dashSwapCambio, getLayout
} from './views/dashboard-modular.js?v=20260727-finance-v87';
import { dreColumnsToggle, dreColumnsMove } from './views/dre-view.js?v=20260727-finance-v87';
import { testDataCandidates } from './views/pendencias-view.js?v=20260727-finance-v87';

const curWs = () => (state.workspace === 'empresarial' ? 'empresarial' : 'pessoal');
const curDashColumns = () => Number.parseInt(document.querySelector('.dash-mod-grid')?.dataset.dashColumns, 10) || 4;

let modalSubmitInFlight = false;
let modalOpener = null;

function rememberModalOpener(el) {
  if (!el) return;
  modalOpener = {
    action: el.getAttribute('data-action') || '',
    param: el.getAttribute('data-param') || ''
  };
}

function restoreModalFocus() {
  if (!modalOpener) return;
  const target = [...document.querySelectorAll('[data-action]')].find((el) =>
    el.getAttribute('data-action') === modalOpener.action
      && (el.getAttribute('data-param') || '') === modalOpener.param
  );
  modalOpener = null;
  target?.focus?.();
}

function modalFocusables() {
  const dialog = document.querySelector('#modal-backdrop .modal-card');
  if (!dialog) return [];
  return [...dialog.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((el) => el.getAttribute('aria-hidden') !== 'true');
}

function scheduleModalFocus(preferredName = '') {
  requestAnimationFrame(() => {
    const dialog = document.querySelector('#modal-backdrop .modal-card');
    if (!dialog) return;
    const preferred = preferredName
      ? dialog.querySelector(`[name="${preferredName.replace(/"/g, '\\"')}"]`)
      : null;
    const target = preferred || dialog.querySelector('[autofocus]') || modalFocusables()[0] || dialog;
    target.focus();
  });
}

function closeModal() {
  state.modal = null;
  state.fieldErrors = {};
  modalSubmitInFlight = false;
  renderApp();
  requestAnimationFrame(restoreModalFocus);
}

function syncModalForm(form) {
  if (!form || !state.modal) return;
  const next = { ...(state.modal.form || {}) };
  for (const field of form.elements) {
    if (!field.name || field.type === 'password') continue;
    if (field.type === 'radio') {
      if (field.checked) next[field.name] = field.value;
      continue;
    }
    next[field.name] = field.type === 'checkbox' ? field.checked : field.value;
  }
  state.modal.form = next;
}

function setModalError(message = '') {
  const slot = document.querySelector('#modal-backdrop .modal-error-slot');
  if (slot) slot.textContent = message;
}

function setModalSubmitting(form, submitting) {
  form?.setAttribute('aria-busy', submitting ? 'true' : 'false');
  const button = form?.querySelector('button[type="submit"]');
  if (button) button.disabled = submitting;
}

function actionOpensModal(action) {
  return action.startsWith('open-modal-') || action === 'marcar-recebido' || action === 'marcar-pago';
}

// === Boot ===
async function boot() {
  const prefs = loadUiPrefs();
  if (prefs.activeNav) state.activeNav = prefs.activeNav;
  if (prefs.dreMes) state.filters.dreMes = prefs.dreMes;
  if (prefs.dashLayout && typeof prefs.dashLayout === 'object') state.dashLayout = prefs.dashLayout;
  if (prefs.dashProfiles && typeof prefs.dashProfiles === 'object') state.dashProfiles = prefs.dashProfiles;
  if (prefs.userpanelOpen != null) state.userpanelOpen = prefs.userpanelOpen !== false;

  try {
    const user = await me();
    if (!user) {
      window.location.replace('./login.html');
      return;
    }
    state.currentUser = user;
    // Empresa ativa: sempre a empresa "dona" do usuario (sem seletor na UI).
    state.activeEmpresaId = user.empresa_id || null;
    // NAO chama setActiveEmpresa ainda: esse valor e sempre a empresa NORMAL,
    // e ate aqui o ambiente ainda nao foi resolvido no backend (pode ser
    // Pessoal). Injetar isso em apiFetch antes do applyAmbiente abaixo fazia
    // requests irem com empresa_id da empresa normal + escopo pessoal — par
    // que nenhuma tela consegue ler de volta. setActiveEmpresa so roda
    // dentro de applyAmbiente(), com o empresa_id que o backend confirmou.

    // Ambiente delegado (gestor comandando a conta Pessoal de terceiro — ver
    // painel lateral): o cookie da sessao pode ja carregar essa claim de uma
    // troca anterior (sobrevive a um F5, dentro da TTL do token). Reconfirma
    // a delegacao no boot (pode ter sido revogada nesse meio-tempo) em vez de
    // simplesmente voltar pro ambiente proprio — senao um F5 tiraria a
    // gestora da conta que ela estava comandando, silenciosamente.
    if (user.ambiente?.owner_id) {
      state.workspace = 'pessoal';
      await applyAmbiente('pessoal', undefined, user.ambiente.owner_id);
    } else {
      // Ambiente inicial conforme o acesso do usuario (FinanceUser.workspaces):
      // 'pessoal'/'empresarial' travam no unico ambiente permitido; 'ambos'
      // (hibrido) restaura a ultima escolha salva, ou cai em empresarial.
      const acesso = user.workspaces || 'ambos';
      if (acesso === 'pessoal') state.workspace = 'pessoal';
      else if (acesso === 'empresarial') state.workspace = 'empresarial';
      else state.workspace = prefs.workspace === 'pessoal' ? 'pessoal' : 'empresarial';

      // Sincroniza o ambiente ativo da sessao (claim no cookie) com o workspace
      // resolvido acima. Sem isso, a sessao continua no default do backend
      // (empresa "dona", empresarial) mesmo que a UI mostre Pessoal — dessincronia
      // silenciosa de contexto entre o que o front pede e o que o back serve.
      // Se o login (Fase 2) ja resolveu e confirmou esse mesmo ambiente, pula o
      // POST /auth/ambiente redundante. `explicito` distingue "sessao resolvida
      // de verdade" do fallback (vinculo inconsistente no login) — no fallback
      // cai no applyAmbiente de sempre, que tambem auto-corrige o vinculo.
      if (user.ambiente?.explicito && user.ambiente.tipo === state.workspace) {
        state.activeEmpresaId = user.ambiente.empresa_id || state.activeEmpresaId;
        setActiveEmpresa(state.activeEmpresaId);
      } else {
        await applyAmbiente(state.workspace, state.workspace === 'empresarial' ? state.activeEmpresaId : undefined);
      }
    }
  } catch (err) {
    if (err.status === 401) {
      window.location.replace('./login.html');
      return;
    }
    // Sem sessão por falha de conexão (rede/CORS/5xx): não adianta carregar dados.
    // Renderiza tela de erro com "Tentar novamente" em vez de girar pra sempre.
    state.bootError = err?.message || 'Falha de conexão com o servidor.';
    state.ready = true;
    renderApp();
    return;
  }

  // Carrega TODOS os dados em paralelo
  try {
    await loadAllData();
    if (state.currentUser?.role === 'admin') {
      await Promise.all([loadFinanceUsers(), loadEmpresas()]);
    }
    if (state.workspace === 'empresarial' && state.activeNav === 'precificacao') {
      await loadPricingData();
    }
  } catch (err) {
    pushToast('Falha ao carregar dados: ' + err.message, 'error');
  }

  state.ready = true;
  renderApp();
}

// === Helper: navega meses no DRE (a view busca/cacheia o mês selecionado) ===
function shiftDreMonth(delta) {
  clearDrePending();
  const cur = state.filters.dreMes
    || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const [y, m] = cur.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.filters.dreMes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  state.filters.dreCalendarOpen = false;
  state.filters.dreCalendarYear = d.getFullYear();
  saveUiPrefs({ dreMes: state.filters.dreMes });
  renderApp();
}

// === Helpers: DRE editável ===
function dreCurrentMes() {
  return state.filters.dreMes
    || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
}
// Escopo do DRE: só admin; undefined = pessoal, 'template' = template da empresa.
function dreScopeParam() {
  return state.currentUser?.role === 'admin' && state.filters.dreScope === 'template' ? 'template' : undefined;
}
function dreScopeKey(mes) {
  return dreScopeParam() === 'template' ? `${mes}@template` : mes;
}

// --- Edição estilo planilha: lote de células (Projetado + Ajuste) ---
function parseDreNum(v) {
  return Number(String(v ?? '').replace(',', '.')) || 0;
}
function drePendingCount() {
  const p = state.filters.drePending || {};
  return Object.keys(p).reduce((n, k) => n + Object.keys(p[k] || {}).length, 0);
}
function clearDrePending() {
  state.filters.drePending = {};
}
// Valores atuais (do servidor) por linha, achatando a estrutura cacheada do DRE.
// Usado no save para enviar SEMPRE plano + ajuste efetivos (o campo não tocado
// preserva o valor atual em vez de ser zerado pelo upsert).
function dreServerValues(mes) {
  const map = {};
  const walk = (rows) => (rows || []).forEach((r) => {
    if (r.linha_id) map[r.linha_id] = { plano: Number(r.plano) || 0, ajuste: Number(r.ajuste) || 0 };
    if (r.itens) walk(r.itens);
  });
  walk(state.data.dreCache?.[dreScopeKey(mes)]?.estrutura);
  return map;
}
// Atualiza o botão Salvar (N) sem re-render — preserva o foco da célula em edição.
function updateDreSaveButton() {
  const count = drePendingCount();
  const saveBtn = document.querySelector('[data-action="dre-save-batch"]');
  const discardBtn = document.querySelector('[data-action="dre-discard"]');
  if (saveBtn) {
    saveBtn.textContent = count ? `Salvar (${count})` : 'Salvar';
    saveBtn.disabled = !count;
    saveBtn.classList.toggle('btn-primary', !!count);
    saveBtn.classList.toggle('btn-ghost', !count);
  }
  if (discardBtn) discardBtn.disabled = !count;
  const foot = document.querySelector('.dre-drawer-foot .muted');
  if (foot) foot.textContent = count ? `${count} alteração(ões) não salva(s)` : 'Sem alterações pendentes';
}

// Atualiza só os números do DRE (sem flash de "Carregando"): busca e troca em cima.
async function refreshDreNumbers() {
  const mes = dreCurrentMes();
  const scope = dreScopeParam();
  try {
    const fresh = await api.dre(mes, scope);
    state.data.dreCache = state.data.dreCache || {};
    state.data.dreCache[dreScopeKey(mes)] = fresh;
  } catch (err) {
    pushToast(err?.message || 'Falha ao recarregar DRE.', 'error');
  }
  renderApp();
}

// Recarrega números + estrutura + config (após criar/renomear/mover/remover linha,
// mapear, trocar escopo ou mexer em colunas).
async function reloadDre() {
  clearDrePending();
  const mes = dreCurrentMes();
  const scope = dreScopeParam();
  try {
    const [fresh, est, cfg] = await Promise.all([api.dre(mes, scope), api.dreEstrutura(scope), api.dreConfig(scope)]);
    state.data.dreCache = state.data.dreCache || {};
    state.data.dreCache[dreScopeKey(mes)] = fresh;
    state.data.dreEstrutura = est;
    state.data.dreConfig = cfg;
  } catch (err) {
    pushToast(err?.message || 'Falha ao recarregar DRE.', 'error');
  }
  renderApp();
}

// Salva o layout de colunas do escopo (otimista: aplica local + render, depois persiste).
async function saveDreConfig(patch) {
  const cur = state.data.dreConfig?.config || {};
  const config = { ...cur, ...patch };
  state.data.dreConfig = { ...(state.data.dreConfig || {}), config };
  renderApp();
  try {
    await api.putDreConfig({ config, scope: dreScopeParam() });
  } catch (err) {
    pushToast(err?.message || 'Falha ao salvar layout das colunas.', 'error');
  }
}

// Acha a linha-computed (por id) no DRE cacheado do escopo atual.
function findDreFormulaRow(id) {
  const dre = state.data.dreCache?.[dreScopeKey(dreCurrentMes())];
  return (dre?.estrutura || []).find((r) => r.id === id) || null;
}

// Nova `ordem` p/ mover uma linha-computed ↑/↓ na cascata (entre vizinhos por ordem).
function dreFormulaNewOrdem(id, dir) {
  const dre = state.data.dreCache?.[dreScopeKey(dreCurrentMes())];
  const rows = [...(dre?.estrutura || [])].sort((a, b) => Number(a.ordem) - Number(b.ordem));
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return null;
  if (dir === 'up') {
    if (i === 0) return Number(rows[0].ordem) - 10;
    const above = Number(rows[i - 1].ordem);
    const above2 = rows[i - 2] != null ? Number(rows[i - 2].ordem) : null;
    return above2 != null ? Math.round((above2 + above) / 2) : above - 1;
  }
  if (i === rows.length - 1) return Number(rows[i].ordem) + 10;
  const below = Number(rows[i + 1].ordem);
  const below2 = rows[i + 2] != null ? Number(rows[i + 2].ordem) : null;
  return below2 != null ? Math.round((below + below2) / 2) : below + 1;
}

async function moveDreLinha(id, dir) {
  const scope = dreScopeParam();
  let est = state.data.dreEstrutura;
  if (!est || est.loading || !Array.isArray(est.linhas)) {
    est = await api.dreEstrutura(scope);
    state.data.dreEstrutura = est;
  }
  const line = (est.linhas || []).find((l) => l.id === id);
  if (!line) return;
  const sibs = (est.linhas || [])
    .filter((l) => l.secao === line.secao)
    .sort((a, b) => (a.ordem - b.ordem) || String(a.nome).localeCompare(String(b.nome)));
  const idx = sibs.findIndex((l) => l.id === id);
  const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= sibs.length) return;
  const other = sibs[swapIdx];
  const a = Number(line.ordem), b = Number(other.ordem);
  if (a === b) {
    await api.putDreLinha(line.id, { ordem: dir === 'up' ? a - 1 : a + 1, scope });
  } else {
    await api.putDreLinha(line.id, { ordem: b, scope });
    await api.putDreLinha(other.id, { ordem: a, scope });
  }
}

// === Helper: navega meses na cascata do Dashboard ===
function shiftDashMonth(delta) {
  const cur = state.filters.dashMes
    || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const [y, m] = cur.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.filters.dashMes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  state.filters.dashCalendarOpen = false;
  state.filters.dashCalendarYear = d.getFullYear();
  renderApp();
}

// === Helper: navega meses em Despesas Variáveis ===
function shiftDespVarMonth(delta) {
  const cur = state.filters.despVarMes
    || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const [y, m] = cur.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.filters.despVarMes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Filtros de categoria/conta são relativos ao período — reseta ao trocar de mês.
  state.filters.despVarCat = '';
  state.filters.despVarConta = '';
  renderApp();
}

// Acha os dados de uma transação p/ edição. A tela de Despesas Variáveis carrega
// até 200 lançamentos por janela (state.data.despVar), além das 50 gerais
// (state.data.transacoes) — então procuramos nos dois.
function findTransacaoForEdit(id) {
  const t = (state.data.transacoes || []).find((x) => x.id === id);
  if (t) return {
    tipo: t.tipo || 'despesa',
    titulo: t.descricao || '',
    valor: Number(t.valor || 0).toFixed(2),
    data: String(t.data || '').slice(0, 10) || todayInputValue(),
    categoria_id: t.categoria_id || '',
    conta_bancaria_id: t.conta_id || t.conta_bancaria_id || ''
  };
  for (const bucket of Object.values(state.data.despVar || {})) {
    const it = (bucket?.lista || []).find((x) => x.id === id);
    if (it) return {
      tipo: 'despesa',
      titulo: it.descricao || '',
      valor: Number(it.valor || 0).toFixed(2),
      data: String(it.data || '').slice(0, 10) || todayInputValue(),
      categoria_id: it.categoria_id || '',
      conta_bancaria_id: it.conta_id || ''
    };
  }
  return null;
}

function defaultContaId(ws = state.workspace) {
  return contasDoWorkspace(ws).find((c) => c.ativo !== 0)?.id || '';
}

// Memória de última conta/categoria por tipo+workspace (D7 do SDD): reabrir "Novo
// lançamento" pré-preenche com o usado da última vez. Guardada em UI prefs.
function lastLancKey(ws, tipo) { return `${ws}:${tipo}`; }

function rememberLancamento(ws, tipo, { categoria_id, conta_bancaria_id }) {
  const prefs = loadUiPrefs();
  const lastLanc = { ...(prefs.lastLanc || {}) };
  lastLanc[lastLancKey(ws, tipo)] = { categoria_id: categoria_id || null, conta_bancaria_id: conta_bancaria_id || null };
  saveUiPrefs({ lastLanc });
}

// Valida existência (e natureza da categoria) antes de aplicar — a lembrada pode
// ter sido excluída/arquivada desde o último lançamento.
function lastLancamentoDefaults(ws, tipo) {
  const saved = (loadUiPrefs().lastLanc || {})[lastLancKey(ws, tipo)];
  if (!saved) return {};
  const catOk = saved.categoria_id
    && categoriasDoWorkspace(ws).some((c) => String(c.id) === String(saved.categoria_id) && (!c.natureza || c.natureza === tipo));
  const contaOk = saved.conta_bancaria_id
    && contasDoWorkspace(ws).some((c) => String(c.id) === String(saved.conta_bancaria_id));
  return {
    categoria_id: catOk ? saved.categoria_id : '',
    conta_bancaria_id: contaOk ? saved.conta_bancaria_id : ''
  };
}

function currentMonthInput() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function defaultPeriod(monthValue = currentMonthInput()) {
  const [year, month] = String(monthValue).slice(0, 7).split('-').map(Number);
  const last = new Date(year, month, 0).getDate();
  return {
    inicio: `${year}-${String(month).padStart(2, '0')}-01`,
    fim: `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultPricingVersion(tipo = 'produto') {
  const config = state.pricing.config || {};
  return {
    numero: 1,
    impostos_pct: Number(config.impostos_pct || 0),
    comissao_pct: Number(config.comissao_pct || 0),
    despesas_variaveis_pct: Number(config.despesas_variaveis_pct || 0),
    margem_padrao_pct: Number(config.margem_padrao_pct ?? 20),
    rateio_tipo: config.rateio_tipo || 'percentual',
    rateio_valor: Number(config.rateio_valor || 0),
    componentes: [{
      tipo: tipo === 'servico' ? 'mao_obra' : 'insumo',
      nome: '', unidade: tipo === 'servico' ? 'hora' : 'unidade', quantidade: 1,
      custo_unitario: 0, perda_pct: 0, funcao_id: null
    }],
    faixas: [{ quantidade_min: 1, quantidade_max: null, custo_ajuste_pct: 0, margem_alvo_pct: Number(config.margem_padrao_pct ?? 20) }]
  };
}

function pricingPayload() {
  const editor = state.pricing.editor;
  if (!editor) throw new Error('Editor de precificação não está aberto.');
  const item = { ...editor.item };
  if (item.unidade === 'personalizada' || item.unidade_personalizada) item.unidade = String(item.unidade_personalizada || '').trim();
  if (!item.nome?.trim()) throw new Error('Informe o nome do item.');
  if (!item.unidade?.trim()) throw new Error('Informe a unidade personalizada.');
  const version = editor.version;
  return {
    item: {
      tipo: item.tipo, nome: item.nome.trim(), codigo: item.codigo?.trim() || null,
      categoria_id: item.categoria_id || null, unidade: item.unidade.trim(),
      descricao: item.descricao?.trim() || null, ativo: item.ativo !== false
    },
    version: {
      item_id: item.id,
      impostos_pct: Number(version.impostos_pct || 0),
      comissao_pct: Number(version.comissao_pct || 0),
      despesas_variaveis_pct: Number(version.despesas_variaveis_pct || 0),
      margem_padrao_pct: Number(version.margem_padrao_pct || 0),
      rateio_tipo: version.rateio_tipo || 'percentual',
      rateio_valor: Number(version.rateio_valor || 0),
      componentes: (version.componentes || []).map((component) => ({
        tipo: component.tipo, nome: component.nome || '', unidade: component.unidade || 'unidade',
        quantidade: Number(component.quantidade), custo_unitario: Number(component.custo_unitario),
        perda_pct: Number(component.perda_pct || 0), funcao_id: component.funcao_id || null
      })),
      faixas: (version.faixas || []).map((range) => ({
        quantidade_min: Number(range.quantidade_min),
        quantidade_max: range.quantidade_max === '' || range.quantidade_max == null ? null : Number(range.quantidade_max),
        custo_ajuste_pct: Number(range.custo_ajuste_pct || 0),
        margem_alvo_pct: Number(range.margem_alvo_pct)
      }))
    }
  };
}

function setPricingPath(path, rawValue) {
  const parts = String(path || '').split('.');
  let target;
  if (['componentes', 'faixas'].includes(parts[0])) target = state.pricing.editor?.version;
  else if (['item', 'version', 'effectiveAt'].includes(parts[0])) target = state.pricing.editor;
  else target = state.pricing;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = /^\d+$/.test(parts[index]) ? Number(parts[index]) : parts[index];
    target = target?.[key];
    if (!target) return;
  }
  const last = /^\d+$/.test(parts.at(-1)) ? Number(parts.at(-1)) : parts.at(-1);
  target[last] = rawValue;
}

function normalizePricingRanges() {
  const ranges = state.pricing.editor?.version?.faixas || [];
  let min = 1;
  ranges.forEach((range, index) => {
    range.quantidade_min = min;
    if (index === ranges.length - 1) range.quantidade_max = null;
    else {
      let max = Number.parseInt(range.quantidade_max, 10);
      if (!Number.isInteger(max) || max < min) max = min + 8;
      range.quantidade_max = max;
      min = max + 1;
    }
  });
}

async function refreshPricing({ keepSelection = false } = {}) {
  const selectedId = keepSelection ? state.pricing.selected?.id || state.pricing.editor?.item?.id : null;
  state.pricing.loaded = false;
  await loadPricingData({ force: true });
  if (selectedId) state.pricing.selected = await api.pricingItem(selectedId);
}

async function savePricingDraft({ quiet = false } = {}) {
  const editor = state.pricing.editor;
  if (!editor || editor.simulationOnly || state.currentUser?.role !== 'admin') return null;
  const payload = pricingPayload();
  if (!editor.item.id) {
    const created = await api.postPricingItem(payload.item);
    editor.item.id = created.id;
    payload.version.item_id = created.id;
  } else {
    await api.putPricingItem(editor.item.id, payload.item);
  }
  if (!editor.version.id) {
    const draft = await api.postPricingDraft(editor.item.id);
    editor.version.id = draft.id;
    editor.version.numero = draft.numero;
  }
  const saved = await api.putPricingVersion(editor.version.id, payload.version);
  state.pricing.result = saved.calculo;
  state.pricing.dirty = false;
  if (!quiet) pushToast('Rascunho salvo.', 'success');
  await refreshPricing();
  return saved;
}

// === Helper: salva o período do dashboard e recarrega só os KPIs ===
// Se o modo é 'custom' mas o intervalo ainda está incompleto/invertido, só
// re-renderiza (mostra os date-pickers) sem bater no backend — evita 400.
async function persistDashPeriodo() {
  const p = state.filters.dashPeriodo;
  if (p.tipo === 'custom') {
    if (!p.dataInicio || !p.dataFim) { renderApp(); return; }
    if (p.dataInicio > p.dataFim) {
      pushToast('A data inicial deve ser anterior ou igual à final.', 'error');
      renderApp();
      return;
    }
  }
  const config = (p.tipo === 'custom')
    ? { tipo: 'custom', dataInicio: p.dataInicio, dataFim: p.dataFim }
    : { tipo: 'mes' };
  const escopo = state.workspace === 'empresarial' ? 'empresarial' : 'pessoal';
  try {
    await api.putDashboardConfig(config, { escopo });
  } catch (err) {
    pushToast('Não foi possível salvar o período: ' + (err?.message || err), 'error');
  }
  await reloadDashboard();
  renderApp();
}

// === Helper: avisa quando um lançamento estoura o orçamento da categoria ===
// O backend (POST/PUT /transacoes) já calcula isso na mesma transação do
// lançamento (routes/transacoes.js:checkOrcamentoEstourado) e devolve
// `orcamento_estourado` no corpo da resposta — aqui só traduz pra um toast.
function notifyOrcamentoEstourado(resp) {
  const o = resp?.orcamento_estourado;
  if (!o) return;
  pushToast(
    `Orçamento de "${o.categoria}" estourado: ${formatCurrency(o.usado)} de ${formatCurrency(o.limite)} (${o.percentual}%).`,
    'warning',
    6000
  );
}

// === Helper: re-fetch + render após mutação ===
async function refreshAll(toastMsg) {
  try {
    await loadAllData();
    renderApp();
    if (toastMsg) pushToast(toastMsg, 'success');
  } catch (err) {
    pushToast('Erro ao recarregar: ' + err.message, 'error');
  }
}

async function cleanupTestDataItem(item) {
  if (!item?.id) return;
  switch (item.tipo) {
    case 'conta':
      await api.putConta(item.id, { ativo: 0 });
      return;
    case 'categoria':
      await api.deleteCategoria(item.id);
      return;
    case 'transacao':
      await api.deleteTransacao(item.id);
      return;
    case 'pagar':
      await api.deleteContaPagar(item.id);
      return;
    case 'receber':
      await api.deleteContaReceber(item.id);
      return;
    case 'divida':
      await api.deleteDivida(item.id);
      return;
    case 'meta':
      await api.deleteMeta(item.id);
      return;
    case 'orcamento':
      await api.deleteOrcamento(item.id);
      return;
    default:
      throw new Error('Tipo de dado de teste desconhecido.');
  }
}

// Troca o ambiente ativo no backend (reemite cookie com a empresa_id certa).
// 'pessoal': backend resolve/cria a empresa pessoal do usuario e devolve o id.
// 'empresarial': empresaId e obrigatorio (a empresa "dona" do usuario, unica
// hoje — nao ha seletor multi-empresa na UI). Falha (rede fora, etc.) NAO
// trava o usuario: cai no modo antigo (so filtro por escopo) com aviso no
// console — o toggle continua clicavel, so nao garante isolamento por empresa
// enquanto o backend nao responder.
async function applyAmbiente(tipo, empresaId, usuarioId) {
  try {
    const { ambiente } = await trocarAmbiente({ tipo, empresa_id: empresaId, usuario_id: usuarioId });
    if (tipo === 'empresarial' && ambiente?.empresa_id) {
      state.activeEmpresaId = ambiente.empresa_id;
    }
    setActiveEmpresa(ambiente?.empresa_id || (tipo === 'empresarial' ? empresaId : state.activeEmpresaId));
    return ambiente;
  } catch (err) {
    console.warn('[ambiente] troca via backend falhou, seguindo em modo compatibilidade:', err?.message || err);
    if (tipo === 'empresarial' && empresaId) {
      state.activeEmpresaId = empresaId;
      setActiveEmpresa(empresaId);
    }
    // Sem throw: mantem "modo compatibilidade" pros callers de sempre. No
    // caso de ambiente DELEGADO que falhou (ex.: revogado), o fallback ja e
    // seguro por omissao — activeEmpresaId/setActiveEmpresa simplesmente nao
    // sao atualizados pro id delegado, entao o proximo request usa a empresa
    // PROPRIA do usuario (setada antes desta chamada, em boot()).
    return null;
  }
}

// === Handlers ===
const CAMBIO_AUTO_REFRESH_MS = 15 * 60 * 1000;
const CAMBIO_INPUT_DEBOUNCE_MS = 600;
const cambioInputTimers = new Map();
let cambioRefreshFrame = 0;

function cambioRequestKey(config) {
  return `${config.valor}|${config.de}|${config.para}|${config.dias}`;
}

async function runCambioConversion(uid, { force = false, notifyInvalid = false } = {}) {
  const config = dashGetCambioConfig(curWs(), uid);
  const valor = Number(config?.valor);
  if (!config || !Number.isFinite(valor) || valor <= 0 || valor > 1_000_000_000_000) {
    if (notifyInvalid) {
      state.dashCambioResults = state.dashCambioResults || {};
      state.dashCambioResults[uid] = {
        status: 'error',
        data: null,
        error: 'Informe um valor maior que zero e dentro do limite permitido.'
      };
      renderApp();
      requestAnimationFrame(() => {
        const input = document.querySelector(`[data-action="dash-cambio-valor"][data-param="${CSS.escape(uid)}"]`);
        input?.setAttribute('aria-invalid', 'true');
        input?.focus();
      });
    }
    return;
  }

  state.dashCambioResults = state.dashCambioResults || {};
  const key = cambioRequestKey(config);
  const current = state.dashCambioResults[uid];
  if (current?.status === 'loading' && current.key === key) return;
  if (!force && current?.status === 'success' && current.key === key && Date.now() - Number(current.fetchedAt || 0) < CAMBIO_AUTO_REFRESH_MS) return;

  const previousData = current?.key === key ? current.data : null;
  state.dashCambioResults[uid] = { status: 'loading', key, data: previousData || null, fetchedAt: current?.fetchedAt || 0 };
  renderApp();
  try {
    const data = await api.converterMoeda({ valor, de: config.de, para: config.para, dias: config.dias });
    if (state.dashCambioResults?.[uid]?.key !== key) return;
    state.dashCambioResults[uid] = { status: 'success', key, data, fetchedAt: Date.now() };
  } catch (error) {
    if (state.dashCambioResults?.[uid]?.key !== key) return;
    state.dashCambioResults[uid] = {
      status: 'error', key, data: previousData || null, fetchedAt: current?.fetchedAt || 0,
      error: error?.message || 'Cotação indisponível.'
    };
  }
  renderApp();
}

function refreshVisibleCambioWidgets({ force = false } = {}) {
  if (document.visibilityState === 'hidden') return;
  const ids = [...new Set([...document.querySelectorAll('form[data-dash-cambio]')]
    .map((form) => form.getAttribute('data-dash-cambio')).filter(Boolean))];
  ids.forEach((uid) => void runCambioConversion(uid, { force }));
}

function scheduleCambioRefresh() {
  if (cambioRefreshFrame) return;
  cambioRefreshFrame = requestAnimationFrame(() => {
    cambioRefreshFrame = 0;
    refreshVisibleCambioWidgets();
  });
}

function scheduleCambioInput(uid) {
  clearTimeout(cambioInputTimers.get(uid));
  cambioInputTimers.set(uid, setTimeout(() => {
    cambioInputTimers.delete(uid);
    void runCambioConversion(uid, { force: true });
  }, CAMBIO_INPUT_DEBOUNCE_MS));
}

const ACTIONS = {
  // Drawer mobile: alterna a classe no <body> (persiste entre renderApp, pois so o #root e
  // reconstruido). Navegar fecha o drawer.
  'toggle-nav': () => { document.body.classList.toggle('nav-open'); },
  'close-nav': () => { document.body.classList.remove('nav-open'); },

  // Botao exclusivo do usuario hibrido (workspaces === 'ambos') p/ alternar
  // Pessoal <-> Empresarial. So renderizado (finance-render.js) quando
  // isHybridUser() e verdadeiro; a guarda aqui e defesa extra caso o handler
  // seja disparado por algum outro caminho.
  'toggle-workspace': async () => {
    document.body.classList.remove('nav-open');
    if (!isHybridUser()) return;
    const alvo = state.workspace === 'empresarial' ? 'pessoal' : 'empresarial';
    state.workspace = alvo;
    state.activeNav = 'dashboard';
    await applyAmbiente(alvo, alvo === 'empresarial' ? state.activeEmpresaId : undefined);
    saveUiPrefs({ workspace: state.workspace, activeNav: state.activeNav });
    await refreshAll();
  },

  // Painel lateral "Contas que eu comando" (delegação). param vazio = volta
  // pra propria conta; param = usuario_id de uma conta delegada.
  'trocar-usuario': async (param) => {
    document.body.classList.remove('nav-open');
    state.workspace = 'pessoal';
    state.activeNav = 'dashboard';
    await applyAmbiente('pessoal', undefined, param || undefined);
    try {
      const user = await me();
      if (user) state.currentUser = user;
    } catch (err) {
      console.warn('[trocar-usuario] falha ao atualizar sessao:', err?.message || err);
    }
    saveUiPrefs({ activeNav: state.activeNav });
    await refreshAll();
  },

  // Desktop: colapsa/expande a coluna (preferência persistida). Mobile: a
  // mesma ação abre/fecha a gaveta sobreposta (classe no body, como o menu
  // lateral) — os dois estados são independentes, cada CSS só se aplica no
  // seu próprio breakpoint (ver design-system.css / ui-foundation.css).
  'toggle-userpanel': () => {
    document.body.classList.toggle('userpanel-open');
    state.userpanelOpen = state.userpanelOpen === false ? true : false;
    saveUiPrefs({ userpanelOpen: state.userpanelOpen });
    renderApp();
  },

  'change-view': async (param) => {
    document.body.classList.remove('nav-open');
    if (state.pricing.dirty && state.activeNav === 'precificacao' && param !== 'precificacao') {
      if (!(await appConfirm({ title: 'Descartar alterações?', description: 'Há alterações não salvas na precificação. Se sair agora, elas serão perdidas.', confirmLabel: 'Descartar', variant: 'danger' }))) return;
      state.pricing.dirty = false;
      state.pricing.editor = null;
    }
    state.activeNav = param || 'dashboard';
    saveUiPrefs({ activeNav: state.activeNav });
    renderApp();
    if (state.activeNav === 'precificacao') {
      await loadPricingData();
      renderApp();
    }
    if (state.activeNav === 'lixeira') {
      await loadLixeira();
      renderApp();
    }
  },

  // Modal de configurações da conta (self-service). Hoje só a moeda padrão
  // pessoal. Guarda "só Pessoal": usuário puramente empresarial não tem moeda
  // pessoal p/ configurar (o backend devolveria 403). Pré-carrega a moeda atual
  // vinda do /me (state.currentUser.moeda_pessoal).
  'open-modal-settings': () => {
    document.body.classList.remove('nav-open');
    if ((state.currentUser?.workspaces || 'ambos') === 'empresarial') return;
    state.modal = {
      type: 'settings',
      form: { moeda: String(state.currentUser?.moeda_pessoal || 'BRL').toUpperCase() }
    };
    renderApp();
  },

  // === Precificacao empresarial ===
  'pricing-refresh': async () => {
    await refreshPricing();
    renderApp();
  },
  'pricing-search': (param, el) => {
    state.pricing.search = el?.value || '';
    renderApp();
  },
  'pricing-filter-type': (param, el) => {
    state.pricing.typeFilter = el?.value || '';
    renderApp();
  },
  'pricing-management-toggle': () => {
    state.pricing.management = !state.pricing.management;
    renderApp();
  },
  'pricing-new': () => {
    if (state.currentUser?.role !== 'admin') return;
    const item = { tipo: 'produto', nome: '', codigo: '', categoria_id: '', unidade: 'unidade', descricao: '', ativo: true };
    state.pricing.editor = { item, version: defaultPricingVersion('produto'), isNew: true, simulationOnly: false };
    state.pricing.selected = null;
    state.pricing.tab = 'dados';
    state.pricing.result = null;
    state.pricing.dirty = false;
    renderApp();
  },
  'pricing-select': async (param) => {
    state.pricing.selected = await api.pricingItem(param);
    state.pricing.editor = null;
    state.pricing.result = null;
    state.pricing.dirty = false;
    renderApp();
  },
  'pricing-back': async () => {
    if (state.pricing.dirty && !(await appConfirm({ title: 'Descartar alterações?', description: 'Há alterações não salvas. Deseja sair mesmo assim?', confirmLabel: 'Descartar', variant: 'danger' }))) return;
    state.pricing.editor = null;
    state.pricing.dirty = false;
    state.pricing.result = null;
    if (state.pricing.selected) renderApp();
    else renderApp();
  },
  'pricing-edit': async () => {
    if (state.currentUser?.role !== 'admin' || !state.pricing.selected) return;
    let detail = state.pricing.selected;
    let draft = (detail.versoes || []).find((version) => version.status === 'rascunho');
    if (!draft) {
      draft = await api.postPricingDraft(detail.id);
      detail = await api.pricingItem(detail.id);
      state.pricing.selected = detail;
      draft = (detail.versoes || []).find((version) => version.id === draft.id) || draft;
    }
    state.pricing.editor = { item: clone(detail), version: clone(draft), isNew: false, simulationOnly: false };
    state.pricing.tab = 'dados';
    state.pricing.result = draft.faixas?.length ? clone(draft) : null;
    state.pricing.dirty = false;
    renderApp();
  },
  'pricing-open-simulator': () => {
    const detail = state.pricing.selected;
    if (!detail) return;
    const version = (detail.versoes || []).filter((entry) => entry.status === 'publicada' && new Date(entry.vigencia_inicio).getTime() <= Date.now())
      .sort((a, b) => new Date(b.vigencia_inicio) - new Date(a.vigencia_inicio))[0];
    if (!version) return;
    state.pricing.editor = { item: clone(detail), version: clone(version), isNew: false, simulationOnly: true };
    state.pricing.tab = 'resultado';
    state.pricing.result = clone(version);
    state.pricing.dirty = false;
    renderApp();
  },
  'pricing-tab': (param) => {
    if (!['dados', 'custos', 'parametros', 'faixas', 'resultado'].includes(param)) return;
    state.pricing.tab = param;
    renderApp();
  },
  'pricing-field': (param, el) => {
    let next = el?.type === 'checkbox' ? Boolean(el.checked) : el?.value;
    const numericField = el?.type === 'number';
    if (numericField && next !== '') next = Number(next);
    setPricingPath(param, next);
    const editor = state.pricing.editor;
    if (editor && param === 'item.tipo' && !editor.item.id) {
      editor.version.componentes = defaultPricingVersion(next).componentes;
    }
    const functionMatch = /^componentes\.(\d+)\.funcao_id$/.exec(param || '');
    if (editor && functionMatch) {
      const component = editor.version.componentes[Number(functionMatch[1])];
      const fn = state.pricing.functions.find((entry) => entry.id === next);
      if (component && fn) {
        component.tipo = 'mao_obra'; component.nome = fn.nome; component.unidade = 'hora'; component.custo_unitario = Number(fn.custo_hora);
      }
    }
    if (editor) state.pricing.dirty = true;
    renderApp();
  },
  'pricing-add-component': () => {
    const editor = state.pricing.editor;
    if (!editor) return;
    editor.version.componentes = editor.version.componentes || [];
    editor.version.componentes.push({ tipo: editor.item.tipo === 'servico' ? 'mao_obra' : 'insumo', nome: '', unidade: editor.item.tipo === 'servico' ? 'hora' : 'unidade', quantidade: 1, custo_unitario: 0, perda_pct: 0, funcao_id: null });
    state.pricing.dirty = true;
    renderApp();
  },
  'pricing-remove-component': (param) => {
    state.pricing.editor?.version?.componentes?.splice(Number(param), 1);
    state.pricing.dirty = true;
    renderApp();
  },
  'pricing-add-range': () => {
    const ranges = state.pricing.editor?.version?.faixas;
    if (!ranges) return;
    const last = ranges.at(-1);
    const max = Number(last?.quantidade_min || 1) + 8;
    if (last) last.quantidade_max = max;
    ranges.push({ quantidade_min: max + 1, quantidade_max: null, custo_ajuste_pct: 0, margem_alvo_pct: Number(last?.margem_alvo_pct ?? state.pricing.editor.version.margem_padrao_pct) });
    normalizePricingRanges();
    state.pricing.dirty = true;
    renderApp();
  },
  'pricing-remove-range': (param) => {
    state.pricing.editor?.version?.faixas?.splice(Number(param), 1);
    normalizePricingRanges();
    state.pricing.dirty = true;
    renderApp();
  },
  'pricing-simulate': async () => {
    if (!state.pricing.editor?.item?.id && state.currentUser?.role === 'admin') await savePricingDraft({ quiet: true });
    const payload = pricingPayload();
    if (!payload.version.item_id) payload.version.item_id = state.pricing.editor.item.id;
    state.pricing.result = await api.simulatePricing(payload.version);
    state.pricing.tab = 'resultado';
    renderApp();
  },
  'pricing-save-draft': async () => {
    await savePricingDraft();
    renderApp();
  },
  'pricing-publish': async () => {
    const effectiveAt = state.pricing.editor?.effectiveAt || '';
    await savePricingDraft({ quiet: true });
    const editor = state.pricing.editor;
    const vigencia = effectiveAt ? new Date(effectiveAt).toISOString() : new Date().toISOString();
    await api.publishPricingVersion(editor.version.id, { vigencia_inicio: vigencia });
    pushToast(effectiveAt ? 'Preço agendado.' : 'Preço publicado.', 'success');
    state.pricing.editor = null;
    state.pricing.dirty = false;
    await refreshPricing();
    state.pricing.selected = await api.pricingItem(editor.item.id);
    renderApp();
  },
  'pricing-cancel-version': async (param) => {
    if (!(await appConfirm({ title: 'Cancelar versão agendada?', description: 'A versão de preço agendada será cancelada.', confirmLabel: 'Cancelar versão', cancelLabel: 'Voltar', variant: 'danger' }))) return;
    await api.cancelPricingVersion(param);
    state.pricing.selected = await api.pricingItem(state.pricing.selected.id);
    await refreshPricing({ keepSelection: true });
    pushToast('Agendamento cancelado.', 'success');
    renderApp();
  },
  'pricing-save-config': async () => {
    await api.putPricingConfig(state.pricing.config);
    await refreshPricing();
    pushToast('Padrões de precificação salvos.', 'success');
    renderApp();
  },
  'pricing-add-category': async () => {
    const input = document.getElementById('pricing-category-name');
    if (!input?.value.trim()) throw new Error('Informe o nome da categoria.');
    await api.postPricingCategory({ nome: input.value.trim() });
    await refreshPricing();
    state.pricing.management = true;
    renderApp();
  },
  'pricing-toggle-category': async (param) => {
    const category = state.pricing.categories.find((entry) => entry.id === param);
    if (!category) return;
    await api.putPricingCategory(param, { ativo: !category.ativo });
    await refreshPricing(); state.pricing.management = true; renderApp();
  },
  'pricing-add-function': async () => {
    const name = document.getElementById('pricing-function-name')?.value.trim();
    const cost = document.getElementById('pricing-function-cost')?.value;
    if (!name) throw new Error('Informe o nome da funcao.');
    await api.postPricingFunction({ nome: name, custo_hora: Number(cost || 0) });
    await refreshPricing(); state.pricing.management = true; renderApp();
  },
  'pricing-toggle-function': async (param) => {
    const fn = state.pricing.functions.find((entry) => entry.id === param);
    if (!fn) return;
    await api.putPricingFunction(param, { ativo: !fn.ativo });
    await refreshPricing(); state.pricing.management = true; renderApp();
  },

  'filter-tx': (param) => {
    state.filters.transacoes = param || 'todas';
    renderApp();
  },

  'filter-areceber': (param) => {
    state.filters.aReceber = param || 'todos';
    renderApp();
  },

  // === DRE: navegação de mês ===
  'dre-month-prev': () => shiftDreMonth(-1),
  'dre-month-next': () => shiftDreMonth(1),
  'dre-calendar-toggle': () => {
    const cur = state.filters.dreMes
      || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
    const [y] = cur.split('-').map(Number);
    state.filters.dreCalendarYear = state.filters.dreCalendarYear || y;
    state.filters.dreCalendarOpen = !state.filters.dreCalendarOpen;
    renderApp();
  },
  'dre-calendar-prev-year': () => {
    const cur = state.filters.dreCalendarYear || new Date().getFullYear();
    state.filters.dreCalendarYear = cur - 1;
    state.filters.dreCalendarOpen = true;
    renderApp();
  },
  'dre-calendar-next-year': () => {
    const cur = state.filters.dreCalendarYear || new Date().getFullYear();
    state.filters.dreCalendarYear = cur + 1;
    state.filters.dreCalendarOpen = true;
    renderApp();
  },
  'dre-calendar-select': (param) => {
    if (!/^\d{4}-\d{2}$/.test(param || '')) return;
    clearDrePending();
    state.filters.dreMes = param;
    state.filters.dreCalendarYear = Number(param.slice(0, 4));
    state.filters.dreCalendarOpen = false;
    saveUiPrefs({ dreMes: param });
    renderApp();
  },

  // === DRE: edição (admin) ===
  // Abre/fecha o drawer "Editar dados do DRE" (projetado/ajuste/mapeamento/fórmulas).
  'dre-edit-toggle': () => {
    if (state.currentUser?.role !== 'admin') return;
    clearDrePending();
    state.filters.dreEdit = !state.filters.dreEdit;
    if (!state.filters.dreEdit) { state.filters.dreMapOpen = false; state.filters.dreFormulaDraft = null; }
    renderApp();
  },
  'dre-edit-close': () => {
    clearDrePending();
    state.filters.dreEdit = false;
    state.filters.dreMapOpen = false;
    state.filters.dreFormulaDraft = null;
    renderApp();
  },
  'dre-map-toggle': () => {
    state.filters.dreMapOpen = !state.filters.dreMapOpen;
    renderApp();
  },
  // Salva o lote inteiro (Projetado + Ajuste) de uma vez. Envia plano + ajuste
  // efetivos por linha (mescla pendência + valor do servidor) p/ não zerar o campo
  // não tocado no upsert.
  'dre-save-batch': async () => {
    const pend = state.filters.drePending || {};
    const linhas = Object.keys(pend);
    if (!linhas.length) return;
    const mes = dreCurrentMes();
    const server = dreServerValues(mes);
    const updates = linhas.map((linha_id) => {
      const cell = pend[linha_id] || {};
      const sv = server[linha_id] || { plano: 0, ajuste: 0 };
      return {
        linha_id,
        plano: cell.plano !== undefined ? parseDreNum(cell.plano) : sv.plano,
        ajuste_real: cell.ajuste !== undefined ? parseDreNum(cell.ajuste) : sv.ajuste
      };
    });
    try {
      const r = await api.putDreValores({ mes, updates, scope: dreScopeParam() });
      clearDrePending();
      await refreshDreNumbers();
      pushToast(`DRE salvo: ${r?.count ?? updates.length} linha(s).`, 'success');
    } catch (err) {
      pushToast(err?.message || 'Falha ao salvar DRE.', 'error');
    }
  },
  'dre-discard': () => {
    clearDrePending();
    renderApp();
  },
  'dre-linha-rename': async (param, el) => {
    const nome = String(el?.value || '').trim();
    if (!param || !nome) return;
    try {
      await api.putDreLinha(param, { nome, scope: dreScopeParam() });
      await reloadDre();
    } catch (err) {
      pushToast(err?.message || 'Falha ao renomear.', 'error');
    }
  },
  'dre-linha-add': async (param) => {
    if (!param) return;
    const nome = await appPrompt({ title: 'Nova linha do DRE', label: 'Nome da linha', placeholder: 'Ex: Outras receitas' });
    if (!nome || !nome.trim()) return;
    try {
      await api.postDreLinha({ secao: param, nome: nome.trim(), scope: dreScopeParam() });
      await reloadDre();
      pushToast('Linha criada.', 'success');
    } catch (err) {
      pushToast(err?.message || 'Falha ao criar linha.', 'error');
    }
  },
  'dre-linha-move': async (param) => {
    const [id, dir] = String(param || '').split('|');
    if (!id || !dir) return;
    try {
      await moveDreLinha(id, dir);
      await reloadDre();
    } catch (err) {
      pushToast(err?.message || 'Falha ao mover.', 'error');
    }
  },
  'dre-linha-del': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Remover linha?', description: 'As categorias desta linha voltam para "A classificar".', confirmLabel: 'Remover', variant: 'danger' }))) return;
    try {
      await api.deleteDreLinha(param, dreScopeParam());
      await reloadDre();
      pushToast('Linha removida.', 'success');
    } catch (err) {
      pushToast(err?.message || 'Falha ao remover.', 'error');
    }
  },
  'dre-map-save': async (param, el) => {
    if (!param) return;
    try {
      await api.putDreMapa({ categoria_id: param, linha_id: el?.value || null, scope: dreScopeParam() });
      await reloadDre();
    } catch (err) {
      pushToast(err?.message || 'Falha ao mapear categoria.', 'error');
    }
  },

  // === DRE: escopo (Meu DRE / Template da empresa) + configuração de colunas ===
  'dre-scope-toggle': () => {
    if (state.currentUser?.role !== 'admin') return;
    clearDrePending();
    state.filters.dreScope = state.filters.dreScope === 'template' ? undefined : 'template';
    // Estrutura/config são por escopo (singletons) — força recarregar no novo escopo.
    state.data.dreEstrutura = null;
    state.data.dreConfig = null;
    renderApp();
  },
  'dre-cols-toggle': () => {
    if (state.currentUser?.role !== 'admin') return;
    state.filters.dreColsOpen = !state.filters.dreColsOpen;
    renderApp();
  },
  'dre-col-toggle': (param) => {
    if (state.currentUser?.role !== 'admin' || !param) return;
    saveDreConfig({ columns: dreColumnsToggle(param) });
  },
  'dre-col-move': (param) => {
    if (state.currentUser?.role !== 'admin') return;
    const [key, dir] = String(param || '').split('|');
    if (!key || !dir) return;
    saveDreConfig({ columns: dreColumnsMove(key, dir) });
  },

  // === DRE Fase 2: construtor de fórmula (linhas de total) ===
  'dre-formula-new': () => {
    if (state.currentUser?.role !== 'admin') return;
    state.filters.dreFormulaDraft = { id: null, nome: '', formato: 'currency', terms: [{ op: '+', ref: '' }] };
    renderApp();
  },
  'dre-formula-edit': (param) => {
    if (state.currentUser?.role !== 'admin' || !param) return;
    const row = findDreFormulaRow(param);
    if (!row) { pushToast('Linha não encontrada no cache; recarregue.', 'error'); return; }
    state.filters.dreFormulaDraft = {
      id: row.id, nome: row.nome, formato: row.formato || 'currency',
      terms: (Array.isArray(row.formula) ? row.formula : []).map((t) => ({ ...t }))
    };
    renderApp();
  },
  'dre-formula-cancel': () => { state.filters.dreFormulaDraft = null; renderApp(); },
  'dre-formula-name': (_p, el) => { if (state.filters.dreFormulaDraft) state.filters.dreFormulaDraft.nome = el.value; },
  'dre-formula-format': (_p, el) => { if (state.filters.dreFormulaDraft) { state.filters.dreFormulaDraft.formato = el.value; renderApp(); } },
  'dre-formula-term-add': () => {
    const d = state.filters.dreFormulaDraft; if (!d) return;
    (d.terms = d.terms || []).push({ op: '+', ref: '' });
    renderApp();
  },
  'dre-formula-term-del': (param) => {
    const d = state.filters.dreFormulaDraft; const i = Number(param);
    if (!d || !Array.isArray(d.terms)) return;
    d.terms.splice(i, 1);
    renderApp();
  },
  'dre-formula-term-op': (param, el) => {
    const d = state.filters.dreFormulaDraft; const i = Number(param);
    if (!d || !d.terms?.[i]) return;
    d.terms[i].op = el.value;
    renderApp();
  },
  'dre-formula-term-ref': (param, el) => {
    const d = state.filters.dreFormulaDraft; const i = Number(param);
    if (!d || !d.terms?.[i]) return;
    const op = d.terms[i].op || '+';
    const val = el.value;
    if (val === '__num__') d.terms[i] = { op, ref: '__num__', value: d.terms[i].value ?? 0 };
    else if (val) d.terms[i] = { op, ref: val };
    else d.terms[i] = { op };
    renderApp();
  },
  'dre-formula-term-val': (param, el) => {
    const d = state.filters.dreFormulaDraft; const i = Number(param);
    if (!d || !d.terms?.[i]) return;
    d.terms[i] = { op: d.terms[i].op || '+', ref: '__num__', value: el.value };
    renderApp();
  },
  'dre-formula-save': async () => {
    const d = state.filters.dreFormulaDraft; if (!d) return;
    const nome = String(d.nome || '').trim();
    if (!nome) { pushToast('Dê um nome à linha de total.', 'error'); return; }
    const terms = (d.terms || []).map((t) => {
      if (t.ref && t.ref !== '__num__') return { op: t.op || '+', ref: t.ref };
      if (t.ref === '__num__' || (t.value != null && t.value !== '')) return { op: t.op || '+', value: Number(t.value) || 0 };
      return null;
    }).filter(Boolean);
    if (!terms.length) { pushToast('A fórmula precisa de ao menos um termo.', 'error'); return; }
    const payload = { nome, formato: d.formato || 'currency', formula: { terms }, scope: dreScopeParam() };
    try {
      if (d.id) await api.putDreFormula(d.id, payload);
      else await api.postDreFormula(payload);
      state.filters.dreFormulaDraft = null;
      await reloadDre();
      pushToast('Fórmula salva.', 'success');
    } catch (err) {
      pushToast(err?.message || 'Falha ao salvar fórmula.', 'error');
    }
  },
  'dre-formula-del': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Remover linha de total?', confirmLabel: 'Remover', variant: 'danger' }))) return;
    try {
      await api.deleteDreFormula(param, dreScopeParam());
      if (state.filters.dreFormulaDraft?.id === param) state.filters.dreFormulaDraft = null;
      await reloadDre();
      pushToast('Linha de total removida.', 'success');
    } catch (err) {
      pushToast(err?.message || 'Falha ao remover.', 'error');
    }
  },
  'dre-formula-move': async (param) => {
    const [id, dir] = String(param || '').split('|');
    if (!id || !dir) return;
    const ordem = dreFormulaNewOrdem(id, dir);
    if (ordem == null) return;
    try {
      await api.putDreFormula(id, { ordem, scope: dreScopeParam() });
      await reloadDre();
    } catch (err) {
      pushToast(err?.message || 'Falha ao mover.', 'error');
    }
  },

  // === Dashboard: cascata DRE (expand + navegação de mês) ===
  'dash-toggle': (param) => {
    if (!param) return;
    const m = state.filters.dashExpanded || (state.filters.dashExpanded = {});
    m[param] = !m[param];
    renderApp();
  },
  'dash-month-prev': () => shiftDashMonth(-1),
  'dash-month-next': () => shiftDashMonth(1),
  'dash-calendar-toggle': () => {
    const cur = state.filters.dashMes
      || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
    const [y] = cur.split('-').map(Number);
    state.filters.dashCalendarYear = state.filters.dashCalendarYear || y;
    state.filters.dashCalendarOpen = !state.filters.dashCalendarOpen;
    renderApp();
  },
  'dash-calendar-prev-year': () => {
    const cur = state.filters.dashCalendarYear || new Date().getFullYear();
    state.filters.dashCalendarYear = cur - 1;
    state.filters.dashCalendarOpen = true;
    renderApp();
  },
  'dash-calendar-next-year': () => {
    const cur = state.filters.dashCalendarYear || new Date().getFullYear();
    state.filters.dashCalendarYear = cur + 1;
    state.filters.dashCalendarOpen = true;
    renderApp();
  },
  'dash-calendar-select': (param) => {
    if (!/^\d{4}-\d{2}$/.test(param || '')) return;
    state.filters.dashMes = param;
    state.filters.dashCalendarYear = Number(param.slice(0, 4));
    state.filters.dashCalendarOpen = false;
    renderApp();
  },

  // === Dashboard modular: edição de layout ===
  'dash-edit-toggle': () => {
    state.dashEdit = !state.dashEdit;
    if (!state.dashEdit) state.dashAddOpen = false;
    renderApp();
  },
  'dash-add-toggle': () => { state.dashAddOpen = !state.dashAddOpen; renderApp(); },
  'dash-widget-add': (param) => {
    const [ws, type] = String(param || '').split('|');
    dashAddWidget(ws, type);
    renderApp();
  },
  'dash-widget-remove': (param) => { dashRemoveWidget(curWs(), param); renderApp(); },
  'dash-widget-size': (param) => {
    const [uid, axis, rawDelta] = String(param || '').split('|');
    const columns = curDashColumns();
    const item = getLayout(curWs(), columns).find((candidate) => candidate.uid === uid);
    if (!item || !['w', 'h'].includes(axis)) return;
    const delta = Number(rawDelta) || 0;
    dashSetWidgetSize(curWs(), uid, Number(item.w) + (axis === 'w' ? delta : 0), Number(item.h) + (axis === 'h' ? delta : 0), columns);
    renderApp();
  },
  'dash-grid-columns': (param) => {
    const [ws, rawColumns] = String(param || '').split('|');
    dashSetGridColumns(ws, Number(rawColumns));
    renderApp();
  },
  'dash-layout-organize': (param) => {
    const [ws, rawColumns] = String(param || '').split('|');
    dashOrganizeLayout(ws, Number(rawColumns));
    renderApp();
  },
  'dash-apply-preset': (param) => {
    const [ws, presetId] = String(param || '').split('|');
    dashApplyPreset(ws, presetId);
    renderApp();
  },
  // Notas: salvam no change (blur) sem re-render, pra não perder o foco enquanto digita.
  'dash-nota-title': (param, el) => dashSetNota(curWs(), param, 'title', el?.value || ''),
  'dash-nota-body':  (param, el) => dashSetNota(curWs(), param, 'body', el?.value || ''),
  'dash-cambio-valor': async (param, el) => {
    clearTimeout(cambioInputTimers.get(param));
    dashSetCambioConfig(curWs(), param, 'valor', el?.value);
    await runCambioConversion(param, { notifyInvalid: true });
  },
  'dash-cambio-de': async (param, el) => {
    dashSetCambioConfig(curWs(), param, 'de', el?.value);
    await runCambioConversion(param, { force: true });
  },
  'dash-cambio-para': async (param, el) => {
    dashSetCambioConfig(curWs(), param, 'para', el?.value);
    await runCambioConversion(param, { force: true });
  },
  'dash-cambio-dias': async (param, el) => {
    dashSetCambioConfig(curWs(), param, 'dias', el?.value);
    await runCambioConversion(param, { force: true });
  },
  'dash-cambio-converter': async (param) => runCambioConversion(param, { force: true, notifyInvalid: true }),
  'dash-cambio-swap': async (param) => {
    dashSwapCambio(curWs(), param);
    await ACTIONS['dash-cambio-converter'](param);
  },
  'dash-profile-save': async (param) => {
    const nome = await appPrompt({ title: 'Salvar perfil de layout', label: 'Nome do perfil', placeholder: 'Ex: Foco em caixa' });
    if (!nome || !nome.trim()) return;
    dashSaveProfile(param, nome.trim());
    pushToast(`Perfil "${nome.trim()}" salvo.`, 'success');
    renderApp();
  },
  'dash-profile-load': (param, el) => {
    const ws = String(param || '');
    const nome = el?.getAttribute('data-profile-name') || '';
    if (!ws || !nome) return;
    dashLoadProfile(ws, nome);
    pushToast(`Perfil "${nome}" aplicado.`, 'info');
    renderApp();
  },
  'dash-profile-del': async (param, el) => {
    const ws = String(param || '');
    const nome = el?.getAttribute('data-profile-name') || '';
    if (!ws || !nome) return;
    if (!(await appConfirm({ title: 'Excluir perfil?', description: `O perfil "${nome}" será removido.`, confirmLabel: 'Excluir', variant: 'danger' }))) return;
    dashDeleteProfile(ws, nome);
    renderApp();
  },
  'dash-layout-reset': async (param) => {
    if (!(await appConfirm({ title: 'Restaurar layout padrão?', description: 'Mudanças não salvas em perfil serão perdidas.', confirmLabel: 'Restaurar', variant: 'danger' }))) return;
    dashResetLayout(param, curDashColumns());
    pushToast('Layout restaurado.', 'info');
    renderApp();
  },

  // === Dashboard: inadimplência (filtros) ===
  'inad-set-dias': (param) => {
    state.filters.inadMinDias = Number(param) || 0;
    renderApp();
  },
  'inad-set-inicio': (_param, el) => {
    state.filters.inadDataInicio = el?.value || null;
    renderApp();
  },
  'inad-set-fim': (_param, el) => {
    state.filters.inadDataFim = el?.value || null;
    renderApp();
  },
  'inad-clear-datas': () => {
    state.filters.inadDataInicio = null;
    state.filters.inadDataFim = null;
    renderApp();
  },

  // === Dashboard: período dos KPIs (mês corrente vs intervalo livre) ===
  // Persiste no backend (por empresa/usuário/escopo) e recarrega só o /dashboard.
  'dash-periodo-tipo': async (param) => {
    if (param === 'custom') {
      const p = state.filters.dashPeriodo;
      if (!p.dataInicio || !p.dataFim) {
        // Default sensato ao abrir: dia 1 do mês corrente até hoje.
        const d = new Date();
        const ini = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        state.filters.dashPeriodo = { tipo: 'custom', dataInicio: ini, dataFim: todayInputValue() };
      } else {
        state.filters.dashPeriodo = { ...p, tipo: 'custom' };
      }
    } else {
      state.filters.dashPeriodo = { tipo: 'mes', dataInicio: null, dataFim: null };
    }
    await persistDashPeriodo();
  },
  'dash-periodo-inicio': async (_param, el) => {
    state.filters.dashPeriodo = { ...state.filters.dashPeriodo, tipo: 'custom', dataInicio: el?.value || null };
    await persistDashPeriodo();
  },
  'dash-periodo-fim': async (_param, el) => {
    state.filters.dashPeriodo = { ...state.filters.dashPeriodo, tipo: 'custom', dataFim: el?.value || null };
    await persistDashPeriodo();
  },

  // === Despesas Variáveis: navegação de mês + filtros + workspace local ===
  'despvar-month-prev': () => shiftDespVarMonth(-1),
  'despvar-month-next': () => shiftDespVarMonth(1),
  'despvar-filter-cat':   (param) => { state.filters.despVarCat = param || ''; renderApp(); },
  'despvar-filter-conta': (param) => { state.filters.despVarConta = param || ''; renderApp(); },
  // Filtro de workspace LOCAL da tela: não mexe no workspace global (que trocaria
  // o nav e jogaria de volta pro dashboard) — só alterna o recorte dos dados.
  'despvar-filter-ws': (param) => {
    state.filters.despVarWs = param === 'pessoal' ? 'pessoal' : 'empresarial';
    state.filters.despVarCat = '';
    state.filters.despVarConta = '';
    renderApp();
  },

  // Entradas do lançamento rápido (antigo modal "lancamento", D7): redirecionam
  // pro modal completo, já mapeadas e pré-preenchidas. income→receita;
  // fixed/variable→despesa (variable ganha categoria variável pré-selecionada).
  'open-modal-lancamento': (param) => {
    const legado = param === 'income' ? 'income' : (param === 'fixed' ? 'fixed' : 'variable');
    const tipo = legado === 'income' ? 'receita' : 'despesa';
    const ws = curWs();
    let categoria_id = '';
    if (legado === 'variable') {
      const cat = categoriasDoWorkspace(ws).find((c) => isVariavel(c))
        || categoriasDoWorkspace('empresarial').find((c) => isVariavel(c));
      categoria_id = cat?.id || '';
    }
    const remembered = lastLancamentoDefaults(ws, tipo);
    state.modal = {
      type: 'transacao',
      form: {
        tipo,
        titulo: '',
        valor: '',
        data: todayInputValue(),
        categoria_id: categoria_id || remembered.categoria_id || '',
        conta_bancaria_id: remembered.conta_bancaria_id || defaultContaId(ws)
      }
    };
    renderApp();
  },

  // === Modais ===
  'open-modal-transacao': (param) => {
    const tipo = param === 'receita' ? 'receita' : 'despesa';
    const ws = state.workspace;
    const remembered = lastLancamentoDefaults(ws, tipo);
    state.modal = {
      type: 'transacao',
      form: {
        tipo,
        titulo: '',
        valor: '',
        data: todayInputValue(),
        categoria_id: remembered.categoria_id || '',
        conta_bancaria_id: remembered.conta_bancaria_id || defaultContaId(ws)
      }
    };
    renderApp();
  },

  'open-modal-transacao-edit': (param) => {
    const form = findTransacaoForEdit(param);
    if (!form) { pushToast('Lançamento não encontrado para edição.', 'error'); return; }
    state.modal = { type: 'transacao', editingId: param, form };
    renderApp();
  },

  'open-modal-conta': () => {
    state.modal = {
      type: 'conta',
      form: {
        nome: '', tipo: 'corrente', moeda: moedaAtiva(), saldo_inicial: '0', cor: '#22d3ee',
        escopo: state.workspace === 'empresarial' ? 'empresarial' : 'pessoal'
      }
    };
    renderApp();
  },

  'open-modal-conta-edit': (param) => {
    const c = (state.data.contas || []).find((x) => String(x.id) === String(param));
    if (!c) { pushToast('Conta não encontrada.', 'error'); return; }
    state.modal = {
      type: 'conta',
      editingId: c.id,
      form: {
        nome: c.nome || '', tipo: c.tipo || 'corrente', moeda: c.moeda || moedaAtiva(),
        saldo: Number(c.saldo || 0).toFixed(2),
        saldo_inicial: Number(c.saldo_inicial ?? c.saldo ?? 0).toFixed(2),
        lancamentos_count: Number(c.lancamentos_count || 0),
        cor: c.cor || '#22d3ee', escopo: c.escopo || 'pessoal'
      }
    };
    renderApp();
  },

  'arquivar-conta': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Arquivar conta?', description: 'A conta sai da lista mas o histórico de movimentações é preservado.', confirmLabel: 'Arquivar' }))) return;
    try {
      await api.putConta(param, { ativo: 0 });
      await refreshAll('Conta arquivada.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao arquivar.', 'error');
    }
  },

  // "Ver movimentações" recorta a tela de Transações pela conta.
  'ver-movimentacoes-conta': (param) => {
    if (!param) return;
    state.filters.transacoesConta = param;
    state.filters.transacoesCategoria = null;
    state.filters.transacoes = 'todas';
    state.activeNav = 'transacoes';
    saveUiPrefs({ activeNav: 'transacoes' });
    renderApp();
  },

  'clear-tx-conta': () => {
    state.filters.transacoesConta = null;
    renderApp();
  },

  'open-modal-categoria': () => {
    state.modal = {
      type: 'categoria',
      form: {
        nome: '',
        tipo: state.workspace === 'empresarial' ? 'empresarial' : 'pessoal',
        natureza: '', comportamento: '', dre_secao: '',
        usar_no_dre: true, usar_na_precificacao: false,
        cor: '#64748b'
      }
    };
    renderApp();
  },

  'open-modal-categoria-edit': (param) => {
    if (!param) return;
    const c = (state.data.categorias || []).find((x) => String(x.id) === String(param));
    if (!c) { pushToast('Categoria não encontrada.', 'error'); return; }
    state.modal = {
      type: 'categoria',
      editingId: c.id,
      form: {
        nome: c.nome || '',
        tipo: c.tipo || (state.workspace === 'empresarial' ? 'empresarial' : 'pessoal'),
        natureza: c.natureza || '',
        comportamento: c.comportamento || '',
        dre_secao: c.dre_secao || '',
        usar_no_dre: Number(c.usar_no_dre) !== 0,
        usar_na_precificacao: Number(c.usar_na_precificacao) === 1,
        cor: c.cor || '#64748b'
      }
    };
    renderApp();
  },

  'inativar-categoria': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Inativar categoria?', description: 'Ela some dos lançamentos novos, mas o histórico é preservado. Você pode reativar depois.', confirmLabel: 'Inativar' }))) return;
    try {
      await api.putCategoria(param, { ativo: 0 });
      await refreshAll('Categoria inativada.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao inativar.', 'error');
    }
  },

  'reativar-categoria': async (param) => {
    if (!param) return;
    try {
      await api.putCategoria(param, { ativo: 1 });
      await refreshAll('Categoria reativada.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao reativar.', 'error');
    }
  },

  // Filtros locais da tela Categorias (select: param = campo, valor em el.value).
  'filter-categoria': (campo, el) => {
    if (!campo) return;
    const f = state.filters.categorias || (state.filters.categorias = {});
    f[campo] = el?.value ?? 'todas';
    renderApp();
  },

  'search-categoria': (_param, el) => {
    const f = state.filters.categorias || (state.filters.categorias = {});
    f.busca = el?.value ?? '';
    renderApp();
  },

  // "Ver lançamentos" de uma categoria: recorta a tela de Transações por ela.
  'ver-lancamentos-categoria': (param) => {
    if (!param) return;
    state.filters.transacoesCategoria = param;
    state.filters.transacoes = 'todas';
    state.activeNav = 'transacoes';
    saveUiPrefs({ activeNav: 'transacoes' });
    renderApp();
  },

  'clear-tx-categoria': () => {
    state.filters.transacoesCategoria = null;
    renderApp();
  },

  // Diálogo interno (confirm/prompt): resolve a Promise aberta por appConfirm/appPrompt.
  'dialog-ok': () => {
    const d = state.dialog;
    if (d?.kind === 'prompt') {
      const val = document.getElementById('dialog-input')?.value ?? '';
      resolveDialog(val);
    } else {
      resolveDialog(true);
    }
  },
  'dialog-cancel': () => {
    resolveDialog(state.dialog?.kind === 'prompt' ? null : false);
  },

  // Pendências: "Ignorar" some o item só nesta sessão (não persiste).
  'pendencia-ignorar': (param) => {
    if (!param) return;
    const ign = state.filters.pendIgnore || (state.filters.pendIgnore = {});
    ign[param] = true;
    renderApp();
  },

  'cleanup-test-data-one': async (param) => {
    if (!param) return;
    const item = testDataCandidates().find((c) => c.key === param);
    if (!item) { pushToast('Registro de teste não encontrado na lista atual.', 'error'); return; }
    const ok = await appConfirm({
      title: 'Remover dado de teste?',
      description: `${item.rotulo} · ${item.sub}`,
      confirmLabel: item.tipo === 'conta' ? 'Arquivar conta' : 'Remover',
      cancelLabel: 'Cancelar',
      variant: 'danger'
    });
    if (!ok) return;
    try {
      await cleanupTestDataItem(item);
      await refreshAll(item.tipo === 'conta' ? 'Conta de teste arquivada.' : 'Dado de teste removido.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao remover dado de teste.', 'error');
    }
  },

  'cleanup-test-data-all': async () => {
    const itens = testDataCandidates();
    if (!itens.length) { pushToast('Nenhum dado de teste visível encontrado.', 'info'); return; }
    const ok = await appConfirm({
      title: `Remover ${itens.length} dado(s) de teste?`,
      description: 'A lista exibida em Pendências será processada. Contas bancárias serão arquivadas para preservar histórico.',
      confirmLabel: 'Remover todos',
      cancelLabel: 'Cancelar',
      variant: 'danger'
    });
    if (!ok) return;
    let removidos = 0;
    try {
      for (const item of itens) {
        await cleanupTestDataItem(item);
        removidos += 1;
      }
      await refreshAll(`${removidos} dado(s) de teste removido(s).`);
    } catch (err) {
      await refreshAll(`${removidos} dado(s) removido(s); houve falha no restante.`);
      pushToast(err?.message || 'Falha ao remover todos os dados de teste.', 'error');
    }
  },

  // Chips "Hoje"/"Ontem" no modal de lançamento — registro retroativo de véspera
  // vira 1 clique em vez de abrir o datepicker (D10 do SDD).
  'lancamento-data-rapida': (param, el) => {
    const form = el?.closest?.('form[data-form]');
    const input = form?.querySelector('[name="data"]');
    if (!input) return;
    const alvo = param === 'ontem' ? new Date(Date.now() - 86400000) : new Date();
    input.value = dateToInput(alvo);
    syncModalForm(form);
  },

  // Atualiza o texto-guia da categoria no modal de lançamento (sem re-render, pra
  // não fechar o select). Lê o data-hint da opção selecionada.
  'cat-hint': (_param, el) => {
    const slot = document.getElementById('cat-hint');
    if (!slot) return;
    slot.textContent = el?.selectedOptions?.[0]?.dataset?.hint || '';
  },

  'open-modal-receber': () => {
    state.modal = {
      type: 'receber',
      form: {
        devedor_nome: '',
        valor: '',
        vencimento: todayInputValue(),
        categoria_id: '',
        descricao: '',
        conta_bancaria_id: defaultContaId('empresarial')
      }
    };
    renderApp();
  },

  'open-modal-receber-edit': (param) => {
    const item = (state.data.contasReceber || []).find((c) => c.id === param);
    if (!item) return;
    state.modal = {
      type: 'receber',
      editingId: item.id,
      form: {
        devedor_nome: item.devedor_nome || '',
        valor: Number(item.valor || 0).toFixed(2),
        vencimento: String(item.vencimento || '').slice(0, 10) || todayInputValue(),
        categoria_id: item.categoria_id || '',
        descricao: item.descricao || '',
        conta_bancaria_id: item.conta_bancaria_id || defaultContaId('empresarial')
      }
    };
    renderApp();
  },

  'open-modal-pagar': () => {
    state.modal = {
      type: 'pagar',
      form: {
        credor: '',
        valor: '',
        vencimento: todayInputValue(),
        descricao: '',
        categoria_id: '',
        conta_bancaria_id: defaultContaId('empresarial')
      }
    };
    renderApp();
  },

  'open-modal-pagar-edit': (param) => {
    const item = (state.data.contasPagar || []).find((c) => c.id === param);
    if (!item) return;
    state.modal = {
      type: 'pagar',
      editingId: item.id,
      form: {
        credor: item.credor || '',
        valor: Number(item.valor || 0).toFixed(2),
        vencimento: String(item.vencimento || '').slice(0, 10) || todayInputValue(),
        descricao: item.descricao || '',
        categoria_id: item.categoria_id || '',
        conta_bancaria_id: item.conta_bancaria_id || defaultContaId('empresarial')
      }
    };
    renderApp();
  },

  'open-modal-divida': () => {
    state.modal = {
      type: 'divida',
      form: { credor: '', tipo: 'cartao_credito', saldo_devedor: '', taxa_juros: '', data_inicio: todayInputValue(), data_vencimento: '' }
    };
    renderApp();
  },

  'open-modal-divida-edit': (param) => {
    const item = (state.data.dividas || []).find((d) => String(d.id) === String(param));
    if (!item) { pushToast('Dívida não encontrada.', 'error'); return; }
    state.modal = {
      type: 'divida',
      editingId: item.id,
      form: {
        credor: item.credor || '',
        tipo: item.tipo || 'cartao_credito',
        valor_original: Number(item.valor_original || item.saldo_devedor || 0).toFixed(2),
        saldo_devedor: Number(item.saldo_devedor || 0).toFixed(2),
        taxa_juros: item.taxa_juros == null ? '' : String(item.taxa_juros),
        data_inicio: String(item.data_inicio || '').slice(0, 10) || todayInputValue(),
        data_vencimento: String(item.data_vencimento || '').slice(0, 10),
        descricao: item.descricao || ''
      }
    };
    renderApp();
  },

  'delete-divida': async (param) => {
    if (!param) return;
    if (!(await appConfirm({
      title: 'Excluir dívida?',
      description: 'A dívida será removida. Se houver eventos registrados, o histórico será preservado e a exclusão será bloqueada.',
      confirmLabel: 'Excluir',
      variant: 'danger'
    }))) return;
    try {
      await api.deleteDivida(param);
      await refreshAll('Dívida excluída.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao excluir.', 'error');
    }
  },

  'open-modal-meta': () => {
    state.modal = {
      type: 'meta',
      form: { titulo: '', valor_alvo: '', prazo: '' }
    };
    renderApp();
  },

  'open-modal-meta-edit': (param) => {
    const item = (state.data.metas || []).find((m) => String(m.id) === String(param));
    if (!item) { pushToast('Meta não encontrada.', 'error'); return; }
    state.modal = {
      type: 'meta',
      editingId: item.id,
      form: {
        titulo: item.nome || item.titulo || '',
        valor_alvo: Number(item.valor_alvo || 0).toFixed(2),
        prazo: String(item.prazo || '').slice(0, 10)
      }
    };
    renderApp();
  },

  'open-modal-meta-aporte': (param) => {
    const item = (state.data.metas || []).find((m) => String(m.id) === String(param));
    if (!item) { pushToast('Meta não encontrada.', 'error'); return; }
    state.modal = {
      type: 'meta-aporte',
      editingId: item.id,
      form: { meta_nome: item.nome || item.titulo || '', valor: '' }
    };
    renderApp();
  },

  'delete-meta': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Excluir meta?', description: 'A meta será cancelada e sai da lista. O histórico de aportes não mexe no saldo das contas.', confirmLabel: 'Excluir', variant: 'danger' }))) return;
    try {
      await api.deleteMeta(param);
      await refreshAll('Meta excluída.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao excluir.', 'error');
    }
  },

  'open-modal-orcamento': () => {
    const categoria = categoriasDoWorkspace()
      .find((c) => c.ativo !== 0 && (!c.natureza || c.natureza === 'despesa'));
    const mes = currentMonthInput();
    const periodo = defaultPeriod(mes);
    state.modal = {
      type: 'orcamento',
      form: {
        categoria_id: categoria?.id || '',
        mes,
        limite: '',
        data_inicio: periodo.inicio,
        data_fim: periodo.fim
      }
    };
    renderApp();
  },

  'open-modal-orcamento-edit': (param) => {
    const item = (state.data.orcamentos || []).find((o) => String(o.id) === String(param));
    if (!item) { pushToast('Orçamento não encontrado.', 'error'); return; }
    state.modal = {
      type: 'orcamento',
      editingId: item.id,
      form: {
        categoria_id: item.categoria_id || '',
        mes: String(item.mes || currentMonthInput()).slice(0, 7),
        limite: Number(item.limite || 0).toFixed(2),
        data_inicio: String(item.data_inicio || '').slice(0, 10),
        data_fim: String(item.data_fim || '').slice(0, 10)
      }
    };
    renderApp();
  },

  'open-modal-finance-user': (param) => {
    const editing = param ? (state.data.financeUsers || []).find((u) => u.id === param) : null;
    state.modal = {
      type: 'finance-user',
      editingId: editing?.id || null,
      form: editing
        ? { username: editing.username, nome: editing.nome, role: editing.role }
        : { username: '', nome: '', role: 'usuario' }
    };
    renderApp();
  },

  'close-modal': () => {
    closeModal();
  },

  // === Submits ===
  'submit-modal': async (_param, _el, evt) => {
    const form = evt?.target?.closest?.('form[data-form]');
    const formType = form?.getAttribute('data-form');
    if (!form || !formType) return;
    if (modalSubmitInFlight) return;

    syncModalForm(form);
    modalSubmitInFlight = true;
    setModalError('');
    setModalSubmitting(form, true);

    const data = new FormData(form);
    const get = (k) => String(data.get(k) || '').trim();
    const num = (k) => Number(String(data.get(k) || '0').replace(',', '.'));

    try {
      if (formType === 'transacao') {
        const payload = {
          tipo: get('tipo'),
          valor: num('valor'),
          data: get('data'),
          descricao: get('titulo') || null,
          categoria_id: get('categoria_id') || null,
          conta_bancaria_id: get('conta_bancaria_id') || null
        };
        if (!get('valor')) throw new Error('Valor obrigatório.');
        if (!(payload.valor > 0)) throw new Error('O valor deve ser maior que zero.');
        if (!payload.data) throw new Error('Data obrigatória.');
        if (!payload.categoria_id) throw new Error('Categoria obrigatória.');
        if (!payload.conta_bancaria_id) throw new Error('Conta bancária obrigatória.');
        const editingId = state.modal?.editingId;
        const andNew = !editingId && evt?.submitter?.dataset?.andNew === '1';
        if (editingId) {
          const resp = await api.putTransacao(editingId, payload);
          state.modal = null;
          await refreshAll('Lançamento atualizado!');
          notifyOrcamentoEstourado(resp);
        } else {
          const resp = await api.postTransacao(payload);
          notifyOrcamentoEstourado(resp);
          rememberLancamento(state.workspace, payload.tipo, {
            categoria_id: payload.categoria_id,
            conta_bancaria_id: payload.conta_bancaria_id
          });
          if (andNew) {
            try { await loadAllData(); } catch (err) { pushToast('Erro ao recarregar: ' + err.message, 'error'); }
            state.modal = {
              type: 'transacao',
              form: {
                tipo: payload.tipo,
                titulo: '',
                valor: '',
                data: payload.data,
                categoria_id: payload.categoria_id,
                conta_bancaria_id: payload.conta_bancaria_id
              }
            };
            renderApp();
            scheduleModalFocus('valor');
            pushToast('Lançamento salvo! Pronto para o próximo.', 'success');
          } else {
            state.modal = null;
            await refreshAll('Transação salva!');
          }
        }
        return;
      }

      if (formType === 'conta') {
        const payload = {
          nome: get('nome'),
          tipo: get('tipo') || 'corrente',
          moeda: get('moeda') || 'BRL',
          escopo: get('escopo') || (state.workspace === 'empresarial' ? 'empresarial' : 'pessoal'),
          saldo_inicial: num('saldo_inicial'),
          saldo: num('saldo'),
          cor: get('cor') || '#22d3ee'
        };
        if (!payload.nome) throw new Error('Nome obrigatório.');
        const editingId = state.modal?.editingId;
        if (editingId) {
          await api.putConta(editingId, { nome: payload.nome, tipo: payload.tipo, moeda: payload.moeda, cor: payload.cor });
          state.modal = null;
          await refreshAll('Conta atualizada!');
        } else {
          await api.postConta(payload);
          state.modal = null;
          await refreshAll('Conta criada!');
        }
        return;
      }

      if (formType === 'settings-moeda') {
        const moeda = get('moeda');
        if (!moeda) throw new Error('Selecione uma moeda.');
        const resp = await apiFetch('/api/finance/auth/me/moeda', { method: 'PATCH', body: { moeda } });
        const nova = String(resp?.moeda_pessoal || moeda).toUpperCase();
        if (state.currentUser) state.currentUser.moeda_pessoal = nova;
        state.modal = null;
        // refreshAll re-consolida a dashboard na nova moeda-base (o backend lê o
        // moeda_base da empresa pessoal, que acabou de mudar).
        await refreshAll('Moeda padrão atualizada!');
        return;
      }

      if (formType === 'categoria') {
        const checked = (n) => !!form.querySelector(`[name="${n}"]`)?.checked;
        const isCatEmp = state.workspace === 'empresarial';
        const catScope = isCatEmp ? 'empresarial' : 'pessoal';
        const payload = {
          nome: get('nome'),
          tipo: get('tipo') || catScope,
          escopo: get('tipo') || catScope,
          natureza: get('natureza') || null,
          comportamento: isCatEmp ? (get('comportamento') || null) : null,
          dre_secao: isCatEmp ? (get('dre_secao') || null) : null,
          usar_no_dre: isCatEmp && checked('usar_no_dre') ? 1 : 0,
          usar_na_precificacao: isCatEmp && checked('usar_na_precificacao') ? 1 : 0,
          cor: get('cor') || '#64748b'
        };
        if (!payload.nome) throw new Error('Nome obrigatório.');
        const editingId = state.modal?.editingId;
        if (editingId) {
          await api.putCategoria(editingId, payload);
          state.modal = null;
          await refreshAll('Categoria atualizada!');
        } else {
          await api.postCategoria(payload);
          state.modal = null;
          await refreshAll('Categoria criada!');
        }
        return;
      }

      if (formType === 'receber') {
        const payload = {
          devedor_nome: get('devedor_nome'),
          valor: num('valor'),
          vencimento: get('vencimento'),
          categoria_id: get('categoria_id') || null,
          descricao: get('descricao') || null,
          conta_bancaria_id: get('conta_bancaria_id') || null
        };
        if (!payload.devedor_nome) throw new Error('Devedor obrigatório.');
        if (!get('valor')) throw new Error('Valor obrigatório.');
        if (!(payload.valor > 0)) throw new Error('O valor deve ser maior que zero.');
        if (!payload.conta_bancaria_id) throw new Error('Conta bancária obrigatória.');
        const editingId = state.modal?.editingId;
        if (editingId) {
          await api.putContaReceber(editingId, payload);
          state.modal = null;
          await refreshAll('Conta a receber atualizada!');
        } else {
          await api.postContaReceber(payload);
          state.modal = null;
          await refreshAll('Conta a receber criada!');
        }
        return;
      }

      if (formType === 'pagar') {
        const payload = {
          credor: get('credor'),
          valor: num('valor'),
          vencimento: get('vencimento'),
          descricao: get('descricao') || null,
          categoria_id: get('categoria_id') || null,
          conta_bancaria_id: get('conta_bancaria_id') || null
        };
        if (!payload.credor) throw new Error('Credor obrigatório.');
        if (!get('valor')) throw new Error('Valor obrigatório.');
        if (!(payload.valor > 0)) throw new Error('O valor deve ser maior que zero.');
        if (!payload.categoria_id) throw new Error('Categoria obrigatória');
        if (!payload.conta_bancaria_id) throw new Error('Conta bancária obrigatória.');
        const editingId = state.modal?.editingId;
        if (editingId) {
          await api.putContaPagar(editingId, payload);
          state.modal = null;
          await refreshAll('Conta a pagar atualizada!');
        } else {
          await api.postContaPagar(payload);
          state.modal = null;
          await refreshAll('Conta a pagar criada!');
        }
        return;
      }

      if (formType === 'receber-baixa') {
        const id = state.modal?.form?.id;
        const valor = num('valor');
        if (!id) throw new Error('Registro inválido.');
        if (!valor || valor <= 0) throw new Error('Informe o valor recebido.');
        if (!get('data')) throw new Error('Informe a data.');
        if (!get('conta_bancaria_id')) throw new Error('Conta bancária obrigatória.');
        await api.patchReceber(id, {
          valor_recebido: valor,
          data_recebimento: get('data'),
          conta_bancaria_id: get('conta_bancaria_id')
        });
        state.modal = null;
        await refreshAll('Recebimento registrado!');
        return;
      }

      if (formType === 'pagar-baixa') {
        const id = state.modal?.form?.id;
        const valor = num('valor');
        if (!id) throw new Error('Registro inválido.');
        if (!valor || valor <= 0) throw new Error('Informe o valor pago.');
        if (!get('data')) throw new Error('Informe a data.');
        if (!get('conta_bancaria_id')) throw new Error('Conta bancária obrigatória.');
        await api.patchPagar(id, {
          valor_pago: valor,
          data_pagamento: get('data'),
          conta_bancaria_id: get('conta_bancaria_id')
        });
        state.modal = null;
        await refreshAll('Pagamento registrado!');
        return;
      }

      if (formType === 'divida') {
        const valorOriginal = get('valor_original') || get('saldo_devedor');
        const payload = {
          credor: get('credor'),
          tipo: get('tipo') || 'cartao_credito',
          valor_original: Number(valorOriginal),
          saldo_devedor: num('saldo_devedor'),
          data_inicio: get('data_inicio') || todayInputValue(),
          data_vencimento: get('data_vencimento') || null,
          taxa_juros: get('taxa_juros') ? num('taxa_juros') : null,
          descricao: get('descricao') || null
        };
        if (!payload.credor) throw new Error('Credor obrigatório.');
        if (!valorOriginal || !(payload.valor_original > 0)) throw new Error('Valor original obrigatório.');
        if (get('saldo_devedor') === '') throw new Error('Saldo obrigatório.');
        if (!(payload.saldo_devedor >= 0)) throw new Error('Saldo deve ser maior ou igual a zero.');
        if (!payload.data_inicio) throw new Error('Data de início obrigatória.');
        const editingId = state.modal?.editingId;
        if (editingId) {
          await api.putDivida(editingId, payload);
          state.modal = null;
          await refreshAll('Dívida atualizada!');
        } else {
          await api.postDivida(payload);
          state.modal = null;
          await refreshAll('Dívida cadastrada!');
        }
        return;
      }

      if (formType === 'meta') {
        const payload = {
          nome: get('titulo'),
          valor_alvo: num('valor_alvo'),
          prazo: get('prazo') || null
        };
        if (!payload.nome) throw new Error('Título obrigatório.');
        if (!payload.valor_alvo) throw new Error('Valor alvo obrigatório.');
        const editingId = state.modal?.editingId;
        if (editingId) {
          await api.putMeta(editingId, payload);
          state.modal = null;
          await refreshAll('Meta atualizada!');
        } else {
          await api.postMeta(payload);
          state.modal = null;
          await refreshAll('Meta criada!');
        }
        return;
      }

      if (formType === 'meta-aporte') {
        const valor = num('valor');
        if (!get('valor')) throw new Error('Valor obrigatório.');
        if (!(valor > 0)) throw new Error('O valor deve ser maior que zero.');
        const metaId = state.modal?.editingId;
        if (!metaId) throw new Error('Meta não encontrada.');
        await api.patchMetaAporte(metaId, { valor });
        state.modal = null;
        await refreshAll('Aporte registrado!');
        return;
      }

      if (formType === 'orcamento') {
        const payload = {
          categoria_id: get('categoria_id') || null,
          mes: get('mes') || currentMonthInput(),
          limite: num('limite'),
          data_inicio: get('data_inicio'),
          data_fim: get('data_fim')
        };
        if (!payload.categoria_id) throw new Error('Categoria obrigatória.');
        if (!get('limite')) throw new Error('Limite obrigatório.');
        if (!(payload.limite > 0)) throw new Error('Limite deve ser maior que zero.');
        if (!payload.data_inicio || !payload.data_fim) throw new Error('Período obrigatório.');
        if (payload.data_fim < payload.data_inicio) throw new Error('Data final deve ser maior ou igual a inicial.');
        const editingId = state.modal?.editingId;
        if (editingId) {
          await api.putOrcamento(editingId, { mes: payload.mes, limite: payload.limite, data_inicio: payload.data_inicio, data_fim: payload.data_fim });
          state.modal = null;
          await refreshAll('Orçamento atualizado!');
        } else {
          await api.postOrcamento(payload);
          state.modal = null;
          await refreshAll('Orçamento criado!');
        }
        return;
      }

      if (formType === 'finance-user') {
        const payload = {
          username: get('username'),
          nome: get('nome'),
          role: get('role') || 'usuario'
        };
        const password = String(data.get('password') || '');
        const editingId = state.modal?.editingId;
        if (editingId) {
          await apiFetch(`/api/finance/users/${editingId}`, { method: 'PUT', body: payload });
          if (password) {
            await apiFetch(`/api/finance/users/${editingId}/password`, { method: 'PATCH', body: { password } });
          }
        } else {
          if (!password) throw new Error('Senha obrigatória para novo usuário.');
          await apiFetch('/api/finance/users', { method: 'POST', body: { ...payload, password } });
        }
        state.modal = null;
        await loadFinanceUsers();
        renderApp();
        pushToast('Usuário salvo!', 'success');
        return;
      }
    } catch (err) {
      const message = err?.message || 'Falha ao salvar.';
      setModalError(message);
      pushToast(message, 'error', 3500, { toastOnly: true });
    } finally {
      modalSubmitInFlight = false;
      if (state.modal) setModalSubmitting(form, false);
      else requestAnimationFrame(restoreModalFocus);
    }
  },

  // === Ações de linha ===
  'delete-transacao': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Excluir lançamento?', description: 'Essa ação pode alterar saldo, DRE, fluxo de caixa e relatórios. Deseja continuar?', confirmLabel: 'Excluir lançamento', variant: 'danger' }))) return;
    try {
      await api.deleteTransacao(param);
      await refreshAll('Transação excluída.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao excluir.', 'error');
    }
  },

  // === Lixeira ===
  'filter-lixeira': (param) => {
    state.filters.lixeiraEntidade = param || 'todas';
    renderApp();
  },
  'toggle-lixeira-global': async () => {
    state.filters.lixeiraGlobal = !state.filters.lixeiraGlobal;
    await loadLixeira();
    renderApp();
  },
  'restaurar-lixeira': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Restaurar item?', description: 'O item volta a aparecer normalmente no sistema, junto com tudo que foi excluído na mesma operação.', confirmLabel: 'Restaurar', variant: 'default' }))) return;
    try {
      await api.restaurarLixeira(param);
      await Promise.all([loadLixeira(), loadAllData()]);
      renderApp();
      pushToast('Item restaurado.', 'success');
    } catch (err) {
      pushToast(err?.message || 'Falha ao restaurar.', 'error');
    }
  },
  'purgar-lixeira': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Excluir definitivamente?', description: 'Essa ação apaga o dado da lixeira para sempre. Não é possível desfazer.', confirmLabel: 'Excluir para sempre', variant: 'danger' }))) return;
    try {
      await api.purgarLixeira(param);
      await loadLixeira();
      renderApp();
      pushToast('Item excluído definitivamente.', 'success');
    } catch (err) {
      pushToast(err?.message || 'Falha ao excluir definitivamente.', 'error');
    }
  },

  'delete-conta': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Excluir conta bancária?', description: 'O saldo desta conta será perdido. Prefira arquivar se quiser manter o histórico.', confirmLabel: 'Excluir conta', variant: 'danger' }))) return;
    try {
      await api.deleteConta(param);
      await refreshAll('Conta excluída.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao excluir.', 'error');
    }
  },

  'delete-finance-user': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Excluir usuário?', description: 'O acesso deste usuário será removido.', confirmLabel: 'Excluir usuário', variant: 'danger' }))) return;
    try {
      await apiFetch(`/api/finance/users/${param}`, { method: 'DELETE' });
      await loadFinanceUsers();
      pushToast('Usuário excluído.', 'success');
      renderApp();
    } catch (err) {
      pushToast(err?.message || 'Falha ao excluir.', 'error');
    }
  },

  'marcar-recebido': (param) => {
    const item = (state.data.contasReceber || []).find((c) => c.id === param);
    if (!item) return;
    const restante = Number(item.valor) - Number(item.valor_pago || 0);
    state.modal = {
      type: 'receber-baixa',
      form: {
        id: param,
        titulo: item.devedor_nome,
        valor: restante > 0 ? restante.toFixed(2) : '',
        data: todayInputValue(),
        conta_bancaria_id: item.conta_bancaria_id || defaultContaId('empresarial'),
        restanteLabel: formatCurrency(restante)
      }
    };
    renderApp();
  },

  'marcar-pago': (param) => {
    const item = (state.data.contasPagar || []).find((c) => c.id === param);
    if (!item) return;
    const restante = Number(item.valor) - Number(item.valor_pago || 0);
    state.modal = {
      type: 'pagar-baixa',
      form: {
        id: param,
        titulo: item.credor,
        valor: restante > 0 ? restante.toFixed(2) : '',
        data: todayInputValue(),
        conta_bancaria_id: item.conta_bancaria_id || defaultContaId('empresarial'),
        restanteLabel: formatCurrency(restante)
      }
    };
    renderApp();
  },

  'delete-categoria': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Excluir categoria?', description: 'Só é possível excluir categorias sem lançamentos. Caso contrário, inative.', confirmLabel: 'Excluir categoria', variant: 'danger' }))) return;
    try {
      await api.deleteCategoria(param);
      await refreshAll('Categoria excluída.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao excluir.', 'error');
    }
  },

  'delete-receber': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Excluir conta a receber?', description: 'Este registro pode já ter gerado movimentação. Ao continuar, as baixas existentes serão estornadas e o saldo da conta recalculado.', confirmLabel: 'Excluir', variant: 'danger' }))) return;
    try {
      await api.deleteContaReceber(param);
      await refreshAll('Conta a receber excluída.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao excluir.', 'error');
    }
  },

  'delete-pagar': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Excluir conta a pagar?', description: 'Este registro pode já ter gerado movimentação. Ao continuar, as baixas existentes serão estornadas e o saldo da conta recalculado.', confirmLabel: 'Excluir', variant: 'danger' }))) return;
    try {
      await api.deleteContaPagar(param);
      await refreshAll('Conta a pagar excluída.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao excluir.', 'error');
    }
  },

  'delete-orcamento': async (param) => {
    if (!param) return;
    if (!(await appConfirm({ title: 'Excluir orçamento?', description: 'Remove apenas o limite mensal. Lançamentos e categorias permanecem intactos.', confirmLabel: 'Excluir', variant: 'danger' }))) return;
    try {
      await api.deleteOrcamento(param);
      await refreshAll('Orçamento excluído.');
    } catch (err) {
      pushToast(err?.message || 'Falha ao excluir.', 'error');
    }
  },

  'refresh': () => refreshAll('Atualizado.'),

  'refresh-users': async () => {
    try { await loadFinanceUsers(); renderApp(); }
    catch (err) { pushToast(err?.message || 'Falha.', 'error'); }
  },

  'toggle-theme': () => {
    pushToast('Light mode em breve.', 'info');
  },

  'logout': async () => { await logout(); }
};

// === Event delegation ===
document.addEventListener('click', (evt) => {
  if ((state.filters.dreCalendarOpen || state.filters.dashCalendarOpen) && !evt.target.closest('.dre-month-control')) {
    state.filters.dreCalendarOpen = false;
    state.filters.dashCalendarOpen = false;
    renderApp();
  }

  if (evt.target && evt.target.id === 'modal-backdrop') {
    ACTIONS['close-modal']();
    return;
  }
  const el = evt.target.closest('[data-action]');
  if (!el) return;
  // Campos de formulário (input/select/textarea) com data-action são tratados
  // no listener de `change` — clicar dentro deles não deve disparar a ação nem
  // bloquear o foco/edição.
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
  const action = el.getAttribute('data-action');
  const param = el.getAttribute('data-param') || '';
  const fn = ACTIONS[action];
  if (typeof fn === 'function') {
    if (actionOpensModal(action) && !state.modal) rememberModalOpener(el);
    evt.preventDefault();
    Promise.resolve(fn(param, el, evt))
      .then(() => {
        if (actionOpensModal(action) && state.modal) scheduleModalFocus();
      })
      .catch((err) => {
        pushToast('Erro: ' + (err?.message || err), 'error');
      });
  }
});

document.addEventListener('submit', (evt) => {
  const cambioForm = evt.target.closest('form[data-dash-cambio]');
  if (cambioForm) {
    evt.preventDefault();
    const uid = cambioForm.getAttribute('data-dash-cambio') || '';
    Promise.resolve(ACTIONS['dash-cambio-converter'](uid)).catch((err) => {
      pushToast('Erro: ' + (err?.message || err), 'error');
    });
    return;
  }
  const form = evt.target.closest('form[data-form]');
  if (!form) return;
  evt.preventDefault();
  if (!canWriteFinance()) {
    pushToast('Seu acesso é somente para visualização.', 'error');
    return;
  }
  syncModalForm(form);
  Promise.resolve(ACTIONS['submit-modal'](null, form, evt)).catch((err) => {
    pushToast('Erro: ' + (err?.message || err), 'error');
  });
});

document.addEventListener('input', (evt) => {
  const form = evt.target?.closest?.('#modal-backdrop form[data-form]');
  if (form) syncModalForm(form);

  // Busca ao vivo na tela Categorias: filtra a cada tecla (não só no blur) e
  // restaura foco + cursor após o re-render, pra digitação não travar.
  const el = evt.target;
  if (el?.getAttribute?.('data-action') === 'dash-cambio-valor') {
    const uid = el.getAttribute('data-param') || '';
    dashSetCambioConfig(curWs(), uid, 'valor', el.value);
    scheduleCambioInput(uid);
    return;
  }
  if (el?.getAttribute?.('data-action') === 'search-categoria') {
    const f = state.filters.categorias || (state.filters.categorias = {});
    f.busca = el.value ?? '';
    const caret = el.selectionStart;
    renderApp();
    const novo = document.querySelector('[data-action="search-categoria"]');
    if (novo) { novo.focus(); try { novo.setSelectionRange(caret, caret); } catch (_) {} }
  }
});

// Selects e inputs com [data-action] (seletor de empresa, edição do DRE) usam o
// evento change, passando o data-param (ou o valor, p/ selects) como argumento.
document.addEventListener('change', (evt) => {
  const el = evt.target;
  const modalForm = el?.closest?.('#modal-backdrop form[data-form]');
  if (modalForm) syncModalForm(modalForm);
  if (!el || !el.hasAttribute('data-action')) return;
  if (el.tagName !== 'SELECT' && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
  const action = el.getAttribute('data-action');
  const fn = ACTIONS[action];
  if (typeof fn !== 'function') return;
  // Selects sem data-param passam o valor; os demais usam data-param e leem
  // el.value internamente.
  const arg = el.hasAttribute('data-param') ? el.getAttribute('data-param') : el.value;
  Promise.resolve(fn(arg, el, evt)).catch((err) => {
    pushToast('Erro: ' + (err?.message || err), 'error');
  });
});

// DRE planilha: acumula a edição da célula no lote ao vivo (sem re-render, p/ não
// perder o foco) e atualiza o contador do botão Salvar.
document.addEventListener('input', (evt) => {
  const el = evt.target;
  if (!el?.classList?.contains('dre-meta-input') && !el?.classList?.contains('dre-ajuste-input')) return;
  const linha = el.getAttribute('data-linha');
  const field = el.getAttribute('data-field');
  if (!linha || !field) return;
  const pend = state.filters.drePending || (state.filters.drePending = {});
  (pend[linha] = pend[linha] || {})[field] = el.value;
  el.classList.add('is-dirty');
  updateDreSaveButton();
});

// DRE planilha: navegação tipo planilha entre células editáveis da MESMA coluna.
// Enter/↓ desce, Shift+Enter/↑ sobe; Tab/Shift+Tab seguem o fluxo nativo (linha).
document.addEventListener('keydown', (evt) => {
  const el = evt.target;
  if (!el?.classList?.contains('dre-meta-input') && !el?.classList?.contains('dre-ajuste-input')) return;
  const down = (evt.key === 'Enter' && !evt.shiftKey) || evt.key === 'ArrowDown';
  const up   = (evt.key === 'Enter' && evt.shiftKey)  || evt.key === 'ArrowUp';
  if (!down && !up) return;
  // Em input number, ↑/↓ incrementa o valor — bloqueia p/ usar como navegação.
  if (evt.key === 'ArrowUp' || evt.key === 'ArrowDown') evt.preventDefault();
  const field = el.getAttribute('data-field');
  const card = el.closest('.dre-edit-lines, .dre-card');
  if (!field || !card) return;
  const inputs = [...card.querySelectorAll(`input[data-field="${field}"]`)];
  const next = inputs[inputs.indexOf(el) + (down ? 1 : -1)];
  if (next) {
    evt.preventDefault();
    next.focus();
    if (typeof next.select === 'function') next.select();
  }
});

// Diálogo interno (confirm/prompt): Escape cancela; Enter confirma no prompt.
document.addEventListener('keydown', (evt) => {
  if (!state.dialog) return;
  if (evt.key === 'Escape') {
    evt.preventDefault();
    resolveDialog(state.dialog.kind === 'prompt' ? null : false);
  } else if (evt.key === 'Enter' && state.dialog.kind === 'prompt') {
    evt.preventDefault();
    resolveDialog(document.getElementById('dialog-input')?.value ?? '');
  }
}, true);

// Drawer "Editar dados do DRE": Escape fecha (não é um modal do sistema).
document.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Escape' || state.modal || !state.filters.dreEdit) return;
  if (state.filters.dreFormulaDraft) { state.filters.dreFormulaDraft = null; renderApp(); return; }
  state.filters.dreEdit = false;
  state.filters.dreMapOpen = false;
  renderApp();
});

document.addEventListener('keydown', (evt) => {
  if (!state.modal) return;
  if (evt.key === 'Escape') {
    evt.preventDefault();
    closeModal();
    return;
  }
  if (evt.key !== 'Tab') return;
  const focusables = modalFocusables();
  if (!focusables.length) {
    evt.preventDefault();
    document.querySelector('#modal-backdrop .modal-card')?.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (evt.shiftKey && document.activeElement === first) {
    evt.preventDefault();
    last.focus();
  } else if (!evt.shiftKey && document.activeElement === last) {
    evt.preventDefault();
    first.focus();
  }
});

// Acessibilidade: Enter/Espaço ativam elementos role="button" com data-action
// que não são botões nativos (ex.: linhas clicáveis da cascata DRE no dashboard).
document.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Enter' && evt.key !== ' ') return;
  const el = evt.target;
  if (!el?.getAttribute || el.getAttribute('role') !== 'button' || !el.hasAttribute('data-action')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(el.tagName)) return;
  const fn = ACTIONS[el.getAttribute('data-action')];
  if (typeof fn !== 'function') return;
  evt.preventDefault();
  Promise.resolve(fn(el.getAttribute('data-param') || '', el, evt)).catch((err) => {
    pushToast('Erro: ' + (err?.message || err), 'error');
  });
});

window.addEventListener('beforeunload', (evt) => {
  if (!state.pricing?.dirty) return;
  evt.preventDefault();
  evt.returnValue = '';
});

// === Arraste dos widgets do dashboard modular (Pointer Events) ===
// Arraste fluido com mouse/toque: pega o card de qualquer lugar (menos controles),
// segue o cursor e um placeholder mostra onde vai cair. O estado só muda no soltar
// (renderApp recria o DOM via innerHTML, então mexemos no DOM direto durante o gesto).
const DRAG_THRESHOLD = 5;
const TOUCH_HOLD_MS = 240;
const EDGE_SCROLL_ZONE = 72;
const EDGE_SCROLL_MAX = 18;
let dnd = null;
let dndScrollFrame = null;
let dashResize = null;

function clearDndTimers() {
  if (dnd?.touchTimer) clearTimeout(dnd.touchTimer);
  if (dndScrollFrame) cancelAnimationFrame(dndScrollFrame);
  dndScrollFrame = null;
}

function dashGridMetrics(grid) {
  const style = getComputedStyle(grid);
  const columns = Number.parseInt(grid.dataset.dashColumns, 10) || 4;
  const gapX = Number.parseFloat(style.columnGap) || 14;
  const gapY = Number.parseFloat(style.rowGap) || 14;
  const rect = grid.getBoundingClientRect();
  return {
    columns, gapX, gapY, rect,
    colWidth: (rect.width - gapX * (columns - 1)) / columns,
    rowHeight: Number.parseFloat(style.gridAutoRows) || 88
  };
}

function applyDashPreview(grid, layout, ignoredUid = '') {
  const byUid = new Map((layout || []).map((rect) => [rect.uid, rect]));
  grid.querySelectorAll('.dash-widget').forEach((widget) => {
    const uid = widget.getAttribute('data-dash-uid');
    if (uid === ignoredUid) return;
    const rect = byUid.get(uid);
    if (!rect) return;
    widget.style.gridColumn = `${rect.x + 1} / span ${rect.w}`;
    widget.style.gridRow = `${rect.y + 1} / span ${rect.h}`;
  });
}

function dndCleanup() {
  if (!dnd) return;
  clearDndTimers();
  const { el, grid, placeholder, pointerId, handle, originals } = dnd;
  if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
  if (el) {
    el.classList.remove('dash-dragging');
    ['position', 'left', 'top', 'width', 'height', 'z-index', 'pointer-events', 'margin']
      .forEach((p) => el.style.removeProperty(p));
  }
  originals?.forEach((original, widget) => {
    if (!widget?.isConnected) return;
    widget.style.gridColumn = original.gridColumn;
    widget.style.gridRow = original.gridRow;
  });
  if (placeholder && placeholder.parentElement) placeholder.parentElement.removeChild(placeholder);
  document.body.classList.remove('dash-dragging-active');
  window.removeEventListener('pointermove', dndMove, true);
  window.removeEventListener('pointerup', dndUp, true);
  window.removeEventListener('pointercancel', dndCancel, true);
  window.removeEventListener('touchmove', dndTouchMove, true);
  window.removeEventListener('blur', dndCancel, true);
  dnd = null;
}

function activateDrag(evt) {
  if (!dnd || dnd.active || !dnd.el?.isConnected) return;
  if (dnd.touchTimer) clearTimeout(dnd.touchTimer);
  dnd.touchTimer = null;
  const { el } = dnd;
  const r = el.getBoundingClientRect();
  dnd.offX = dnd.startX - r.left;
  dnd.offY = dnd.startY - r.top;
  dnd.originals = new Map(Array.from(dnd.grid.querySelectorAll('.dash-widget')).map((widget) => [widget, {
    gridColumn: widget.style.gridColumn,
    gridRow: widget.style.gridRow
  }]));
  const ph = document.createElement('div');
  ph.className = 'dash-drop-placeholder';
  ph.style.gridColumn = `${dnd.startCellX + 1} / span ${dnd.w}`;
  ph.style.gridRow = `${dnd.startCellY + 1} / span ${dnd.h}`;
  dnd.grid.appendChild(ph);
  dnd.placeholder = ph;
  // levanta o card e fixa as dimensões
  el.style.width = r.width + 'px';
  el.style.height = r.height + 'px';
  el.style.position = 'fixed';
  el.style.zIndex = '1000';
  el.style.pointerEvents = 'none';
  el.style.margin = '0';
  el.classList.add('dash-dragging');
  document.body.classList.add('dash-dragging-active');
  dnd.handle.setPointerCapture?.(dnd.pointerId);
  dnd.active = true;
  dnd.lastX = evt.clientX;
  dnd.lastY = evt.clientY;
  positionDrag(evt.clientX, evt.clientY);
  placePlaceholder(evt.clientX, evt.clientY);
}

function positionDrag(clientX, clientY) {
  dnd.el.style.left = (clientX - dnd.offX) + 'px';
  dnd.el.style.top = (clientY - dnd.offY) + 'px';
}

function placePlaceholder(clientX, clientY) {
  const metrics = dashGridMetrics(dnd.grid);
  const rawX = Math.floor((clientX - metrics.rect.left) / (metrics.colWidth + metrics.gapX));
  const rawY = Math.floor((clientY - metrics.rect.top) / (metrics.rowHeight + metrics.gapY));
  const x = Math.max(0, Math.min(metrics.columns - dnd.w, rawX));
  const y = Math.max(0, rawY);
  if (x === dnd.nextX && y === dnd.nextY) return;
  dnd.nextX = x;
  dnd.nextY = y;
  const preview = dashPreviewPlacement(dnd.ws, dnd.uid, { x, y }, metrics.columns);
  applyDashPreview(dnd.grid, preview, dnd.uid);
  dnd.placeholder.style.gridColumn = `${x + 1} / span ${dnd.w}`;
  dnd.placeholder.style.gridRow = `${y + 1} / span ${dnd.h}`;
}

function edgeScrollSpeed(clientY) {
  const height = window.innerHeight;
  if (clientY < EDGE_SCROLL_ZONE) {
    return -Math.ceil(EDGE_SCROLL_MAX * (1 - Math.max(0, clientY) / EDGE_SCROLL_ZONE));
  }
  if (clientY > height - EDGE_SCROLL_ZONE) {
    return Math.ceil(EDGE_SCROLL_MAX * (1 - Math.max(0, height - clientY) / EDGE_SCROLL_ZONE));
  }
  return 0;
}

function scheduleDndAutoScroll() {
  if (dndScrollFrame || !dnd?.active) return;
  const tick = () => {
    dndScrollFrame = null;
    if (!dnd?.active) return;
    const speed = edgeScrollSpeed(dnd.lastY);
    if (!speed) return;
    const before = window.scrollY;
    window.scrollBy(0, speed);
    if (window.scrollY === before) return;
    placePlaceholder(dnd.lastX, dnd.lastY);
    dndScrollFrame = requestAnimationFrame(tick);
  };
  dndScrollFrame = requestAnimationFrame(tick);
}

function dndTouchMove(evt) {
  if (dnd?.active && dnd.pointerType === 'touch') evt.preventDefault();
}

function dndMove(evt) {
  if (!dnd || evt.pointerId !== dnd.pointerId) return;
  if (!dnd.active) {
    const distance = Math.hypot(evt.clientX - dnd.startX, evt.clientY - dnd.startY);
    dnd.lastX = evt.clientX;
    dnd.lastY = evt.clientY;
    if (dnd.pointerType === 'touch') {
      if (distance >= DRAG_THRESHOLD) dndCleanup();
      return;
    }
    if (distance < DRAG_THRESHOLD) return;
    activateDrag(evt);
  }
  if (!dnd?.active) return;
  evt.preventDefault();
  dnd.lastX = evt.clientX;
  dnd.lastY = evt.clientY;
  positionDrag(evt.clientX, evt.clientY);
  placePlaceholder(evt.clientX, evt.clientY);
  scheduleDndAutoScroll();
}

function dndUp(evt) {
  if (!dnd || evt.pointerId !== dnd.pointerId) return;
  if (dnd.active) {
    const { ws, uid, nextX, nextY, columns } = dnd;
    dndCleanup();
    dashMoveWidget(ws, uid, nextX, nextY, columns);
    renderApp();
  } else {
    dndCleanup();
  }
}

function dndCancel() {
  dndCleanup();
}

function resizeCleanup() {
  if (!dashResize) return;
  const { el, handle, pointerId, startW, startH, originals } = dashResize;
  if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
  el?.classList.remove('dash-resizing');
  if (el) {
    el.style.setProperty('--w', startW);
    el.style.setProperty('--h', startH);
  }
  originals?.forEach((original, widget) => {
    if (!widget?.isConnected) return;
    widget.style.gridColumn = original.gridColumn;
    widget.style.gridRow = original.gridRow;
  });
  document.body.classList.remove('dash-resizing-active');
  window.removeEventListener('pointermove', resizeMove, true);
  window.removeEventListener('pointerup', resizeUp, true);
  window.removeEventListener('pointercancel', resizeCancel, true);
  window.removeEventListener('blur', resizeCancel, true);
  dashResize = null;
}

function resizeMove(evt) {
  if (!dashResize || evt.pointerId !== dashResize.pointerId) return;
  evt.preventDefault();
  const { ws, uid, grid, el, startX, startY, startW, startH, minW, minH, columns, x, y } = dashResize;
  const metrics = dashGridMetrics(grid);
  const deltaW = Math.round((evt.clientX - startX) / (metrics.colWidth + metrics.gapX));
  const w = Math.max(Math.min(minW, columns), Math.min(columns - x, startW + deltaW));
  const h = Math.max(minH, Math.min(32, startH + Math.round((evt.clientY - startY) / (metrics.rowHeight + metrics.gapY))));
  if (w === dashResize.nextW && h === dashResize.nextH) return;
  dashResize.nextW = w;
  dashResize.nextH = h;
  el.style.setProperty('--w', w);
  el.style.setProperty('--h', h);
  el.style.gridColumn = `${x + 1} / span ${w}`;
  el.style.gridRow = `${y + 1} / span ${h}`;
  applyDashPreview(grid, dashPreviewPlacement(ws, uid, { w, h }, columns), uid);
  const value = el.querySelector('.dash-widget-size-value');
  if (value) value.textContent = `${w}×${h}`;
}

function resizeUp(evt) {
  if (!dashResize || evt.pointerId !== dashResize.pointerId) return;
  const { ws, uid, nextW, nextH, startW, startH, columns } = dashResize;
  resizeCleanup();
  dashSetWidgetSize(ws, uid, nextW || startW, nextH || startH, columns);
  renderApp();
}

function resizeCancel() {
  resizeCleanup();
}

document.addEventListener('pointerdown', (evt) => {
  const handle = evt.target.closest?.('[data-dash-resize]');
  if (!handle || !state.dashEdit || evt.button !== 0 || evt.isPrimary === false || dnd || dashResize) return;
  const el = handle.closest('.dash-widget');
  const grid = el?.parentElement;
  if (!el || !grid?.classList.contains('dash-mod-grid')) return;
  evt.preventDefault();
  evt.stopPropagation();
  const columns = Number.parseInt(grid.dataset.dashColumns, 10) || 4;
  const startW = Number.parseInt(el.dataset.w, 10) || 1;
  const startH = Number.parseInt(el.dataset.h, 10) || 1;
  dashResize = {
    ws: curWs(), uid: el.getAttribute('data-dash-uid'), el, grid, handle, pointerId: evt.pointerId,
    startX: evt.clientX, startY: evt.clientY, startW, startH,
    nextW: startW, nextH: startH, columns,
    x: Number.parseInt(el.dataset.x, 10) || 0,
    y: Number.parseInt(el.dataset.y, 10) || 0,
    originals: new Map(Array.from(grid.querySelectorAll('.dash-widget')).map((widget) => [widget, {
      gridColumn: widget.style.gridColumn,
      gridRow: widget.style.gridRow
    }])),
    minW: Number.parseInt(el.dataset.minW, 10) || 1,
    minH: Number.parseInt(el.dataset.minH, 10) || 1
  };
  el.classList.add('dash-resizing');
  document.body.classList.add('dash-resizing-active');
  handle.setPointerCapture?.(evt.pointerId);
  window.addEventListener('pointermove', resizeMove, true);
  window.addEventListener('pointerup', resizeUp, true);
  window.addEventListener('pointercancel', resizeCancel, true);
  window.addEventListener('blur', resizeCancel, true);
}, true);

document.addEventListener('pointerdown', (evt) => {
  if (!state.dashEdit || evt.button !== 0 || evt.isPrimary === false || dnd || dashResize) return;
  const handle = evt.target.closest?.('[data-dash-move-handle]');
  if (!handle) return;
  const el = handle.closest('.dash-widget');
  if (!el || !el.parentElement?.classList.contains('dash-mod-grid')) return;
  const columns = Number.parseInt(el.parentElement.dataset.dashColumns, 10) || 4;
  evt.preventDefault();
  dnd = {
    uid: el.getAttribute('data-dash-uid'), ws: curWs(), el, grid: el.parentElement, handle,
    placeholder: null, pointerId: evt.pointerId, startX: evt.clientX, startY: evt.clientY,
    lastX: evt.clientX, lastY: evt.clientY, pointerType: evt.pointerType || 'mouse',
    touchTimer: null, offX: 0, offY: 0, active: false, originals: null, columns,
    startCellX: Number.parseInt(el.dataset.x, 10) || 0,
    startCellY: Number.parseInt(el.dataset.y, 10) || 0,
    nextX: Number.parseInt(el.dataset.x, 10) || 0,
    nextY: Number.parseInt(el.dataset.y, 10) || 0,
    w: Number.parseInt(el.dataset.w, 10) || 1,
    h: Number.parseInt(el.dataset.h, 10) || 1
  };
  if (dnd.pointerType === 'touch') {
    const pointerId = dnd.pointerId;
    dnd.touchTimer = setTimeout(() => {
      if (!dnd || dnd.pointerId !== pointerId || dnd.active) return;
      activateDrag({ clientX: dnd.lastX, clientY: dnd.lastY });
    }, TOUCH_HOLD_MS);
    window.addEventListener('touchmove', dndTouchMove, { capture: true, passive: false });
  }
  window.addEventListener('pointermove', dndMove, true);
  window.addEventListener('pointerup', dndUp, true);
  window.addEventListener('pointercancel', dndCancel, true);
  window.addEventListener('blur', dndCancel, true);
});

window.__cancelDashDrag = () => { dndCancel(); resizeCancel(); };

document.addEventListener('click', (evt) => {
  document.querySelectorAll('.dash-size-menu[open]').forEach((menu) => {
    if (!menu.contains(evt.target)) menu.removeAttribute('open');
  });
});

document.addEventListener('keydown', (evt) => {
  if (evt.key === 'Escape') {
    if (dnd || dashResize) { evt.preventDefault(); dndCancel(); resizeCancel(); return; }
    const openSizeMenu = document.querySelector('.dash-size-menu[open]');
    if (!openSizeMenu) return;
    openSizeMenu.removeAttribute('open');
    openSizeMenu.querySelector('summary')?.focus();
    return;
  }
  if (!evt.altKey || !state.dashEdit || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(evt.key)) return;
  const widget = evt.target.closest?.('.dash-widget');
  const grid = widget?.closest?.('.dash-mod-grid');
  if (!widget || !grid) return;
  evt.preventDefault();
  const uid = widget.dataset.dashUid;
  const columns = Number.parseInt(grid.dataset.dashColumns, 10) || 4;
  const w = Number.parseInt(widget.dataset.w, 10) || 1;
  let x = Number.parseInt(widget.dataset.x, 10) || 0;
  let y = Number.parseInt(widget.dataset.y, 10) || 0;
  if (evt.key === 'ArrowLeft') x = Math.max(0, x - 1);
  if (evt.key === 'ArrowRight') x = Math.min(columns - w, x + 1);
  if (evt.key === 'ArrowUp') y = Math.max(0, y - 1);
  if (evt.key === 'ArrowDown') y += 1;
  dashMoveWidget(curWs(), uid, x, y, columns);
  renderApp();
  requestAnimationFrame(() => document.querySelector(`[data-dash-uid="${CSS.escape(uid)}"] [data-dash-move-handle]`)?.focus());
});

let lastDashboardColumns = window.innerWidth <= 680 ? 4 : window.innerWidth <= 1100 ? 6 : 12;
window.addEventListener('resize', () => {
  const nextColumns = window.innerWidth <= 680 ? 4 : window.innerWidth <= 1100 ? 6 : 12;
  if (nextColumns === lastDashboardColumns) return;
  lastDashboardColumns = nextColumns;
  if (state.ready && state.activeNav === 'dashboard') renderApp();
});

const cambioObserver = new MutationObserver(scheduleCambioRefresh);
cambioObserver.observe(document.documentElement, { childList: true, subtree: true });
window.setInterval(() => refreshVisibleCambioWidgets(), CAMBIO_AUTO_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleCambioRefresh();
});

boot();
