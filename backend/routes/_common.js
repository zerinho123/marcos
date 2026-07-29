// ============================================================================
// routes/_common.js — helpers compartilhados por todas as rotas Finance
// ============================================================================

import { ERR } from '../security/errors.js';

export function requireFields(body, fields) {
  if (!body || typeof body !== 'object') {
    throw ERR.VALIDATION('Corpo da requisicao ausente.');
  }
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) {
    throw ERR.VALIDATION(`Campos obrigatorios: ${missing.join(', ')}`);
  }
}

// Cap de tamanho do plaintext. Necessário desde que as colunas sensíveis
// viraram TEXT (criptografia em repouso): o VARCHAR era o único limite e a
// coluna deixou de limitar. null/'' → null; estoura o max → erro de validação.
export function capText(value, max, field) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw ERR.VALIDATION(`${field}: maximo de ${max} caracteres.`);
  return s;
}

export function enumOr(value, allowed, field) {
  const v = String(value || '').trim();
  if (!allowed.includes(v)) {
    throw ERR.VALIDATION(`${field} invalido. Valores aceitos: ${allowed.join(', ')}`);
  }
  return v;
}

export function parseDecimal(value, { allowZero = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw ERR.VALIDATION('Valor numerico invalido.');
  if (!allowZero && n <= 0) throw ERR.VALIDATION('Valor deve ser maior que zero.');
  return Math.round(n * 100) / 100;
}

export function parseDate(value) {
  if (!value) throw ERR.VALIDATION('Data obrigatoria.');
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw ERR.VALIDATION('Data deve estar em YYYY-MM-DD.');
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw ERR.VALIDATION('Data invalida.');
  return s;
}

export function parseMonth(value) {
  if (!value) {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(s);
  if (!m) throw ERR.VALIDATION('Mes deve estar em YYYY-MM.');
  return `${m[1]}-${m[2]}-01`;
}

export function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Resolve a empresa "ativa" da requisicao.
// - admin: pode escolher a empresa via query/body (seletor multi-empresa) —
//   o VINCULO com essa empresa e validado antes, no middleware
//   validateEmpresaOverride (routes/index.js); aqui so se resolve o valor.
// - usuario: sempre a empresa vinculada.
// NUNCA lanca por empresa ausente: o self-heal em server.js (ensureUserEmpresa)
// garante que todo usuario autenticado tenha empresa_id antes de chegar aqui.
export function resolveFinanceEmpresa(req, candidate = null) {
  const user = req.financeUser;
  if (!user) throw ERR.UNAUTHENTICATED();
  // Ambiente explicito (POST /auth/ambiente ja rodou nesta sessao) e a fonte
  // da verdade: nem admin fura. Sem isso, um empresa_id desatualizado vindo
  // do front (ex.: activeEmpresaId setado no boot, antes da troca de
  // ambiente) sobrepunha a empresa da sessao e gravava dado no par
  // empresa/escopo errado (2026-07 — ver auditoria de isolamento).
  const requested = (user.role === 'admin' && !user.ambiente_explicito)
    ? (candidate ?? req.query?.empresa_id ?? req.body?.empresa_id ?? user.empresa_id)
    : user.empresa_id;
  if (!requested) {
    // Caminho defensivo — nao deveria ocorrer com o self-heal ativo.
    throw ERR.INTERNAL(req.id);
  }
  return String(requested).trim();
}

// Escopo de workspace (separacao Pessoal x Empresarial). Dimensao de 1a classe,
// injetada pelo front em toda chamada (igual ao empresa_id) e usada para isolar
// COMPLETAMENTE os dois "sistemas": nenhuma query cruza escopos.
//  - 'pessoal'     = finanças pessoais (contas/transações/orçamento/dívidas/metas pessoais).
//  - 'empresarial' = finanças da empresa (contas/AR/AP/fluxo/DRE/precificação).
// `fallback` so vale quando o cliente nao envia escopo (compat/robustez): rotas
// exclusivamente empresariais (AR/AP) passam 'empresarial'; o resto fica 'pessoal'.
export const FIN_ESCOPOS = ['pessoal', 'empresarial'];
export function resolveFinanceEscopo(req, fallback = 'pessoal') {
  // Sessao com ambiente explicito (POST /auth/ambiente) manda: o escopo passa a
  // ser derivado do ambiente ativo e o valor vindo do cliente e ignorado — o
  // front nao consegue etiquetar dado no balde errado. Tokens legados (sem a
  // claim) seguem no comportamento antigo, para compatibilidade durante rollout.
  if (req.financeUser?.ambiente_explicito) {
    return req.financeUser.ambiente_tipo === 'pessoal' ? 'pessoal' : 'empresarial';
  }
  const raw = req.query?.escopo ?? req.body?.escopo ?? fallback;
  const v = String(raw || '').trim();
  if (!FIN_ESCOPOS.includes(v)) {
    throw ERR.VALIDATION(`escopo invalido. Valores aceitos: ${FIN_ESCOPOS.join(', ')}`);
  }
  return v;
}

// Escopo do DRE por usuario:
//  - '' (string vazia) = template da empresa (default de quem nunca customizou).
//  - <userId>          = DRE pessoal daquele admin (clonado do template).
// Usuario comum: SEMPRE '' (so leitura do template). Admin: '' se vier
// scope=template (query/body), senao o proprio id (seu DRE pessoal).
// A escrita ja e barrada por requireFinanceAdmin nas rotas de escrita.
// Bloqueia rotas exclusivamente empresariais quando o ambiente ativo da sessao
// e Pessoal (ver security/ambiente.js). Personal nunca ve/grava DRE,
// Precificacao, Contas a Pagar/Receber de empresa — nem por engano de front.
export function assertAmbienteEmpresarial(req) {
  if (req.financeUser?.ambiente_tipo === 'pessoal') {
    throw ERR.FORBIDDEN('Recurso nao disponivel no ambiente Pessoal.');
  }
}

export function requireAmbienteEmpresarial(req, _res, next) {
  try {
    assertAmbienteEmpresarial(req);
    next();
  } catch (e) {
    next(e);
  }
}

export function dreScope(req) {
  const user = req.financeUser;
  if (!user) throw ERR.UNAUTHENTICATED();
  if (user.role !== 'admin') return '';
  const wanted = req.query?.scope ?? req.body?.scope;
  return wanted === 'template' ? '' : String(user.id);
}
