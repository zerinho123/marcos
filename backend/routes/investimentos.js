// ============================================================================
// routes/investimentos.js — Investimentos + aportes
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne } from '../db.js';
import { wrap, requireFields, parseDecimal, parseDate, enumOr, resolveFinanceEmpresa } from './_common.js';
import { ERR } from '../security/errors.js';
import { novoGrupo, registrarExclusao, snapshotLinha } from './_lixeira.js';

const TIPOS = ['renda_fixa', 'acao', 'fii', 'cripto', 'outro'];
const APORTE_TIPOS = ['compra', 'venda'];

export function buildInvestimentosRouter() {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const rows = await query(
      `SELECT i.\`id\`, i.\`nome\`, i.\`ticker\`, i.\`tipo\`, i.\`corretora\`,
              i.\`valor_atual_manual\`, i.\`ativo\`,
              COALESCE(SUM(CASE WHEN a.\`tipo\`='compra' THEN a.\`total\` ELSE -a.\`total\` END), 0) AS total_investido,
              COALESCE(SUM(CASE WHEN a.\`tipo\`='compra' THEN a.\`quantidade\` ELSE -a.\`quantidade\` END), 0) AS quantidade_total,
              ic.\`valor_atual\` AS cotacao_atual
         FROM \`FinInvestimento\` i
         LEFT JOIN \`FinAporteInvestimento\` a   ON a.\`investimento_id\` = i.\`id\`
         LEFT JOIN \`FinInvestimentoCotacao\` ic ON ic.\`ticker\` = i.\`ticker\`
        WHERE i.\`empresa_id\` = ?
        GROUP BY i.\`id\`, ic.\`valor_atual\`
        ORDER BY i.\`tipo\`, i.\`nome\``,
      [empresaId]
    );
    for (const i of rows) {
      const totalInvestido = Number(i.total_investido);
      const qtd = Number(i.quantidade_total);
      i.preco_medio = qtd > 0 ? (totalInvestido / qtd).toFixed(6) : '0.000000';
    }
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    requireFields(req.body, ['nome', 'tipo']);
    const empresaId = resolveFinanceEmpresa(req);
    const tipo = enumOr(req.body.tipo, TIPOS, 'tipo');
    const { nome, ticker = null, corretora = null, valor_atual_manual = null } = req.body;
    const id = randomUUID();
    await query(
      `INSERT INTO \`FinInvestimento\`
         (\`id\`, \`empresa_id\`, \`nome\`, \`ticker\`, \`tipo\`, \`corretora\`, \`valor_atual_manual\`)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, empresaId, nome, ticker, tipo, corretora, valor_atual_manual]
    );
    res.status(201).json({ id });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    if (req.body.tipo) enumOr(req.body.tipo, TIPOS, 'tipo');
    const r = await query(
      `UPDATE \`FinInvestimento\`
          SET \`nome\`               = COALESCE(?, \`nome\`),
              \`ticker\`             = COALESCE(?, \`ticker\`),
              \`tipo\`               = COALESCE(?, \`tipo\`),
              \`corretora\`          = COALESCE(?, \`corretora\`),
              \`valor_atual_manual\` = COALESCE(?, \`valor_atual_manual\`),
              \`ativo\`              = COALESCE(?, \`ativo\`),
              \`updatedAt\`          = NOW(3)
        WHERE \`id\` = ? AND \`empresa_id\` = ?`,
      [
        req.body.nome ?? null, req.body.ticker ?? null, req.body.tipo ?? null,
        req.body.corretora ?? null, req.body.valor_atual_manual ?? null,
        req.body.ativo == null ? null : (req.body.ativo ? 1 : 0),
        req.params.id, empresaId
      ]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Investimento nao encontrado.');
    res.json({ ok: true });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT `nome` FROM `FinInvestimento` WHERE `id` = ? AND `empresa_id` = ? FOR UPDATE',
        [req.params.id, empresaId]
      );
      const inv = rows[0];
      if (!inv) throw ERR.NOT_FOUND('Investimento nao encontrado.');
      const [r] = await conn.execute(
        'UPDATE `FinInvestimento` SET `ativo` = 0, `updatedAt` = NOW(3) WHERE `id` = ? AND `empresa_id` = ?',
        [req.params.id, empresaId]
      );
      if (!r.affectedRows) throw ERR.NOT_FOUND('Investimento nao encontrado.');
      await registrarExclusao(conn, {
        grupoId: novoGrupo(), entidade: 'investimento', entidadeId: req.params.id,
        empresaId, estrategia: 'flag', rotulo: inv.nome || null, req
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

  router.get('/:id/aportes', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const rows = await query(
      `SELECT \`id\`, \`data\`, \`tipo\`, \`quantidade\`, \`preco_unitario\`, \`total\`
         FROM \`FinAporteInvestimento\`
        WHERE \`investimento_id\` = ? AND \`empresa_id\` = ?
        ORDER BY \`data\` DESC, \`id\` DESC`,
      [req.params.id, empresaId]
    );
    res.json(rows);
  }));

  router.post('/:id/aportes', wrap(async (req, res) => {
    requireFields(req.body, ['data', 'tipo', 'quantidade', 'preco_unitario']);
    const empresaId = resolveFinanceEmpresa(req);
    const tipo = enumOr(req.body.tipo, APORTE_TIPOS, 'tipo');
    const quantidade = parseDecimal(req.body.quantidade);
    const preco = parseDecimal(req.body.preco_unitario);
    const data = parseDate(req.body.data);

    const id = randomUUID();
    const conn = await pool.getConnection();
    let precoMedio;
    try {
      await conn.beginTransaction();
      const [iRows] = await conn.execute(
        'SELECT `id` FROM `FinInvestimento` WHERE `id` = ? AND `empresa_id` = ?',
        [req.params.id, empresaId]
      );
      if (!iRows[0]) throw ERR.NOT_FOUND('Investimento nao encontrado.');

      if (tipo === 'venda') {
        const [qRows] = await conn.execute(
          `SELECT COALESCE(SUM(CASE WHEN \`tipo\`='compra' THEN \`quantidade\` ELSE -\`quantidade\` END), 0) AS qtd
             FROM \`FinAporteInvestimento\` WHERE \`investimento_id\` = ?`,
          [req.params.id]
        );
        if (Number(qRows[0]?.qtd || 0) < quantidade) throw ERR.VALIDATION('Venda excede posicao atual.');
      }

      await conn.execute(
        `INSERT INTO \`FinAporteInvestimento\`
           (\`id\`, \`investimento_id\`, \`empresa_id\`, \`data\`, \`tipo\`, \`quantidade\`, \`preco_unitario\`)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, req.params.id, empresaId, data, tipo, quantidade, preco]
      );

      const [aRows] = await conn.execute(
        `SELECT COALESCE(SUM(\`quantidade\`), 0) AS qtd_compras,
                COALESCE(SUM(\`total\`), 0) AS total_compras
           FROM \`FinAporteInvestimento\`
          WHERE \`investimento_id\` = ? AND \`tipo\` = 'compra'`,
        [req.params.id]
      );
      const qtdCompras = Number(aRows[0]?.qtd_compras || 0);
      const totalCompras = Number(aRows[0]?.total_compras || 0);
      precoMedio = qtdCompras > 0 ? (totalCompras / qtdCompras).toFixed(6) : '0.000000';
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.status(201).json({ id, preco_medio_novo: precoMedio });
  }));

  router.delete('/:id/aportes/:aporteId', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const snapshot = await snapshotLinha(conn, 'FinAporteInvestimento', req.params.aporteId, empresaId);
      if (!snapshot || snapshot.investimento_id !== req.params.id) {
        throw ERR.NOT_FOUND('Aporte nao encontrado.');
      }
      const [r] = await conn.execute(
        `DELETE FROM \`FinAporteInvestimento\`
          WHERE \`id\` = ? AND \`investimento_id\` = ? AND \`empresa_id\` = ?`,
        [req.params.aporteId, req.params.id, empresaId]
      );
      if (!r.affectedRows) throw ERR.NOT_FOUND('Aporte nao encontrado.');
      await registrarExclusao(conn, {
        grupoId: novoGrupo(), entidade: 'aporte', entidadeId: req.params.aporteId,
        empresaId, estrategia: 'snapshot', snapshot,
        rotulo: `Aporte ${snapshot.tipo} — ${snapshot.data}`, valor: snapshot.total, req
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
