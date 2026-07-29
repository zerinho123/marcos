// ============================================================================
// routes/lixeira.js — Lixeira universal (FinLixeira)
// ----------------------------------------------------------------------------
// GET /              — itens do ambiente ativo (empresa_id+escopo da sessao).
// GET /global         — TODAS as empresas/escopos. Exclusivo do dono.
// POST /:id/restaurar — restaura o grupo inteiro do item (transacional).
// DELETE /:id         — purga definitiva. Exclusiva do dono.
// ============================================================================

import { Router } from 'express';
import { pool, query, queryOne } from '../db.js';
import { wrap, resolveFinanceEmpresa, resolveFinanceEscopo } from './_common.js';
import { ERR } from '../security/errors.js';
import { decRows } from '../security/encryption.js';
import { restaurarGrupo } from './_lixeira.js';

const ENC = ['rotulo'];

function parseDataFiltro(value) {
  if (!value) return null;
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Fallback defensivo: se o chamador esquecer de injetar requireFinanceOwner,
// nega por padrao em vez de deixar o router quebrar no registro da rota.
const denyOwnerOnly = (_req, _res, next) => next(ERR.FORBIDDEN('Acao exclusiva do dono do sistema.'));

export function buildLixeiraRouter({ requireFinanceOwner = denyOwnerOnly, poolRef = pool, queryFn = query, queryOneFn = queryOne } = {}) {
  const router = Router();

  // GET /global — ANTES de qualquer rota com :id, pra nao ser interpretada
  // como um id (aqui nao ha GET /:id, mas mantido por clareza/seguranca).
  router.get('/global', requireFinanceOwner, wrap(async (req, res) => {
    const { entidade, data_inicio, data_fim, empresa_id } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const where = ['fl.`restaurado_em` IS NULL', 'fl.`purgado_em` IS NULL'];
    const params = [];
    if (empresa_id) { where.push('fl.`empresa_id` = ?'); params.push(empresa_id); }
    if (entidade)   { where.push('fl.`entidade` = ?');   params.push(entidade); }
    const dataInicio = parseDataFiltro(data_inicio);
    const dataFim = parseDataFiltro(data_fim);
    if (dataInicio) { where.push('fl.`excluido_em` >= ?'); params.push(`${dataInicio} 00:00:00`); }
    if (dataFim)    { where.push('fl.`excluido_em` <= ?'); params.push(`${dataFim} 23:59:59`); }

    const rows = await queryFn(
      `SELECT fl.*, e.\`nome\` AS empresa_nome
         FROM \`FinLixeira\` fl
         LEFT JOIN \`Empresa\` e ON e.\`id\` = fl.\`empresa_id\`
        WHERE ${where.join(' AND ')}
        ORDER BY fl.\`excluido_em\` DESC, fl.\`id\` DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const totalRow = await queryOneFn(
      `SELECT COUNT(*) AS total FROM \`FinLixeira\` fl WHERE ${where.join(' AND ')}`,
      params
    );
    res.json({ itens: decRows(rows, ENC), total: Number(totalRow?.total || 0) });
  }));

  // GET / — itens do ambiente ativo da sessao (empresa_id + escopo resolvidos
  // como em qualquer outra rota Finance).
  router.get('/', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const escopo = resolveFinanceEscopo(req);
    const { entidade, data_inicio, data_fim } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const where = ['`empresa_id` = ?', '`escopo` = ?', '`restaurado_em` IS NULL', '`purgado_em` IS NULL'];
    const params = [empresaId, escopo];
    if (entidade) { where.push('`entidade` = ?'); params.push(entidade); }
    const dataInicio = parseDataFiltro(data_inicio);
    const dataFim = parseDataFiltro(data_fim);
    if (dataInicio) { where.push('`excluido_em` >= ?'); params.push(`${dataInicio} 00:00:00`); }
    if (dataFim)    { where.push('`excluido_em` <= ?'); params.push(`${dataFim} 23:59:59`); }

    const rows = await queryFn(
      `SELECT * FROM \`FinLixeira\`
        WHERE ${where.join(' AND ')}
        ORDER BY \`excluido_em\` DESC, \`id\` DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const totalRow = await queryOneFn(
      `SELECT COUNT(*) AS total FROM \`FinLixeira\` WHERE ${where.join(' AND ')}`,
      params
    );
    res.json({ itens: decRows(rows, ENC), total: Number(totalRow?.total || 0) });
  }));

  // POST /:id/restaurar — o item precisa pertencer ao ambiente ativo da
  // sessao, a menos que o chamador seja o dono (que restaura de qualquer
  // empresa/escopo). requireFinanceWriteAccess (montado globalmente antes
  // deste router) ja barrou POST vindo de sessao delegada 'visualizar'.
  router.post('/:id/restaurar', wrap(async (req, res) => {
    const item = await queryOneFn('SELECT * FROM `FinLixeira` WHERE `id` = ? LIMIT 1', [req.params.id]);
    if (!item) throw ERR.NOT_FOUND('Item da lixeira nao encontrado.');
    if (!req.financeUser?.is_owner) {
      const empresaId = resolveFinanceEmpresa(req);
      const escopo = resolveFinanceEscopo(req);
      if (item.empresa_id !== empresaId || (item.escopo && item.escopo !== escopo)) {
        throw ERR.FORBIDDEN('Item nao pertence ao ambiente ativo.');
      }
    }

    const conn = await poolRef.getConnection();
    let resultado;
    try {
      await conn.beginTransaction();
      resultado = await restaurarGrupo(conn, item.grupo_id, req);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ ok: true, ...resultado });
  }));

  // DELETE /:id — purga definitiva. So o dono. Nao apaga o registro (mantem
  // rastro de auditoria), so o snapshot (o dado sensivel em si).
  router.delete('/:id', requireFinanceOwner, wrap(async (req, res) => {
    const r = await queryFn(
      "UPDATE `FinLixeira` SET `purgado_em` = NOW(3), `snapshot` = NULL WHERE `id` = ? AND `purgado_em` IS NULL",
      [req.params.id]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Item da lixeira nao encontrado ou ja purgado.');
    res.json({ ok: true });
  }));

  return router;
}
