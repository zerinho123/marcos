// ============================================================================
// security/financeAuth.js - auth isolada do Finance
// ============================================================================

import { randomUUID, createHmac, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { loadEnv } from './env.js';
import { hashPassword, verifyPassword, isBcryptHash } from './auth.js';
import { safeEquals } from './encryption.js';
import { ERR } from './errors.js';
import { assertDelegacao } from './ambiente.js';

const env = loadEnv();
const FINANCE_ACCESS_TTL_SEC = 60 * 60; // 1 hora

export { hashPassword, verifyPassword, isBcryptHash };

// ────────────────────────────────────────────────────────────────────────────
// Cookies
// ────────────────────────────────────────────────────────────────────────────

export const FINANCE_COOKIE_NAMES = Object.freeze({
  ACCESS: 'cff_session',
  CSRF:   'cff_csrf'
});

const HOST_ONLY_COOKIE_OPTS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: env.COOKIE_SAMESITE.toLowerCase(),
  signed: false
};

function clearLegacyDomainCookies(res) {
  if (!env.COOKIE_DOMAIN) return;
  const legacy = { ...HOST_ONLY_COOKIE_OPTS, domain: env.COOKIE_DOMAIN, path: '/' };
  res.clearCookie(FINANCE_COOKIE_NAMES.ACCESS, legacy);
  res.clearCookie(FINANCE_COOKIE_NAMES.CSRF, { ...legacy, httpOnly: false });
}

export function setFinanceAuthCookie(res, accessToken) {
  clearLegacyDomainCookies(res);
  res.cookie(FINANCE_COOKIE_NAMES.ACCESS, accessToken, {
    ...HOST_ONLY_COOKIE_OPTS,
    path: '/',
    maxAge: FINANCE_ACCESS_TTL_SEC * 1000
  });
}

export function clearFinanceAuthCookies(res) {
  res.clearCookie(FINANCE_COOKIE_NAMES.ACCESS, { ...HOST_ONLY_COOKIE_OPTS, path: '/' });
  res.clearCookie(FINANCE_COOKIE_NAMES.CSRF, { ...HOST_ONLY_COOKIE_OPTS, httpOnly: false, path: '/' });
  clearLegacyDomainCookies(res);
}

export function readFinanceAccessToken(req) {
  // Cookie-only por design: o fallback `Authorization: Bearer` foi removido
  // (hardening 2026-07-07) — nenhum cliente do repo o usava e mantê-lo só
  // ampliava a superfície de ataque (token utilizável fora do cookie httpOnly).
  return req.cookies?.[FINANCE_COOKIE_NAMES.ACCESS] || null;
}

// ────────────────────────────────────────────────────────────────────────────
// JWT
// ────────────────────────────────────────────────────────────────────────────

// `ambiente` (opcional) representa uma troca de ambiente ativo (Pessoal x
// Empresarial) feita depois do login — ver POST /auth/ambiente. Sem ele, o
// token mantém o comportamento de sempre: empresa_id = a empresa "dona" do
// usuário, lida fresca do banco a cada request (ver buildRequireFinanceAuth).
function buildFinancePayload(user, ambiente = null) {
  const payload = {
    sub: user.id,
    role: user.role,
    empresa_id: user.empresa_id ?? null,
    sv: Number(user.session_version || 0),
    app: 'finance',
    typ: 'access'
  };
  if (ambiente) {
    payload.ambiente_tipo = ambiente.tipo;
    payload.ambiente_empresa_id = ambiente.empresa_id;
    // Presentes so quando o ambiente pessoal ativo e delegado (POST /auth/ambiente
    // com usuario_id de terceiro) — ver security/ambiente.js:resolveAmbienteAlvo.
    // Sem eles, o request segue no ambiente proprio de sempre.
    if (ambiente.owner_id) {
      payload.ambiente_owner_id = ambiente.owner_id;
      payload.ambiente_permissao = ambiente.permissao ?? 'visualizar';
    }
  }
  return payload;
}

export function signFinanceAccessToken(user, ambiente = null) {
  return jwt.sign(buildFinancePayload(user, ambiente), env.JWT_SECRET_CURRENT, {
    algorithm: 'HS256',
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: FINANCE_ACCESS_TTL_SEC,
    jwtid: randomUUID()
  });
}

export function verifyFinanceAccessToken(token) {
  const opts = {
    algorithms: ['HS256'],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE
  };
  let payload = null;
  try {
    payload = jwt.verify(token, env.JWT_SECRET_CURRENT, opts);
  } catch {
    if (!env.JWT_SECRET_PREVIOUS) throw ERR.INVALID_TOKEN();
    try {
      payload = jwt.verify(token, env.JWT_SECRET_PREVIOUS, opts);
    } catch {
      throw ERR.INVALID_TOKEN();
    }
  }
  if (payload?.app !== 'finance' || payload?.typ !== 'access') {
    throw ERR.INVALID_TOKEN();
  }
  return payload;
}

export function issueFinanceSession(user, ambiente = null) {
  return {
    accessToken: signFinanceAccessToken(user, ambiente),
    accessTtlSec: FINANCE_ACCESS_TTL_SEC
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CSRF (token HMAC em memória no cliente, vinculado ao usuário)
// ────────────────────────────────────────────────────────────────────────────

const FINANCE_CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function signFinanceCsrf(value) {
  return createHmac('sha256', env.CSRF_SECRET).update('finance.' + value).digest('hex');
}

export function buildFinanceCsrfToken({ userId }) {
  const nonce = randomBytes(16).toString('hex');
  const mac = signFinanceCsrf(`${nonce}.${userId}`);
  return `${nonce}.${mac}`;
}

export function financeCsrfMiddleware({ allowedOrigins }) {
  const originSet = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (FINANCE_CSRF_SAFE_METHODS.has(req.method)) return next();

    const origin = req.headers.origin || (() => {
      const ref = req.headers.referer;
      if (!ref) return null;
      try { return new URL(ref).origin; } catch { return null; }
    })();
    if (origin && !originSet.has(origin)) {
      return next(ERR.CSRF());
    }

    if (!req.financeUser?.id) return next(ERR.UNAUTHENTICATED());

    const headerToken = req.headers['x-csrf-token'];
    if (!headerToken) return next(ERR.CSRF());
    const [nonce, mac] = String(headerToken).split('.');
    if (!nonce || !mac) return next(ERR.CSRF());
    const expected = signFinanceCsrf(`${nonce}.${req.financeUser.id}`);
    if (!safeEquals(mac, expected)) return next(ERR.CSRF());
    next();
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Middlewares
// ────────────────────────────────────────────────────────────────────────────

export function buildRequireFinanceAuth({ lookupFinanceUser, logger, assertDelegacaoFn = assertDelegacao }) {
  return async function requireFinanceAuth(req, res, next) {
    try {
      const token = readFinanceAccessToken(req);
      if (!token) throw ERR.UNAUTHENTICATED();

      const payload = verifyFinanceAccessToken(token);
      const user = await lookupFinanceUser(payload.sub);
      if (!user) throw ERR.INVALID_TOKEN();

      if ((user.status || 'aprovado') !== 'aprovado' || user.deleted_at) {
        throw ERR.INVALID_TOKEN();
      }

      if (Number(payload.sv ?? 0) !== Number(user.session_version || 0)) {
        throw ERR.INVALID_TOKEN();
      }

      // Bloqueio de conta também vale para sessões já abertas: sem isso, um JWT
      // emitido antes do lock continuaria válido por até 1h (a TTL do token).
      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        throw ERR.LOCKED(new Date(user.locked_until).getTime() - Date.now());
      }

      // Ambiente pessoal DELEGADO (POST /auth/ambiente com usuario_id de terceiro):
      // revalida a delegacao a cada request — nao confia so na claim do token, que
      // pode ter sido emitida antes de uma revogacao ou de um downgrade de
      // permissao. Se a delegacao caiu, o request cai junto (403), sem esperar o
      // token expirar. A permissao aplicada e sempre a fresca do banco.
      let delegacaoPermissao = null;
      if (payload.ambiente_owner_id && payload.ambiente_owner_id !== user.id) {
        delegacaoPermissao = await assertDelegacaoFn(user.id, payload.ambiente_owner_id);
      }

      // empresa_id "ativa" da sessao: por padrao a empresa dona do usuario,
      // lida fresca do banco a cada request (comportamento inalterado). So
      // diverge quando o token carrega uma troca de ambiente explicita
      // (POST /auth/ambiente) — nesse caso vale ate o token expirar ou o
      // usuario trocar de novo/deslogar.
      const empresaAtiva = payload.ambiente_empresa_id ?? (user.empresa_id ?? null);
      req.financeUser = {
        id: user.id,
        username: user.username,
        nome: user.nome,
        // Compat: `dono` e um `admin` com um bit a mais — normalizado aqui pra
        // que as ~40 checagens `role === 'admin'' ja existentes no backend e no
        // frontend continuem valendo pro dono sem precisar tocar em nenhuma
        // delas. Portas exclusivas do dono checam `is_owner`.
        role: user.role === 'dono' ? 'admin' : user.role,
        role_real: user.role,
        is_owner: user.role === 'dono',
        access_level: ['admin', 'dono'].includes(user.role) ? 'operacao' : (user.access_level || 'operacao'),
        empresa_id: empresaAtiva,
        empresa_id_home: user.empresa_id ?? null,
        ambiente_tipo: payload.ambiente_tipo
          ?? (user.workspaces === 'empresarial' ? 'empresarial' : 'pessoal'),
        // true somente quando o usuario passou pelo POST /auth/ambiente nesta
        // sessao — tokens legados (sem claim) mantem o comportamento antigo.
        ambiente_explicito: payload.ambiente_tipo != null,
        // Dono da conta pessoal cujo workspace esta ativo agora: o proprio
        // usuario, exceto em ambiente delegado (POST /auth/ambiente com
        // usuario_id de terceiro), onde vira o id de quem foi delegado.
        // routes/categorias.js e routes/orcamentos.js usam isto (nunca `id`
        // direto) pra nao gravar dado pessoal do gerido em nome do gestor.
        pessoal_owner_id: payload.ambiente_owner_id ?? user.id,
        delegado: Boolean(payload.ambiente_owner_id && payload.ambiente_owner_id !== user.id),
        delegacao_permissao: delegacaoPermissao,
        mfa_enabled: Boolean(user.mfa_enabled),
        session_version: Number(user.session_version || 0),
        iat: payload.iat,
        jti: payload.jti
      };
      next();
    } catch (e) {
      if (e?.code === 'unauthenticated' || e?.code === 'invalid_token' || e?.code === 'locked' || e?.code === 'forbidden') {
        return next(e);
      }
      logger.error({ requestId: req.id, msg: 'requireFinanceAuth fatal', stack: e?.stack });
      return next(ERR.INTERNAL(req.id));
    }
  };
}

export function requireFinanceAdmin(req, _res, next) {
  if (!req.financeUser) return next(ERR.UNAUTHENTICATED());
  if (req.financeUser.role !== 'admin') return next(ERR.FORBIDDEN());
  next();
}

// Exclusivo do dono do sistema (role_real === 'dono'). Diferente de
// requireFinanceAdmin: um admin comum NUNCA passa aqui, mesmo apos a
// normalizacao de role em buildRequireFinanceAuth.
export function requireFinanceOwner(req, _res, next) {
  if (!req.financeUser) return next(ERR.UNAUTHENTICATED());
  if (!req.financeUser.is_owner) return next(ERR.FORBIDDEN('Acao exclusiva do dono do sistema.'));
  next();
}

export function requireFinanceWriteAccess(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Delegacao com permissao 'visualizar' bloqueia QUALQUER escrita no ambiente
  // delegado — inclusive se o gestor for admin. Tem que vir antes do bypass de
  // admin logo abaixo, senao um admin gestor furaria a delegacao de leitura.
  if (req.financeUser?.delegado && req.financeUser.delegacao_permissao !== 'operar') {
    return next(ERR.FORBIDDEN('Delegacao somente para visualizacao.'));
  }
  if (req.financeUser?.role === 'admin') return next();
  if ((req.financeUser?.access_level || 'operacao') === 'operacao') return next();
  return next(ERR.FORBIDDEN('Usuario possui acesso somente para visualizacao.'));
}
