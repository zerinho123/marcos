// ============================================================================
// routes/metas.js — Metas financeiras
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne } from '../db.js';
import { wrap, requireFields, parseDecimal, parseDate, enumOr, resolveFinanceEmpresa, resolveFinanceEscopo } from './_common.js';
import { ERR } from '../security/errors.js';
import { novoGrupo, registrarExclusao } from './_lixeira.js';

const STATUS = ['ativa', 'concluida', 'cancelada'];

export function buildMetasRouter({ poolRef = pool, queryFn = query, queryOneFn = queryOne } = {}) {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const escopo = resolveFinanceEscopo(req);
    const { status } = req.query;
    const where = ['`empresa_id` = ?', '`escopo` = ?'];
    const params = [empresaId, escopo];
    if (status) {
      enumOr(status, STATUS, 'status');
      where.push('`status` = ?');
      params.push(status);
    } else {
      where.push('`status` <> ?');
      params.push('cancelada');
    }

    const rows = await queryFn(
      `SELECT \`id\`, \`nome\`, \`nome\` AS \`titulo\`, \`valor_alvo\`, \`valor_atual\`, \`prazo\`, \`status\`
         FROM \`FinMeta\` WHERE ${where.join(' AND ')}
        ORDER BY \`status\`, \`prazo\``,
      params
    );
    for (const m of rows) {
      m.percentual = Number(m.valor_alvo) > 0
        ? Math.min(100, Math.round((Number(m.valor_atual) / Number(m.valor_alvo)) * 100))
        : 0;
    }
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    const nome = req.body.nome ?? req.body.titulo;
    requireFields({ ...req.body, nome }, ['nome', 'valor_alvo']);
    const empresaId = resolveFinanceEmpresa(req);
    const escopo = resolveFinanceEscopo(req);
    const valor_alvo = parseDecimal(req.body.valor_alvo);
    const prazo = req.body.prazo ? parseDate(req.body.prazo) : null;

    const id = randomUUID();
    await queryFn(
      `INSERT INTO \`FinMeta\` (\`id\`, \`empresa_id\`, \`escopo\`, \`nome\`, \`valor_alvo\`, \`prazo\`)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, empresaId, escopo, nome, valor_alvo, prazo]
    );
    res.status(201).json({ id });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    if (req.body.status) enumOr(req.body.status, STATUS, 'status');
    const r = await queryFn(
      `UPDATE \`FinMeta\`
          SET \`nome\`       = COALESCE(?, \`nome\`),
              \`valor_alvo\` = COALESCE(?, \`valor_alvo\`),
              \`prazo\`      = COALESCE(?, \`prazo\`),
              \`status\`     = COALESCE(?, \`status\`),
              \`updatedAt\`  = NOW(3)
        WHERE \`id\` = ? AND \`empresa_id\` = ?`,
      [
        req.body.nome ?? null, req.body.valor_alvo ?? null,
        req.body.prazo ?? null, req.body.status ?? null,
        req.params.id, empresaId
      ]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Meta nao encontrada.');
    res.json({ ok: true });
  }));

  router.patch('/:id/aporte', wrap(async (req, res) => {
    requireFields(req.body, ['valor']);
    const empresaId = resolveFinanceEmpresa(req);
    const valor = parseDecimal(req.body.valor);

    const meta = await queryOneFn(
      'SELECT `valor_alvo`, `valor_atual`, `status` FROM `FinMeta` WHERE `id` = ? AND `empresa_id` = ?',
      [req.params.id, empresaId]
    );
    if (!meta) throw ERR.NOT_FOUND('Meta nao encontrada.');
    if (meta.status !== 'ativa') throw ERR.CONFLICT('Meta nao esta ativa.');

    const novoAtual = Number(meta.valor_atual) + valor;
    const novoStatus = novoAtual >= Number(meta.valor_alvo) ? 'concluida' : 'ativa';
    await queryFn(
      'UPDATE `FinMeta` SET `valor_atual` = ?, `status` = ?, `updatedAt` = NOW(3) WHERE `id` = ? AND `empresa_id` = ?',
      [novoAtual, novoStatus, req.params.id, empresaId]
    );
    res.json({
      valor_atual: novoAtual.toFixed(2),
      percentual: Math.min(100, Math.round((novoAtual / Number(meta.valor_alvo)) * 100)),
      status: novoStatus
    });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const conn = await poolRef.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT `nome`, `escopo`, `valor_alvo` FROM `FinMeta` WHERE `id` = ? AND `empresa_id` = ? FOR UPDATE',
        [req.params.id, empresaId]
      );
      const meta = rows[0];
      if (!meta) throw ERR.NOT_FOUND('Meta nao encontrada.');
      const [r] = await conn.execute(
        "UPDATE `FinMeta` SET `status` = 'cancelada', `updatedAt` = NOW(3) WHERE `id` = ? AND `empresa_id` = ?",
        [req.params.id, empresaId]
      );
      if (!r.affectedRows) throw ERR.NOT_FOUND('Meta nao encontrada.');
      await registrarExclusao(conn, {
        grupoId: novoGrupo(), entidade: 'meta', entidadeId: req.params.id,
        empresaId, escopo: meta.escopo, estrategia: 'flag',
        rotulo: meta.nome || null, valor: meta.valor_alvo, req
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
