// ============================================================================
// security-client.js � cliente HTTP autenticado + helpers de API do Finance
// ----------------------------------------------------------------------------
// Auth: cookie de sessão HttpOnly (cff_session) + token CSRF em memória.
//   - GET /api/finance/auth/csrf devolve token HMAC vinculado ao usuário.
//   - Toda mutação envia esse token no header X-CSRF-Token.
//
// Exporta:
//   � apiFetch(path, options) � fetch baixo n�vel
//   � login / logout / me � endpoints de auth
//   � api.* � m�todos por endpoint Finance (transa��es, contas, categorias...)
// ============================================================================

const API_ORIGIN  = window.__CF_API_ORIGIN__ || 'https://apifinanceiro.cfsistema.site';
const AUTH_BASE   = '/api/finance/auth';
let csrfToken = null;
let csrfRequest = null;

// ---------------------------------------------------------------------------
// Empresa ativa (multi-empresa) � injetada automaticamente em toda chamada
// de recurso Finance. So o admin troca; pro usuario comum o backend ignora e
// usa a empresa vinculada.
// ---------------------------------------------------------------------------
let activeEmpresaId = null;
export function setActiveEmpresa(id) { activeEmpresaId = id ? String(id) : null; }
export function getActiveEmpresa() { return activeEmpresaId; }

// Caminhos que NAO recebem empresa_id (auth/webhook nao sao multi-tenant aqui).
function shouldInjectEmpresa(path) {
  if (!activeEmpresaId) return false;
  const p = path.startsWith('http') ? new URL(path).pathname : path;
  if (!p.startsWith('/api/finance/')) return false;
  if (p.startsWith('/api/finance/auth')) return false;
  if (p.startsWith('/api/finance/webhook')) return false;
  return true;
}

async function ensureCsrf(force = false) {
  if (csrfToken && !force) return csrfToken;
  if (csrfRequest && !force) return csrfRequest;
  csrfRequest = (async () => {
    const res = await fetch(API_ORIGIN + AUTH_BASE + '/csrf', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.csrf_token) throw new Error('Não foi possível obter token CSRF');
    csrfToken = payload.csrf_token;
    return csrfToken;
  })();
  try { return await csrfRequest; }
  finally { csrfRequest = null; }
}

/**
 * apiFetch(path, options)
 *   path: '/api/...' (relativo) ou URL absoluta
 *   options.method: GET (default), POST, PUT, PATCH, DELETE
 *   options.body: objeto JS (serializado em JSON)
 *   options.silent401: n�o redireciona pra login em 401
 * Retorno: body JSON parseado, ou null em 204.
 * Erro: lan�a Error com .status, .code, .issues.
 */
export async function apiFetch(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();

  // Injeta a empresa ativa: na query (GET/HEAD ou sem body) ou no body (mutacoes).
  let body = options.body;
  if (shouldInjectEmpresa(path)) {
    const hasBody = body !== undefined && body !== null && typeof body === 'object' && !Array.isArray(body);
    if (method === 'GET' || method === 'HEAD' || !hasBody) {
      if (!/[?&]empresa_id=/.test(path)) {
        path += (path.includes('?') ? '&' : '?') + 'empresa_id=' + encodeURIComponent(activeEmpresaId);
      }
    } else if (body.empresa_id == null) {
      body = { ...body, empresa_id: activeEmpresaId };
    }
  }

  const url = path.startsWith('http') ? path : API_ORIGIN + path;
  const headers = { 'Accept': 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = await ensureCsrf();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  if (res.status === 204) return null;

  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  }

  if (payload?.csrf_token) csrfToken = payload.csrf_token;

  if (!res.ok) {
    if (res.status === 403 && payload?.error === 'csrf_failure' && options.retryCsrf !== false) {
      csrfToken = null;
      await ensureCsrf(true);
      return apiFetch(path, { ...options, retryCsrf: false });
    }
    if (res.status === 401) {
      csrfToken = null;
      if (!options.silent401) window.location.replace('./login.html');
    }
    const err = new Error(payload?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = payload?.error || payload?.code;
    err.issues = payload?.issues || null;
    throw err;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function login({ username, password }) {
  csrfToken = null;
  await ensureCsrf();
  return apiFetch(AUTH_BASE + '/login', {
    method: 'POST',
    body: { username, password }
  });
}

export async function logout() {
  try { await apiFetch(AUTH_BASE + '/logout', { method: 'POST', silent401: true }); }
  catch (_) {}
  csrfToken = null;
  window.location.replace('./login.html');
}

export async function me() {
  await ensureCsrf();
  return apiFetch(AUTH_BASE + '/me', { silent401: true });
}

// Troca o ambiente ativo (Pessoal x Empresarial) da sessao. O backend valida
// vinculo e reemite o cookie de sessao com a empresa_id correta — so depois
// disso as chamadas de recurso Finance passam a enxergar os dados daquele
// ambiente. tipo: 'pessoal' | 'empresarial'; empresa_id obrigatorio so p/
// 'empresarial'. usuario_id (opcional): ambiente Pessoal DELEGADO — troca pra
// conta de terceiro que o chamador comanda via FinanceDelegacao (painel
// lateral "Contas que eu comando"). Usado tambem pelo botao de alternar
// ambiente (usuarios com workspaces === 'ambos' — ver isHybridUser).
export async function trocarAmbiente({ tipo, empresa_id, usuario_id } = {}) {
  const body = { tipo };
  if (empresa_id) body.empresa_id = empresa_id;
  if (usuario_id) body.usuario_id = usuario_id;
  return apiFetch(AUTH_BASE + '/ambiente', { method: 'POST', body });
}

// ---------------------------------------------------------------------------
// API Finance � helpers por recurso (qsBuild evita querystring na m�o)
// ---------------------------------------------------------------------------

function qs(params) {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? '?' + s : '';
}

export const api = {
  // === Empresas ===
  empresas:          ()           => apiFetch('/api/finance/empresas'),
  postEmpresa:       (p)          => apiFetch('/api/finance/empresas', { method: 'POST', body: p }),
  putEmpresa:        (id, p)      => apiFetch(`/api/finance/empresas/${id}`, { method: 'PUT', body: p }),
  deleteEmpresa:     (id)         => apiFetch(`/api/finance/empresas/${id}`, { method: 'DELETE' }),

  // === Categorias ===
  categorias:        (params)     => apiFetch('/api/finance/categorias' + qs(params)),
  postCategoria:     (p)          => apiFetch('/api/finance/categorias', { method: 'POST', body: p }),
  putCategoria:      (id, p)      => apiFetch(`/api/finance/categorias/${id}`, { method: 'PUT', body: p }),
  deleteCategoria:   (id)         => apiFetch(`/api/finance/categorias/${id}`, { method: 'DELETE' }),

  // === Contas banc�rias ===
  contas:            (params)     => apiFetch('/api/finance/contas-bancarias' + qs(params)),
  postConta:         (p)          => apiFetch('/api/finance/contas-bancarias', { method: 'POST', body: p }),
  putConta:          (id, p)      => apiFetch(`/api/finance/contas-bancarias/${id}`, { method: 'PUT', body: p }),
  deleteConta:       (id)         => apiFetch(`/api/finance/contas-bancarias/${id}`, { method: 'DELETE' }),

  // === Transa��es ===
  transacoes:        (params)     => apiFetch('/api/finance/transacoes' + qs(params)),
  postTransacao:     (p)          => apiFetch('/api/finance/transacoes', { method: 'POST', body: p }),
  putTransacao:      (id, p)      => apiFetch(`/api/finance/transacoes/${id}`, { method: 'PUT', body: p }),
  deleteTransacao:   (id)         => apiFetch(`/api/finance/transacoes/${id}`, { method: 'DELETE' }),

  // === Contas a receber ===
  contasReceber:     (params)     => apiFetch('/api/finance/contas-receber' + qs(params)),
  postContaReceber:  (p)          => apiFetch('/api/finance/contas-receber', { method: 'POST', body: p }),
  putContaReceber:   (id, p)      => apiFetch(`/api/finance/contas-receber/${id}`, { method: 'PUT', body: p }),
  deleteContaReceber:(id)         => apiFetch(`/api/finance/contas-receber/${id}`, { method: 'DELETE' }),
  patchReceber:      (id, p)      => apiFetch(`/api/finance/contas-receber/${id}/receber`, { method: 'PATCH', body: p }),

  // === Contas a pagar ===
  contasPagar:       (params)     => apiFetch('/api/finance/contas-pagar' + qs(params)),
  postContaPagar:    (p)          => apiFetch('/api/finance/contas-pagar', { method: 'POST', body: p }),
  putContaPagar:     (id, p)      => apiFetch(`/api/finance/contas-pagar/${id}`, { method: 'PUT', body: p }),
  deleteContaPagar:  (id)         => apiFetch(`/api/finance/contas-pagar/${id}`, { method: 'DELETE' }),
  patchPagar:        (id, p)      => apiFetch(`/api/finance/contas-pagar/${id}/pagar`, { method: 'PATCH', body: p }),

  // === D�vidas ===
  dividas:           (params)     => apiFetch('/api/finance/dividas' + qs(params)),
  postDivida:        (p)          => apiFetch('/api/finance/dividas', { method: 'POST', body: p }),
  putDivida:         (id, p)      => apiFetch(`/api/finance/dividas/${id}`, { method: 'PUT', body: p }),
  patchDividaStatus: (id, p)      => apiFetch(`/api/finance/dividas/${id}/status`, { method: 'PATCH', body: p }),
  deleteDivida:      (id)         => apiFetch(`/api/finance/dividas/${id}`, { method: 'DELETE' }),

  // === Or�amentos ===
  orcamentos:        (mes)        => apiFetch('/api/finance/orcamentos' + qs({ mes })),
  postOrcamento:     (p)          => apiFetch('/api/finance/orcamentos', { method: 'POST', body: p }),
  putOrcamento:      (id, p)      => apiFetch(`/api/finance/orcamentos/${id}`, { method: 'PUT', body: p }),
  deleteOrcamento:   (id)         => apiFetch(`/api/finance/orcamentos/${id}`, { method: 'DELETE' }),

  // === Metas ===
  metas:             ()           => apiFetch('/api/finance/metas'),
  postMeta:          (p)          => apiFetch('/api/finance/metas', { method: 'POST', body: p }),
  putMeta:           (id, p)      => apiFetch(`/api/finance/metas/${id}`, { method: 'PUT', body: p }),
  patchMetaAporte:   (id, p)      => apiFetch(`/api/finance/metas/${id}/aporte`, { method: 'PATCH', body: p }),
  deleteMeta:        (id)         => apiFetch(`/api/finance/metas/${id}`, { method: 'DELETE' }),

  // === Investimentos ===
  investimentos:     ()           => apiFetch('/api/finance/investimentos'),
  postInvestimento:  (p)          => apiFetch('/api/finance/investimentos', { method: 'POST', body: p }),
  postAporte:        (id, p)      => apiFetch(`/api/finance/investimentos/${id}/aportes`, { method: 'POST', body: p }),

  // === DRE plano ===
  drePlano:          (mes)        => apiFetch('/api/finance/dre/plano' + qs({ mes })),
  putDrePlano:       (p)          => apiFetch('/api/finance/dre/plano', { method: 'PUT', body: p }),

  // === DRE config por usu�rio (scope: undefined=pessoal do admin / 'template'=empresa) ===
  dreEstrutura:      (scope)      => apiFetch('/api/finance/dre/estrutura' + qs({ scope })),
  dreConfig:         (scope)      => apiFetch('/api/finance/dre/config' + qs({ scope })),
  putDreConfig:      (p)          => apiFetch('/api/finance/dre/config', { method: 'PUT', body: p }),
  postDreFormula:    (p)          => apiFetch('/api/finance/dre/formulas', { method: 'POST', body: p }),
  putDreFormula:     (id, p)      => apiFetch(`/api/finance/dre/formulas/${id}`, { method: 'PUT', body: p }),
  deleteDreFormula:  (id, scope)  => apiFetch(`/api/finance/dre/formulas/${id}` + qs({ scope }), { method: 'DELETE' }),
  postDreLinha:      (p)          => apiFetch('/api/finance/dre/linhas', { method: 'POST', body: p }),
  putDreLinha:       (id, p)      => apiFetch(`/api/finance/dre/linhas/${id}`, { method: 'PUT', body: p }),
  deleteDreLinha:    (id, scope)  => apiFetch(`/api/finance/dre/linhas/${id}` + qs({ scope }), { method: 'DELETE' }),
  putDreMeta:        (p)          => apiFetch('/api/finance/dre/meta', { method: 'PUT', body: p }),
  putDreValores:     (p)          => apiFetch('/api/finance/dre/valores', { method: 'PUT', body: p }),
  putDreMapa:        (p)          => apiFetch('/api/finance/dre/mapa', { method: 'PUT', body: p }),

  // === Precificacao empresarial ===
  pricingConfig:          ()           => apiFetch('/api/finance/precificacao/config'),
  putPricingConfig:       (p)          => apiFetch('/api/finance/precificacao/config', { method: 'PUT', body: p }),
  pricingCategories:      ()           => apiFetch('/api/finance/precificacao/categorias'),
  postPricingCategory:    (p)          => apiFetch('/api/finance/precificacao/categorias', { method: 'POST', body: p }),
  putPricingCategory:     (id, p)      => apiFetch(`/api/finance/precificacao/categorias/${id}`, { method: 'PUT', body: p }),
  deletePricingCategory:  (id)         => apiFetch(`/api/finance/precificacao/categorias/${id}`, { method: 'DELETE' }),
  pricingFunctions:       ()           => apiFetch('/api/finance/precificacao/funcoes'),
  postPricingFunction:    (p)          => apiFetch('/api/finance/precificacao/funcoes', { method: 'POST', body: p }),
  putPricingFunction:     (id, p)      => apiFetch(`/api/finance/precificacao/funcoes/${id}`, { method: 'PUT', body: p }),
  deletePricingFunction:  (id)         => apiFetch(`/api/finance/precificacao/funcoes/${id}`, { method: 'DELETE' }),
  pricingItems:           (params)     => apiFetch('/api/finance/precificacao/itens' + qs(params)),
  pricingItem:            (id)         => apiFetch(`/api/finance/precificacao/itens/${id}`),
  postPricingItem:        (p)          => apiFetch('/api/finance/precificacao/itens', { method: 'POST', body: p }),
  putPricingItem:         (id, p)      => apiFetch(`/api/finance/precificacao/itens/${id}`, { method: 'PUT', body: p }),
  postPricingDraft:       (id)         => apiFetch(`/api/finance/precificacao/itens/${id}/rascunho`, { method: 'POST', body: {} }),
  putPricingVersion:      (id, p)      => apiFetch(`/api/finance/precificacao/versoes/${id}`, { method: 'PUT', body: p }),
  simulatePricing:        (p)          => apiFetch('/api/finance/precificacao/simular', { method: 'POST', body: p }),
  publishPricingVersion:  (id, p)      => apiFetch(`/api/finance/precificacao/versoes/${id}/publicar`, { method: 'POST', body: p }),
  cancelPricingVersion:   (id)         => apiFetch(`/api/finance/precificacao/versoes/${id}/cancelar`, { method: 'POST', body: {} }),

  // === Relat�rios ===
  dashboard:         (params)     => apiFetch('/api/finance/relatorios/dashboard' + qs(params)),
  dre:               (mes, scope) => apiFetch('/api/finance/relatorios/dre' + qs({ mes, scope })),
  fluxoCaixa:        (di, df, tipo = 'empresarial') =>
    apiFetch('/api/finance/relatorios/fluxo-de-caixa' + qs({ data_inicio: di, data_fim: df, tipo })),

  // Preferência de período do dashboard (persistida por empresa/usuário/escopo).
  dashboardConfig:    (params)     => apiFetch('/api/finance/dashboard-config' + qs(params)),
  putDashboardConfig: (config, params) =>
    apiFetch('/api/finance/dashboard-config' + qs(params), { method: 'PUT', body: { config } }),

  // Conversão pontual para o widget da dashboard.
  converterMoeda:     (params)     => apiFetch('/api/finance/cambio/converter' + qs(params)),

  // === Lixeira ===
  lixeira:            (params)     => apiFetch('/api/finance/lixeira' + qs(params)),
  lixeiraGlobal:       (params)     => apiFetch('/api/finance/lixeira/global' + qs(params)),
  restaurarLixeira:   (id)         => apiFetch(`/api/finance/lixeira/${id}/restaurar`, { method: 'POST', body: {} }),
  purgarLixeira:      (id)         => apiFetch(`/api/finance/lixeira/${id}`, { method: 'DELETE' }),

  // === Delegações (gestor comanda contas pessoais de terceiros) ===
  delegacoesMinhas:   ()           => apiFetch('/api/finance/delegacoes/minhas'),
  delegacoes:         ()           => apiFetch('/api/finance/delegacoes'),
  postDelegacao:      (p)          => apiFetch('/api/finance/delegacoes', { method: 'POST', body: p }),
  putDelegacao:       (id, p)      => apiFetch(`/api/finance/delegacoes/${id}`, { method: 'PATCH', body: p }),
  deleteDelegacao:    (id)         => apiFetch(`/api/finance/delegacoes/${id}`, { method: 'DELETE' })
};

// Exp�e no window pra console debug
window.__financeApi = api;
