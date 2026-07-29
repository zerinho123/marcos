// ============================================================================
// routes/users.js — CRUD de FinanceUser (admin only)
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { hashPassword }                          from '../security/financeAuth.js';
import { validate }                              from '../security/validation.js';
import { ERR }                                   from '../security/errors.js';
import { isMoedaSuportada }                      from '../security/cambio.js';
import { syncUserPersonalCurrency }              from './_personal-currency.js';
import { decOne, encMany }                        from '../security/encryption.js';
import { logAuditEvent }                          from '../security/auditLog.js';
import { pool, query, queryOne }                from '../db.js';
import { novoGrupo, registrarExclusao }           from './_lixeira.js';

const USER_PII_FIELDS = ['email', 'telefone', 'documento', 'empresa_solicitada'];

// E-mail "semi-obrigatório": vazio/ausente => undefined (não grava); se vier
// preenchido, precisa ser um e-mail válido. Não bloqueia o cadastro.
const emailOptional = z.preprocess(
  (v) => (v == null || (typeof v === 'string' && v.trim() === '') ? undefined
        : typeof v === 'string' ? v.trim() : v),
  z.string().email('E-mail inválido.').max(191).optional()
);

const nullableText = (max) => z.preprocess(
  (v) => (v === undefined ? undefined
        : v === null || (typeof v === 'string' && v.trim() === '') ? null
        : typeof v === 'string' ? v.trim() : v),
  z.string().max(max).nullable().optional()
);

const moedaPessoalOptional = z.preprocess(
  (v) => (v == null || (typeof v === 'string' && v.trim() === '') ? undefined : v),
  z.string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine(isMoedaSuportada, 'Moeda pessoal invalida.')
    .optional()
);

export const financeUserCreateSchema = z.object({
  username:   z.string().min(3).max(191).trim().toLowerCase().regex(/^[a-z0-9._-]+$/),
  password:   z.string().min(8).max(128),
  nome:       z.string().min(1).max(191).trim(),
  email:      emailOptional,
  telefone:   nullableText(32),
  documento:  nullableText(32),
  empresa_solicitada: nullableText(191),
  plano:      nullableText(120),
  // 'dono' aceito no schema, mas so quem ja e dono pode de fato usa-lo — a
  // checagem (403 pra quem nao for) acontece no handler, nao aqui (o zod nao
  // enxerga req.financeUser).
  role:       z.enum(['dono', 'admin', 'usuario']).default('usuario'),
  status:     z.enum(['pendente', 'aprovado', 'rejeitado']).default('aprovado'),
  pagamento_status: z.enum(['pendente', 'pago', 'isento']).default('pendente'),
  workspaces: z.enum(['pessoal', 'empresarial', 'ambos']).default('ambos'),
  access_level: z.enum(['consulta', 'operacao']).default('operacao'),
  moeda_pessoal: moedaPessoalOptional,
  empresa_id: z.string().max(191).nullish(),
  empresa_ids: z.array(z.string().max(191)).optional()
});

export const financeUserUpdateSchema = z.object({
  username:   z.string().min(3).max(191).trim().toLowerCase().regex(/^[a-z0-9._-]+$/).optional(),
  nome:       z.string().min(1).max(191).trim().optional(),
  email:      emailOptional,
  telefone:   nullableText(32),
  documento:  nullableText(32),
  empresa_solicitada: nullableText(191),
  plano:      nullableText(120),
  role:       z.enum(['dono', 'admin', 'usuario']).optional(),
  status:     z.enum(['pendente', 'aprovado', 'rejeitado']).optional(),
  pagamento_status: z.enum(['pendente', 'pago', 'isento']).optional(),
  locked:     z.boolean().optional(),
  workspaces: z.enum(['pessoal', 'empresarial', 'ambos']).optional(),
  access_level: z.enum(['consulta', 'operacao']).optional(),
  moeda_pessoal: moedaPessoalOptional,
  empresa_id: z.string().max(191).nullish(),
  empresa_ids: z.array(z.string().max(191)).optional()
});

const financePasswordResetSchema = z.object({
  password: z.string().min(8).max(128)
});

export const financeUserAprovacaoSchema = z.object({
  acao: z.enum(['aprovar', 'rejeitar']),
  // Aprovando, o admin pode já definir acesso/vínculos (senão fica o mínimo
  // do auto-registro: usuario/pessoal, ajustável depois pelo form normal).
  workspaces: z.enum(['pessoal', 'empresarial', 'ambos']).optional(),
  empresa_ids: z.array(z.string().max(191)).optional()
});

// Situação de pagamento (verificação manual pelo admin — sem gateway).
export const financeUserPagamentoSchema = z.object({
  pagamento_status: z.enum(['pendente', 'pago', 'isento'])
});

// SELECT único reutilizado por todas as leituras — inclui email e o nome da
// empresa vinculada (LEFT JOIN), pra listagem mostrar o vínculo sem N+1.
const USER_SELECT =
  'SELECT u.`id`,u.`username`,u.`nome`,u.`email`,u.`telefone`,u.`documento`,' +
  ' u.`empresa_solicitada`,u.`plano`,u.`pagamento_status`,u.`pagamento_em`,' +
  ' u.`role`,u.`status`,u.`aprovado_em`,u.`workspaces`,u.`access_level`,u.`empresa_id`,' +
  ' e.`nome` AS `empresa_nome`,' +
  ' u.`mfa_enabled`,u.`last_login_at`,u.`locked_until`,u.`session_version`,u.`deleted_at`,' +
  ' u.`createdAt`,u.`updatedAt`' +
  ' FROM `FinanceUser` u LEFT JOIN `Empresa` e ON e.`id` = u.`empresa_id`';

function serialize(u) {
  if (!u) return null;
  const safe = decOne(u, USER_PII_FIELDS);
  return {
    id:            safe.id,
    username:      safe.username,
    nome:          safe.nome,
    email:         safe.email ?? null,
    telefone:      safe.telefone ?? null,
    documento:     safe.documento ?? null,
    empresa_solicitada: safe.empresa_solicitada ?? null,
    plano:         safe.plano ?? null,
    pagamento_status: safe.pagamento_status ?? 'pendente',
    pagamento_em:  safe.pagamento_em ?? null,
    role:          safe.role,
    is_owner:      safe.role === 'dono',
    status:        safe.status ?? 'aprovado',
    aprovado_em:   safe.aprovado_em ?? null,
    workspaces:    safe.workspaces ?? 'ambos',
    access_level:  ['admin', 'dono'].includes(safe.role) ? 'operacao' : (safe.access_level ?? 'operacao'),
    empresa_id:    safe.empresa_id ?? null,
    empresa_nome:  safe.empresa_nome ?? null,
    empresa_ids:   safe.empresa_ids ?? [],
    empresas:      safe.empresas ?? [],
    mfa_enabled:   Boolean(safe.mfa_enabled),
    last_login_at: safe.last_login_at ?? null,
    locked_until:  safe.locked_until ?? null,
    session_version: Number(safe.session_version || 0),
    deleted_at:    safe.deleted_at ?? null,
    createdAt:     safe.createdAt,
    updatedAt:     safe.updatedAt
  };
}

function normalizeEmpresaIds(body) {
  const raw = Array.isArray(body.empresa_ids)
    ? body.empresa_ids
    : body.empresa_id
      ? [body.empresa_id]
      : [];
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

function hasEmpresarialAccess(workspaces) {
  return ['empresarial', 'ambos'].includes(workspaces || 'ambos');
}

function hasPessoalAccess(workspaces) {
  return ['pessoal', 'ambos'].includes(workspaces || 'ambos');
}

function assertEmpresaRule({ role, workspaces, empresaIds }) {
  if (!['admin', 'dono'].includes(role) && hasEmpresarialAccess(workspaces) && empresaIds.length === 0) {
    throw ERR.VALIDATION('Usuario com acesso empresarial precisa de ao menos uma empresa.');
  }
}

// So o dono pode promover/manter alguem como 'dono'. Admin tentando e 403 —
// fecha o vetor mais obvio de um admin comum virar dono por conta propria.
function assertRolePermitido(role, requester) {
  if (role === 'dono' && !requester?.is_owner) {
    throw ERR.FORBIDDEN('Somente o dono do sistema pode conceder o papel de dono.');
  }
}

function assertMoedaPessoalRule({ workspaces, moedaPessoal }) {
  if (moedaPessoal && !hasPessoalAccess(workspaces)) {
    throw ERR.VALIDATION('Moeda pessoal exige acesso ao ambiente pessoal.');
  }
}

async function attachEmpresas(rows, queryFn) {
  const list = rows.map(serialize);
  if (!list.length) return list;
  const ids = list.map((u) => u.id);
  const placeholders = ids.map(() => '?').join(',');
  const links = await queryFn(
    `SELECT fue.\`user_id\`, fue.\`empresa_id\`, fue.\`perfil\`, e.\`nome\`, e.\`tipo\`, e.\`moeda_base\`
       FROM \`FinanceUserEmpresa\` fue
       JOIN \`Empresa\` e ON e.\`id\` = fue.\`empresa_id\`
      WHERE fue.\`ativo\` = 1 AND fue.\`user_id\` IN (${placeholders})
      ORDER BY e.\`tipo\`, e.\`nome\``,
    ids
  );
  const byUser = new Map();
  const personalCurrencyByUser = new Map();
  for (const link of links) {
    if (link.tipo === 'pessoal') {
      personalCurrencyByUser.set(link.user_id, link.moeda_base || 'BRL');
      continue;
    }
    const arr = byUser.get(link.user_id) || [];
    arr.push({
      id: link.empresa_id,
      nome: link.nome,
      perfil: link.perfil
    });
    byUser.set(link.user_id, arr);
  }
  for (const user of list) {
    user.empresas = byUser.get(user.id) || [];
    user.empresa_ids = user.empresas.map((e) => e.id);
    user.moeda_pessoal = personalCurrencyByUser.get(user.id) || 'BRL';
  }
  return list;
}

async function syncUserEmpresas(conn, userId, empresaIds, perfil = 'financeiro') {
  await conn.execute(
    `UPDATE \`FinanceUserEmpresa\` fue
       JOIN \`Empresa\` e ON e.\`id\` = fue.\`empresa_id\` AND e.\`tipo\` = 'normal'
        SET fue.\`ativo\` = 0, fue.\`updatedAt\` = NOW(3)
      WHERE fue.\`user_id\` = ?`,
    [userId]
  );
  for (const empresaId of empresaIds) {
    // Empresa pessoal e sintetica e nunca pode ganhar vinculo por aqui — a
    // tela de usuarios nao e caminho de delegacao (isso e FinanceDelegacao,
    // ver routes/delegacoes.js). Sem essa trava, dar acesso empresarial a
    // alguem poderia vincula-lo ao Pessoal de outra pessoa por engano.
    const [tipoRows] = await conn.execute('SELECT `tipo` FROM `Empresa` WHERE `id` = ? LIMIT 1', [empresaId]);
    if (!tipoRows[0] || tipoRows[0].tipo !== 'normal') {
      throw ERR.VALIDATION('empresa_ids deve conter apenas empresas normais.');
    }
    await conn.execute(
      `INSERT INTO \`FinanceUserEmpresa\` (\`id\`, \`user_id\`, \`empresa_id\`, \`perfil\`, \`ativo\`)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE \`perfil\` = VALUES(\`perfil\`), \`ativo\` = 1, \`updatedAt\` = NOW(3)`,
      [randomUUID(), userId, empresaId, perfil]
    );
  }
}

async function insertFinanceUser(conn, user) {
  const secured = encMany(user, USER_PII_FIELDS);
  await conn.execute(
    `INSERT INTO \`FinanceUser\`
      (\`id\`, \`username\`, \`password\`, \`nome\`, \`email\`, \`telefone\`, \`documento\`,
       \`empresa_solicitada\`, \`plano\`, \`role\`, \`status\`, \`pagamento_status\`, \`workspaces\`, \`access_level\`,
       \`empresa_id\`, \`password_changed_at\`, \`createdAt\`, \`updatedAt\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      secured.id, secured.username, secured.password, secured.nome, secured.email, secured.telefone,
      secured.documento, secured.empresa_solicitada, secured.plano, secured.role, secured.status,
      secured.pagamento_status, secured.workspaces, secured.access_level, secured.empresa_id, secured.password_changed_at,
      secured.createdAt, secured.updatedAt
    ]
  );
}

async function updateFinanceUser(conn, id, patch) {
  const entries = Object.entries(encMany(patch, USER_PII_FIELDS)).filter(([, value]) => value !== undefined);
  if (!entries.length) return 0;
  const setSql = entries.map(([key]) => `\`${key}\` = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  const [result] = await conn.execute(
    `UPDATE \`FinanceUser\` SET ${setSql} WHERE \`id\` = ?`,
    [...values, id]
  );
  return result.affectedRows ?? 0;
}

export function buildFinanceUsersRouter({
  requireFinanceAdmin,
  poolRef = pool,
  queryFn = query,
  queryOneFn = queryOne,
  hashPasswordFn = hashPassword,
  auditFn = logAuditEvent
} = {}) {
  const router = Router();

  async function auditRequired(req, conn, action, targetId, statusCode = 200) {
    await auditFn({
      empresa_id: req.financeUser.empresa_id ?? null,
      user_id: req.financeUser.id,
      username: req.financeUser.username ?? null,
      role: req.financeUser.role,
      action,
      method: req.method,
      path: (req.baseUrl || '') + (req.path || ''),
      entity: 'users',
      entity_id: targetId,
      status_code: statusCode,
      ip: req.ip,
      request_id: req.id
    }, {
      queryFn: async (sql, params) => {
        const [result] = await conn.execute(sql, params);
        return result;
      },
      required: true
    });
    req.auditHandled = true;
  }

  // GET /api/finance/users
  router.get('/', requireFinanceAdmin, async (_req, res, next) => {
    try {
      const rows = await queryFn(`${USER_SELECT} ORDER BY u.\`createdAt\` DESC`);
      return res.json(await attachEmpresas(rows, queryFn));
    } catch (e) { next(e); }
  });

  // GET /api/finance/users/:id
  router.get('/:id', requireFinanceAdmin, async (req, res, next) => {
    try {
      const user = await queryOneFn(`${USER_SELECT} WHERE u.\`id\` = ? LIMIT 1`, [req.params.id]);
      if (!user) throw ERR.NOT_FOUND();
      const [serialized] = await attachEmpresas([user], queryFn);
      return res.json(serialized);
    } catch (e) { next(e); }
  });

  // POST /api/finance/users
  router.post('/', requireFinanceAdmin, validate({ body: financeUserCreateSchema }), async (req, res, next) => {
    try {
      const body = req.validated.body;
      assertRolePermitido(body.role, req.financeUser);
      const empresaIds = normalizeEmpresaIds(body);
      assertEmpresaRule({ role: body.role, workspaces: body.workspaces, empresaIds });
      assertMoedaPessoalRule({ workspaces: body.workspaces, moedaPessoal: body.moeda_pessoal });

      const dupe = await queryOneFn(
        'SELECT `id` FROM `FinanceUser` WHERE `username` = ? LIMIT 1',
        [body.username]
      );
      if (dupe) throw ERR.CONFLICT('Username ja em uso.');

      const user = {
        id:                   randomUUID(),
        username:             body.username,
        password:             await hashPasswordFn(body.password),
        nome:                 body.nome,
        email:                body.email ?? null,
        telefone:             body.telefone ?? null,
        documento:            body.documento ?? null,
        empresa_solicitada:   body.empresa_solicitada ?? null,
        plano:                body.plano ?? null,
        role:                 body.role,
        status:               body.status,
        pagamento_status:     body.pagamento_status,
        workspaces:           body.workspaces,
        access_level:         ['admin', 'dono'].includes(body.role) ? 'operacao' : body.access_level,
        empresa_id:           empresaIds[0] || null,
        password_changed_at:  new Date(),
        createdAt:            new Date(),
        updatedAt:            new Date()
      };

      const conn = await poolRef.getConnection();
      try {
        await conn.beginTransaction();
        await insertFinanceUser(conn, user);
        await syncUserEmpresas(conn, user.id, empresaIds, ['admin', 'dono'].includes(user.role) ? 'admin' : 'financeiro');
        if (hasPessoalAccess(user.workspaces)) {
          await syncUserPersonalCurrency(conn, user, body.moeda_pessoal || 'BRL');
        }
        await auditRequired(req, conn, 'user_create', user.id, 201);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      const saved = await queryOneFn(`${USER_SELECT} WHERE u.\`id\` = ? LIMIT 1`, [user.id]);
      const [serialized] = await attachEmpresas([saved], queryFn);
      return res.status(201).json(serialized);
    } catch (e) { next(e); }
  });

  // PUT /api/finance/users/:id
  router.put('/:id', requireFinanceAdmin, validate({ body: financeUserUpdateSchema }), async (req, res, next) => {
    try {
      const target = await queryOneFn(`${USER_SELECT} WHERE u.\`id\` = ? LIMIT 1`, [req.params.id]);
      if (!target) throw ERR.NOT_FOUND();

      const body = req.validated.body;
      assertRolePermitido(body.role, req.financeUser);
      const role = body.role ?? target.role;
      const status = body.status ?? target.status ?? 'aprovado';
      const locked = body.locked;
      const workspaces = body.workspaces ?? target.workspaces ?? 'ambos';
      const accessLevel = ['admin', 'dono'].includes(role) ? 'operacao' : (body.access_level ?? target.access_level ?? 'operacao');
      const empresaIds = body.empresa_ids !== undefined || body.empresa_id !== undefined
        ? normalizeEmpresaIds(body)
        : null;

      if (body.username !== undefined && body.username !== target.username) {
        const dupe = await queryOneFn(
          'SELECT `id` FROM `FinanceUser` WHERE `username` = ? AND `id` <> ? LIMIT 1',
          [body.username, target.id]
        );
        if (dupe) throw ERR.CONFLICT('Username ja em uso.');
      }

      const desativaAdmin = target.role === 'admin'
        && (role !== 'admin' || status !== 'aprovado' || locked === true);
      if (desativaAdmin) {
        const admins = await queryOneFn(
          `SELECT COUNT(*) AS n FROM \`FinanceUser\`
            WHERE \`role\` = ? AND \`id\` <> ?
              AND COALESCE(\`status\`, 'aprovado') = 'aprovado'
              AND \`deleted_at\` IS NULL
              AND (\`locked_until\` IS NULL OR \`locked_until\` <= NOW())`,
          ['admin', target.id]
        );
        if (Number(admins?.n || 0) < 1) {
          throw ERR.CONFLICT('Nao e permitido remover o ultimo administrador.');
        }
      }

      // Espelha a guarda do ultimo admin, mas para o dono: nunca fica o
      // sistema sem ninguem no papel mais alto.
      const desativaDono = target.role === 'dono'
        && (role !== 'dono' || status !== 'aprovado' || locked === true);
      if (desativaDono) {
        const donos = await queryOneFn(
          `SELECT COUNT(*) AS n FROM \`FinanceUser\`
            WHERE \`role\` = 'dono' AND \`id\` <> ?
              AND COALESCE(\`status\`, 'aprovado') = 'aprovado'
              AND \`deleted_at\` IS NULL
              AND (\`locked_until\` IS NULL OR \`locked_until\` <= NOW())`,
          [target.id]
        );
        if (Number(donos?.n || 0) < 1) {
          throw ERR.CONFLICT('Nao e permitido remover o unico dono do sistema.');
        }
      }

      if (empresaIds) assertEmpresaRule({ role, workspaces, empresaIds });
      assertMoedaPessoalRule({ workspaces, moedaPessoal: body.moeda_pessoal });

      const patch = { ...body, updatedAt: new Date() };
      if (body.access_level !== undefined || body.role !== undefined) {
        patch.access_level = accessLevel;
      }
      delete patch.empresa_ids;
      delete patch.locked;
      delete patch.moeda_pessoal;
      if (empresaIds) patch.empresa_id = empresaIds[0] || null;
      if (body.status !== undefined && body.status !== target.status) {
        patch.aprovado_por = req.financeUser.id;
        patch.aprovado_em = new Date();
      }
      const accessChanged = (body.status !== undefined && body.status !== target.status)
        || (body.role !== undefined && role !== target.role)
        || (body.workspaces !== undefined && workspaces !== target.workspaces)
        || (body.access_level !== undefined && accessLevel !== (target.access_level || 'operacao'))
        || empresaIds !== null;
      if (accessChanged) patch.session_version = Number(target.session_version || 0) + 1;
      if (body.pagamento_status !== undefined && body.pagamento_status !== target.pagamento_status) {
        patch.pagamento_por = req.financeUser.id;
        patch.pagamento_em = new Date();
      }
      if (locked !== undefined) {
        patch.locked_until = locked ? new Date('2999-12-31T23:59:59.000Z') : null;
        if (!locked) patch.failed_login_attempts = 0;
      }
      const hasUserPatch = Object.entries(patch)
        .some(([key, value]) => key !== 'updatedAt' && value !== undefined);

      if (!hasUserPatch && !empresaIds && body.moeda_pessoal === undefined) {
        const [serialized] = await attachEmpresas([target], queryFn);
        return res.json(serialized);
      }

      const conn = await poolRef.getConnection();
      try {
        await conn.beginTransaction();
        if (hasUserPatch) {
          await updateFinanceUser(conn, target.id, patch);
        }
        if (empresaIds) {
          await syncUserEmpresas(conn, target.id, empresaIds, ['admin', 'dono'].includes(role) ? 'admin' : 'financeiro');
        }
        if (body.moeda_pessoal !== undefined) {
          await syncUserPersonalCurrency(conn, {
            id: target.id,
            nome: body.nome ?? target.nome
          }, body.moeda_pessoal);
        }
        await auditRequired(req, conn, 'user_update', target.id);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      const updated = await queryOneFn(`${USER_SELECT} WHERE u.\`id\` = ? LIMIT 1`, [target.id]);
      const [serialized] = await attachEmpresas([updated], queryFn);
      return res.json(serialized);
    } catch (e) { next(e); }
  });

  // POST /api/finance/users/:id/aprovacao — decide um cadastro pendente.
  // Só cadastros 'pendente' podem ser decididos aqui (não vira atalho pra
  // banir usuário aprovado — pra isso existem editar/excluir, com as guardas
  // de último-admin). Auditoria: grava quem decidiu e quando.
  router.post('/:id/aprovacao', requireFinanceAdmin, validate({ body: financeUserAprovacaoSchema }), async (req, res, next) => {
    try {
      const target = await queryOneFn(`${USER_SELECT} WHERE u.\`id\` = ? LIMIT 1`, [req.params.id]);
      if (!target) throw ERR.NOT_FOUND();
      if (target.deleted_at) throw ERR.CONFLICT('Restaure o usuario antes de decidir o cadastro.');
      if ((target.status ?? 'aprovado') !== 'pendente') {
        throw ERR.CONFLICT('Este cadastro ja foi decidido.');
      }

      const body = req.validated.body;
      const aprovado = body.acao === 'aprovar';
      const workspaces = aprovado ? (body.workspaces ?? target.workspaces ?? 'pessoal') : target.workspaces;
      const empresaIds = aprovado ? normalizeEmpresaIds(body) : [];
      if (aprovado) assertEmpresaRule({ role: target.role, workspaces, empresaIds });

      const conn = await poolRef.getConnection();
      try {
        await conn.beginTransaction();
        await updateFinanceUser(conn, target.id, {
          status: aprovado ? 'aprovado' : 'rejeitado',
          aprovado_por: req.financeUser.id,
          aprovado_em: new Date(),
          session_version: Number(target.session_version || 0) + 1,
          workspaces: aprovado ? workspaces : undefined,
          empresa_id: aprovado && empresaIds.length ? empresaIds[0] : undefined,
          updatedAt: new Date()
        });
        if (aprovado && empresaIds.length) {
          await syncUserEmpresas(conn, target.id, empresaIds, 'financeiro');
        }
        await auditRequired(req, conn, aprovado ? 'user_approve' : 'user_reject', target.id);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      const updated = await queryOneFn(`${USER_SELECT} WHERE u.\`id\` = ? LIMIT 1`, [target.id]);
      const [serialized] = await attachEmpresas([updated], queryFn);
      return res.json(serialized);
    } catch (e) { next(e); }
  });

  // PATCH /api/finance/users/:id/pagamento — o admin marca a situação de
  // pagamento (verificação manual: confere o extrato por fora e registra).
  // Ação independente de aprovar/rejeitar; grava quem marcou e quando.
  router.patch('/:id/pagamento', requireFinanceAdmin, validate({ body: financeUserPagamentoSchema }), async (req, res, next) => {
    try {
      const target = await queryOneFn('SELECT `id` FROM `FinanceUser` WHERE `id` = ? LIMIT 1', [req.params.id]);
      if (!target) throw ERR.NOT_FOUND();

      const conn = await poolRef.getConnection();
      try {
        await conn.beginTransaction();
        await updateFinanceUser(conn, target.id, {
          pagamento_status: req.validated.body.pagamento_status,
          pagamento_por: req.financeUser.id,
          pagamento_em: new Date(),
          updatedAt: new Date()
        });
        await auditRequired(req, conn, 'user_payment_update', target.id);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      const updated = await queryOneFn(`${USER_SELECT} WHERE u.\`id\` = ? LIMIT 1`, [target.id]);
      const [serialized] = await attachEmpresas([updated], queryFn);
      return res.json(serialized);
    } catch (e) { next(e); }
  });

  // PATCH /api/finance/users/:id/password
  router.patch('/:id/password', requireFinanceAdmin, validate({ body: financePasswordResetSchema }), async (req, res, next) => {
    try {
      const target = await queryOneFn(
        'SELECT `id`, `session_version` FROM `FinanceUser` WHERE `id` = ? LIMIT 1',
        [req.params.id]
      );
      if (!target) throw ERR.NOT_FOUND();
      const hash = await hashPasswordFn(req.validated.body.password);
      const conn = await poolRef.getConnection();
      try {
        await conn.beginTransaction();
        await updateFinanceUser(conn, target.id, {
          password:               hash,
          password_changed_at:    new Date(),
          force_password_change:  1,
          session_version:        Number(target.session_version || 0) + 1,
          updatedAt:              new Date()
        });
        await auditRequired(req, conn, 'user_password_reset', target.id);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      return res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // DELETE /api/finance/users/:id - arquivamento logico.
  router.delete('/:id', requireFinanceAdmin, async (req, res, next) => {
    try {
      if (req.params.id === req.financeUser.id) {
        throw ERR.FORBIDDEN('Nao eh permitido arquivar a propria conta.');
      }
      const target = await queryOneFn(
        'SELECT `id`, `role`, `nome`, `username`, `empresa_id`, `session_version`, `deleted_at` FROM `FinanceUser` WHERE `id` = ? LIMIT 1',
        [req.params.id]
      );
      if (!target) throw ERR.NOT_FOUND();
      if (target.deleted_at) return res.json({ ok: true, archived: true });
      if (target.role === 'admin') {
        const admins = await queryOneFn(
          `SELECT COUNT(*) AS n FROM \`FinanceUser\`
            WHERE \`role\` = ? AND \`id\` <> ?
              AND COALESCE(\`status\`, 'aprovado') = 'aprovado'
              AND \`deleted_at\` IS NULL
              AND (\`locked_until\` IS NULL OR \`locked_until\` <= NOW())`,
          ['admin', target.id]
        );
        if (Number(admins?.n || 0) < 1) {
          throw ERR.CONFLICT('Nao e permitido arquivar o ultimo administrador.');
        }
      }
      if (target.role === 'dono') {
        const donos = await queryOneFn(
          `SELECT COUNT(*) AS n FROM \`FinanceUser\`
            WHERE \`role\` = 'dono' AND \`id\` <> ?
              AND COALESCE(\`status\`, 'aprovado') = 'aprovado'
              AND \`deleted_at\` IS NULL
              AND (\`locked_until\` IS NULL OR \`locked_until\` <= NOW())`,
          [target.id]
        );
        if (Number(donos?.n || 0) < 1) {
          throw ERR.CONFLICT('Nao e permitido arquivar o unico dono do sistema.');
        }
      }

      const conn = await poolRef.getConnection();
      try {
        await conn.beginTransaction();
        await updateFinanceUser(conn, target.id, {
          deleted_at: new Date(),
          session_version: Number(target.session_version || 0) + 1,
          updatedAt: new Date()
        });
        await registrarExclusao(conn, {
          grupoId: novoGrupo(), entidade: 'usuario', entidadeId: target.id,
          empresaId: target.empresa_id, estrategia: 'flag',
          rotulo: target.nome || target.username || null, req
        });
        await auditRequired(req, conn, 'user_archive', target.id);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      return res.json({ ok: true, archived: true });
    } catch (e) { next(e); }
  });

  // POST /api/finance/users/:id/restore
  router.post('/:id/restore', requireFinanceAdmin, async (req, res, next) => {
    try {
      const target = await queryOneFn(
        `${USER_SELECT} WHERE u.\`id\` = ? LIMIT 1`,
        [req.params.id]
      );
      if (!target) throw ERR.NOT_FOUND();
      if (!target.deleted_at) throw ERR.CONFLICT('Usuario nao esta arquivado.');

      const conn = await poolRef.getConnection();
      try {
        await conn.beginTransaction();
        await updateFinanceUser(conn, target.id, {
          deleted_at: null,
          session_version: Number(target.session_version || 0) + 1,
          updatedAt: new Date()
        });
        await auditRequired(req, conn, 'user_restore', target.id);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      const updated = await queryOneFn(`${USER_SELECT} WHERE u.\`id\` = ? LIMIT 1`, [target.id]);
      const [serialized] = await attachEmpresas([updated], queryFn);
      return res.json(serialized);
    } catch (e) { next(e); }
  });

  return router;
}
