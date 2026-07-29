// ============================================================================
// routes/delegacoes.js — FinanceDelegacao (gestor comanda N contas pessoais)
// ----------------------------------------------------------------------------
// Quem concede: SO o dono do sistema. Fecha o pedido "outros admins nao podem
// ter acesso das contas por conta propria" — ninguem se auto-delega, e nenhum
// admin concede a si mesmo ou a outro admin.
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne } from '../db.js';
import { wrap, requireFields, enumOr } from './_common.js';
import { ERR } from '../security/errors.js';
import { listDelegacoes } from '../security/ambiente.js';
import { novoGrupo, registrarExclusao, snapshotLinha } from './_lixeira.js';

const PERMISSOES = ['visualizar', 'operar'];

// Fallback defensivo: se o chamador esquecer de injetar requireFinanceOwner,
// nega por padrao em vez de deixar o router quebrar no registro da rota.
const denyOwnerOnly = (_req, _res, next) => next(ERR.FORBIDDEN('Acao exclusiva do dono do sistema.'));

export function buildDelegacoesRouter({ requireFinanceOwner = denyOwnerOnly, poolRef = pool, queryFn = query, queryOneFn = queryOne } = {}) {
  const router = Router();

  // GET /minhas — contas que EU comando (alimenta o painel lateral).
  router.get('/minhas', wrap(async (req, res) => {
    const rows = await listDelegacoes(req.financeUser.id);
    res.json(rows);
  }));

  // GET / — todas as delegacoes do sistema. So o dono.
  router.get('/', requireFinanceOwner, wrap(async (req, res) => {
    const rows = await queryFn(
      `SELECT d.\`id\`, d.\`gestor_id\`, d.\`usuario_id\`, d.\`permissao\`, d.\`ativo\`,
              d.\`concedido_por\`, d.\`createdAt\`, d.\`updatedAt\`,
              g.\`nome\` AS gestor_nome, g.\`username\` AS gestor_username,
              u.\`nome\` AS usuario_nome, u.\`username\` AS usuario_username
         FROM \`FinanceDelegacao\` d
         JOIN \`FinanceUser\` g ON g.\`id\` = d.\`gestor_id\`
         JOIN \`FinanceUser\` u ON u.\`id\` = d.\`usuario_id\`
        ORDER BY d.\`ativo\` DESC, g.\`nome\`, u.\`nome\``
    );
    res.json(rows);
  }));

  // POST / — concede delegacao. So o dono.
  router.post('/', requireFinanceOwner, wrap(async (req, res) => {
    requireFields(req.body, ['gestor_id', 'usuario_id']);
    const gestorId = String(req.body.gestor_id).trim();
    const usuarioId = String(req.body.usuario_id).trim();
    if (gestorId === usuarioId) throw ERR.VALIDATION('Gestor e usuario nao podem ser a mesma conta.');
    const permissao = req.body.permissao ? enumOr(req.body.permissao, PERMISSOES, 'permissao') : 'visualizar';

    const [gestor, usuario] = await Promise.all([
      queryOneFn('SELECT `id`, `role` FROM `FinanceUser` WHERE `id` = ? AND `deleted_at` IS NULL LIMIT 1', [gestorId]),
      queryOneFn('SELECT `id`, `role` FROM `FinanceUser` WHERE `id` = ? AND `deleted_at` IS NULL LIMIT 1', [usuarioId])
    ]);
    if (!gestor) throw ERR.VALIDATION('Gestor invalido.');
    if (!usuario) throw ERR.VALIDATION('Usuario invalido.');
    if (usuario.role === 'dono') throw ERR.VALIDATION('Nao e possivel delegar a conta do dono do sistema.');

    const id = randomUUID();
    await queryFn(
      `INSERT INTO \`FinanceDelegacao\` (\`id\`, \`gestor_id\`, \`usuario_id\`, \`permissao\`, \`ativo\`, \`concedido_por\`)
       VALUES (?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE \`permissao\` = VALUES(\`permissao\`), \`ativo\` = 1, \`concedido_por\` = VALUES(\`concedido_por\`), \`updatedAt\` = NOW(3)`,
      [id, gestorId, usuarioId, permissao, req.financeUser.id]
    );
    res.status(201).json({ id, gestor_id: gestorId, usuario_id: usuarioId, permissao });
  }));

  // PATCH /:id — muda permissao e/ou ativo. So o dono.
  router.patch('/:id', requireFinanceOwner, wrap(async (req, res) => {
    const permissao = req.body.permissao != null ? enumOr(req.body.permissao, PERMISSOES, 'permissao') : null;
    const ativo = req.body.ativo == null ? null : (req.body.ativo ? 1 : 0);
    const r = await queryFn(
      `UPDATE \`FinanceDelegacao\`
          SET \`permissao\` = COALESCE(?, \`permissao\`),
              \`ativo\`      = COALESCE(?, \`ativo\`),
              \`updatedAt\`  = NOW(3)
        WHERE \`id\` = ?`,
      [permissao, ativo, req.params.id]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Delegacao nao encontrada.');
    res.json({ ok: true });
  }));

  // DELETE /:id — revoga (ativo=0, a linha fica no banco) e registra na
  // lixeira. Restaurar (POST /lixeira/:id/restaurar) so flipa ativo=1 de novo
  // — ver REGISTRO_ENTIDADES.delegacao em routes/_lixeira.js.
  router.delete('/:id', requireFinanceOwner, wrap(async (req, res) => {
    const conn = await poolRef.getConnection();
    try {
      await conn.beginTransaction();
      const snapshot = await snapshotLinha(conn, 'FinanceDelegacao', req.params.id);
      if (!snapshot) throw ERR.NOT_FOUND('Delegacao nao encontrada.');
      const [r] = await conn.execute(
        'UPDATE `FinanceDelegacao` SET `ativo` = 0, `updatedAt` = NOW(3) WHERE `id` = ? AND `ativo` = 1',
        [req.params.id]
      );
      if (!r.affectedRows) throw ERR.CONFLICT('Delegacao ja estava revogada.');
      await registrarExclusao(conn, {
        grupoId: novoGrupo(), entidade: 'delegacao', entidadeId: req.params.id,
        estrategia: 'flag', snapshot, rotulo: 'Delegacao revogada', req
      });
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ ok: true });
  }));

  return router;
}
