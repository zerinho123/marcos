// ============================================================================
// routes/auth.js — auth isolada do Finance
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool, queryOne, query, executeUpdate } from '../db.js';
import { syncUserPersonalCurrency, readPersonalCurrency, moedaPessoalSchema } from './_personal-currency.js';
import {
  hashPassword, verifyPassword,
  issueFinanceSession,
  setFinanceAuthCookie, clearFinanceAuthCookies,
  buildFinanceCsrfToken,
  readFinanceAccessToken, verifyFinanceAccessToken,
} from '../security/financeAuth.js';
import { ERR } from '../security/errors.js';
import { validate } from '../security/validation.js';
import { loginLimiter, registerLimiter } from '../security/rateLimit.js';
import { listAmbientes, resolveAmbienteAlvo, listDelegacoes } from '../security/ambiente.js';
import { logAuditEvent } from '../security/auditLog.js';
import { encMany } from '../security/encryption.js';

const USER_PII_FIELDS = ['email', 'telefone', 'documento', 'empresa_solicitada'];

const ambienteSchema = z.object({
  tipo: z.enum(['pessoal', 'empresarial']),
  empresa_id: z.string().trim().min(1).max(191).optional(),
  // Ambiente Pessoal DELEGADO: usuario_id de terceiro que o chamador comanda
  // via FinanceDelegacao (ver security/ambiente.js:resolveAmbienteAlvo).
  // Ausente/igual ao proprio id => comportamento de sempre (Pessoal proprio).
  usuario_id: z.string().trim().min(1).max(191).optional()
});

// Self-service da moeda padrão pessoal (o próprio usuário escolhe a dele).
const moedaMeSchema = z.object({ moeda: moedaPessoalSchema });

const loginSchema = z.object({
  username: z.string().min(3).max(191).trim().toLowerCase(),
  password: z.string().min(1).max(256)
});

// Auto-registro público (fluxo com aprovação de admin). Diferente do cadastro
// pelo painel: e-mail OBRIGATÓRIO (canal de contato pra decisão do admin) e
// senha com exigência mínima de robustez (letra + número, 8+).
const registerSchema = z.object({
  username: z.string().min(3).max(64).trim().toLowerCase()
    .regex(/^[a-z0-9._-]+$/, 'Username: só letras minúsculas, números, ponto, hífen e underline.'),
  nome:     z.string().min(2).max(191).trim(),
  email:    z.string().trim().toLowerCase().email('E-mail inválido.').max(191),
  // Dados de contato/identificação pra o admin verificar a solicitação.
  // Obrigatórios; validação leve (documento aceita CPF/CNPJ com ou sem máscara).
  telefone: z.string().trim().min(8, 'Telefone inválido.').max(32),
  documento: z.string().trim().min(11, 'CPF/CNPJ inválido.').max(32)
    .regex(/^[0-9.\-/\s]+$/, 'CPF/CNPJ: use apenas números e pontuação.'),
  empresa:  z.string().trim().min(2, 'Informe a empresa.').max(191),
  // Plano/valor é opcional (o admin confere o pagamento por fora).
  plano:    z.string().trim().max(120).optional(),
  password: z.string().min(8, 'Senha deve ter ao menos 8 caracteres.').max(128)
    .regex(/[a-zA-Z]/, 'Senha precisa de ao menos uma letra.')
    .regex(/[0-9]/, 'Senha precisa de ao menos um número.')
});

// Lockout de conta (2ª camada além do rate-limit por IP, que é 5/15min). Protege
// contra brute-force distribuído (vários IPs): após N falhas consecutivas a conta
// fica bloqueada por LOCKOUT_MS, independente do IP de origem.
export const MAX_FAILED_LOGINS = 10;
export const LOCKOUT_MS = 15 * 60 * 1000; // 15 min

function serializeUser(u) {
  if (!u) return null;
  const isOwner = u.role === 'dono';
  return {
    id: u.id,
    username: u.username,
    nome: u.nome,
    // Compat: dono le como admin no frontend, igual ao req.financeUser do
    // backend (financeAuth.js) — as checagens `role === 'admin'` ja
    // existentes na UI continuam valendo pro dono sem precisar tocar nelas.
    role: isOwner ? 'admin' : u.role,
    role_real: u.role,
    is_owner: isOwner,
    workspaces: u.workspaces ?? 'ambos',
    access_level: (isOwner || u.role === 'admin') ? 'operacao' : (u.access_level ?? 'operacao'),
    empresa_id: u.empresa_id ?? null,
    mfa_enabled: Boolean(u.mfa_enabled),
    last_login_at: u.last_login_at ?? null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt
  };
}

export function buildAuthRouter({
  requireFinanceAuth,
  csrfMiddleware = (_req, _res, next) => next(),
  queryOneFn = queryOne,
  queryFn = query,
  executeUpdateFn = executeUpdate,
  hashPasswordFn = hashPassword,
  auditFn = logAuditEvent,
  poolRef = pool
} = {}) {
  const router = Router();

  // Auditoria dos eventos de auth (este router fica FORA do choke point do
  // Finance). Fire-and-forget — nunca altera a resposta HTTP.
  const audit = (req, fields) => auditFn({
    method: req.method,
    path: (req.baseUrl || '') + (req.path || ''),
    ip: req.ip,
    request_id: req.id,
    ...fields
  });

  // Conta uma falha de login e, ao cruzar o limite, bloqueia a conta (zerando o
  // contador para recomeçar do zero quando o lock expirar).
  async function registerFailedLogin(row) {
    const attempts = Number(row.failed_login_attempts || 0) + 1;
    const patch = attempts >= MAX_FAILED_LOGINS
      ? { failed_login_attempts: 0, locked_until: new Date(Date.now() + LOCKOUT_MS), updatedAt: new Date() }
      : { failed_login_attempts: attempts, updatedAt: new Date() };
    await executeUpdateFn('FinanceUser', patch, '`id` = ?', [row.id]);
  }

  // GET /csrf — emite token CSRF. Bind ao usuario real da sessao (se houver),
  // senao 'anon'. Importante: este router NAO passa por requireFinanceAuth,
  // entao precisamos resolver o usuario lendo o cookie de sessao na mao —
  // do contrario o token sairia bound a 'anon' e falharia a validacao das
  // mutacoes do usuario logado.
  router.get('/csrf', (req, res) => {
    let userId = 'anon';
    const access = readFinanceAccessToken(req);
    if (access) {
      try {
        userId = verifyFinanceAccessToken(access).sub || 'anon';
        setFinanceAuthCookie(res, access);
      }
      catch { /* token ausente/invalido/expirado → anon */ }
    }
    const token = buildFinanceCsrfToken({ userId });
    return res.json({ ok: true, csrf_token: token });
  });

  // POST /login
  router.post('/login', loginLimiter, validate({ body: loginSchema }), async (req, res, next) => {
    try {
      const { username, password } = req.validated.body;
      const row = await queryOneFn(
        'SELECT * FROM `FinanceUser` WHERE `username` = ? AND `deleted_at` IS NULL LIMIT 1',
        [username]
      );
      const stored = row?.password ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
      const check = await verifyPassword(password, stored);
      if (!row || !check.ok) {
        // Conta credencial errada na conta (se existir). A verificação de bloqueio
        // vem DEPOIS da senha de propósito: quem não sabe a senha recebe sempre
        // INVALID_CREDS e não consegue inferir se a conta está bloqueada.
        if (row) await registerFailedLogin(row);
        audit(req, { action: 'login_fail', username, user_id: row?.id ?? null, status_code: 401 });
        throw ERR.INVALID_CREDS();
      }

      // Senha correta, mas conta ainda dentro da janela de bloqueio: barra mesmo
      // assim (não destrava com a senha certa) e NÃO emite sessão.
      if (row.locked_until && new Date(row.locked_until) > new Date()) {
        throw ERR.LOCKED(new Date(row.locked_until).getTime() - Date.now());
      }

      // Aprovação de cadastro (auto-registro): pendente recebe mensagem clara
      // (a pessoa sabe que se cadastrou); rejeitado responde como credencial
      // inválida — não confirma a existência da conta pra quem foi barrado.
      const status = row.status || 'aprovado';
      if (status === 'pendente') {
        throw ERR.FORBIDDEN('Cadastro aguardando aprovacao do administrador.');
      }
      if (status !== 'aprovado') {
        throw ERR.INVALID_CREDS();
      }

      // Resolve o ambiente inicial ANTES de emitir a sessao, pra sessao nunca
      // sair do login sem ambiente_tipo definido (a janela entre o login e o
      // primeiro POST /auth/ambiente e o que deixava rotas exclusivamente
      // empresariais abertas pra um usuario workspaces='pessoal' — ver
      // docs/PLANO-CF-FINANCE-ISOLAMENTO.md, Fase 2). resolveAmbienteAlvo
      // agora valida vinculo ativo em FinanceUserEmpresa (coisa que o login
      // nunca fez) — se isso falhar por inconsistencia de dado, NAO bloqueia
      // o login: cai pro fallback baseado em workspaces em financeAuth.js.
      const tipoInicial = row.workspaces === 'empresarial' ? 'empresarial' : 'pessoal';
      let alvo = null;
      try {
        alvo = await resolveAmbienteAlvo(
          { id: row.id, nome: row.nome, empresa_id: row.empresa_id, role: row.role },
          { tipo: tipoInicial, empresa_id: row.empresa_id }
        );
      } catch {
        // Vinculo inconsistente/ausente: login segue sem ambiente explicito.
      }

      const { accessToken } = issueFinanceSession(row, alvo);
      setFinanceAuthCookie(res, accessToken);

      const csrfToken = buildFinanceCsrfToken({ userId: row.id });

      // Login OK: zera contador de falhas e limpa qualquer lock residual expirado.
      await executeUpdateFn('FinanceUser', {
        last_login_at: new Date(),
        failed_login_attempts: 0,
        locked_until: null,
        updatedAt: new Date()
      }, '`id` = ?', [row.id]);

      audit(req, {
        action: 'login_ok', user_id: row.id, username: row.username,
        role: row.role, empresa_id: row.empresa_id ?? null, status_code: 200
      });
      return res.json({ ok: true, user: serializeUser(row), ambiente: alvo, csrf_token: csrfToken });
    } catch (e) { next(e); }
  });

  // POST /register — auto-cadastro público (SEM sessão). A conta nasce
  // status='pendente' e só entra depois que um admin aprovar no painel.
  // Superfície pública, então: rate-limit próprio (mais estrito que login),
  // validação zod estrita, senha com hash forte (mesmo pipeline do painel),
  // role/workspaces SEMPRE forçados no mínimo (usuario/pessoal) — o corpo da
  // requisição não consegue se auto-promover; quem eleva é o admin, depois.
  router.post('/register', registerLimiter, validate({ body: registerSchema }), async (req, res, next) => {
    try {
      const body = req.validated.body;

      const dupe = await queryOneFn(
        'SELECT `id` FROM `FinanceUser` WHERE `username` = ? LIMIT 1',
        [body.username]
      );
      if (dupe) throw ERR.CONFLICT('Este nome de usuario nao esta disponivel.');

      const now = new Date();
      const pii = encMany({
        email: body.email,
        telefone: body.telefone,
        documento: body.documento,
        empresa_solicitada: body.empresa
      }, USER_PII_FIELDS);
      await queryFn(
        `INSERT INTO \`FinanceUser\`
           (\`id\`, \`username\`, \`password\`, \`nome\`, \`email\`, \`telefone\`,
            \`documento\`, \`empresa_solicitada\`, \`plano\`, \`role\`, \`status\`,
            \`pagamento_status\`, \`workspaces\`, \`empresa_id\`,
            \`password_changed_at\`, \`createdAt\`, \`updatedAt\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'usuario', 'pendente', 'pendente', 'pessoal', NULL, ?, ?, ?)`,
        [randomUUID(), body.username, await hashPasswordFn(body.password),
         body.nome, pii.email, pii.telefone, pii.documento, pii.empresa_solicitada,
         body.plano ?? null, now, now, now]
      );

      audit(req, { action: 'register', username: body.username, status_code: 201 });
      return res.status(201).json({
        ok: true,
        message: 'Cadastro enviado! Voce podera entrar assim que um administrador aprovar.'
      });
    } catch (e) { next(e); }
  });

  // GET /me
  router.get('/me', requireFinanceAuth, async (req, res, next) => {
    try {
      const user = await queryOneFn(
        'SELECT * FROM `FinanceUser` WHERE `id` = ? AND `deleted_at` IS NULL LIMIT 1',
        [req.financeUser.id]
      );
      if (!user) throw ERR.INVALID_TOKEN();
      const [ambientes, moedaPessoal, delegacoes, ownerRow] = await Promise.all([
        listAmbientes(req.financeUser.id),
        readPersonalCurrency(queryOneFn, req.financeUser.id),
        listDelegacoes(req.financeUser.id),
        req.financeUser.delegado
          ? queryOneFn('SELECT `nome` FROM `FinanceUser` WHERE `id` = ? LIMIT 1', [req.financeUser.pessoal_owner_id])
          : null
      ]);
      return res.json({
        ...serializeUser(user),
        moeda_pessoal: moedaPessoal,
        ambiente: {
          tipo: req.financeUser.ambiente_tipo,
          empresa_id: req.financeUser.empresa_id,
          // true so quando a sessao passou por uma resolucao explicita de
          // ambiente (login com vinculo ok, ou POST /auth/ambiente) — o
          // frontend usa isto pra decidir se pode confiar neste valor sem
          // reconfirmar com o backend (ver app-hotfix.js boot()).
          explicito: req.financeUser.ambiente_explicito,
          // Presentes so quando o ambiente pessoal ativo e delegado (gestor
          // comandando a conta de terceiro) — ver security/ambiente.js.
          owner_id: req.financeUser.delegado ? req.financeUser.pessoal_owner_id : null,
          owner_nome: req.financeUser.delegado ? (ownerRow?.nome ?? null) : null,
          permissao: req.financeUser.delegado ? req.financeUser.delegacao_permissao : null
        },
        ambientes,
        // Contas pessoais de terceiros que ESTE usuario comanda (painel lateral).
        delegacoes
      });
    } catch (e) { next(e); }
  });

  // PATCH /me/moeda — o próprio usuário define sua moeda padrão pessoal (a
  // moeda-base do ambiente Pessoal, em que a dashboard consolida os valores).
  // Regra "só Pessoal": só disponível para quem tem acesso ao ambiente pessoal
  // (workspaces 'pessoal' ou 'ambos'). Moeda do ambiente empresarial continua
  // sob controle do admin (é compartilhada pela empresa).
  router.patch('/me/moeda', requireFinanceAuth, csrfMiddleware, validate({ body: moedaMeSchema }), async (req, res, next) => {
    try {
      const { moeda } = req.validated.body;
      const user = await queryOneFn(
        'SELECT `id`, `nome`, `username`, `workspaces` FROM `FinanceUser` WHERE `id` = ? AND `deleted_at` IS NULL LIMIT 1',
        [req.financeUser.id]
      );
      if (!user) throw ERR.INVALID_TOKEN();
      if (!['pessoal', 'ambos'].includes(user.workspaces || 'ambos')) {
        throw ERR.FORBIDDEN('Moeda pessoal disponivel apenas para o ambiente Pessoal.');
      }

      const conn = await poolRef.getConnection();
      try {
        await conn.beginTransaction();
        await syncUserPersonalCurrency(conn, { id: user.id, nome: user.nome }, moeda);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      audit(req, {
        action: 'moeda_pessoal', user_id: user.id, username: user.username,
        role: req.financeUser.role ?? null, status_code: 200
      });
      return res.json({ ok: true, moeda_pessoal: moeda });
    } catch (e) { next(e); }
  });

  // POST /ambiente — troca o ambiente ativo (Pessoal x Empresarial) da sessao
  // atual. Reemite cookie de sessao com a nova empresa_id/tipo; nao muda a
  // empresa "dona" do usuario (FinanceUser.empresa_id) em nada.
  router.post('/ambiente', requireFinanceAuth, csrfMiddleware, validate({ body: ambienteSchema }), async (req, res, next) => {
    try {
      const alvo = await resolveAmbienteAlvo(req.financeUser, req.validated.body);
      const userRow = await queryOneFn(
        'SELECT * FROM `FinanceUser` WHERE `id` = ? AND `deleted_at` IS NULL LIMIT 1',
        [req.financeUser.id]
      );
      if (!userRow) throw ERR.INVALID_TOKEN();

      const { accessToken } = issueFinanceSession(userRow, alvo);
      setFinanceAuthCookie(res, accessToken);

      const csrfToken = buildFinanceCsrfToken({ userId: userRow.id });

      audit(req, {
        action: 'ambiente', user_id: userRow.id, username: userRow.username,
        role: userRow.role, empresa_id: alvo.empresa_id ?? null, status_code: 200,
        entity: 'ambiente', entity_id: alvo.owner_id ?? null
      });
      return res.json({ ok: true, ambiente: alvo, csrf_token: csrfToken });
    } catch (e) { next(e); }
  });

  // POST /logout
  router.post('/logout', async (req, res) => {
    // Logout não passa por requireFinanceAuth: resolve o usuário best-effort
    // lendo o cookie de sessão; sem/ inválido → loga sem user_id mesmo assim.
    let user = null;
    const access = readFinanceAccessToken(req);
    if (access) {
      try { user = verifyFinanceAccessToken(access); } catch { /* expirado/ inválido */ }
    }
    clearFinanceAuthCookies(res);
    audit(req, {
      action: 'logout', user_id: user?.sub ?? null, role: user?.role ?? null,
      empresa_id: user?.empresa_id ?? null, status_code: 200
    });
    return res.json({ ok: true });
  });

  return router;
}
