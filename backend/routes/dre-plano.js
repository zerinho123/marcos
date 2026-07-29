// ============================================================================
// routes/dre-plano.js — Plano de receita (DRE Plano vs Real)
// ============================================================================

import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { wrap, requireFields, parseDecimal, parseMonth, resolveFinanceEmpresa } from './_common.js';

export function buildDrePlanoRouter() {
  const router = Router();

  router.get('/plano', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const mes = parseMonth(req.query.mes);
    const row = await queryOne(
      'SELECT `valor` FROM `FinDrePlanoReceita` WHERE `empresa_id` = ? AND `mes` = ?',
      [empresaId, mes]
    );
    res.json({ mes: mes.slice(0, 7), valor: row?.valor || '0.00' });
  }));

  router.put('/plano', wrap(async (req, res) => {
    requireFields(req.body, ['mes', 'valor']);
    const empresaId = resolveFinanceEmpresa(req);
    const mes = parseMonth(req.body.mes);
    const valor = parseDecimal(req.body.valor, { allowZero: true });
    await query(
      `INSERT INTO \`FinDrePlanoReceita\` (\`empresa_id\`, \`mes\`, \`valor\`)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE \`valor\` = VALUES(\`valor\`), \`updatedAt\` = NOW(3)`,
      [empresaId, mes, valor]
    );
    res.json({ mes: mes.slice(0, 7), valor: valor.toFixed(2) });
  }));

  router.get('/plano/anual', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const ano = Number(req.query.ano) || new Date().getFullYear();
    const rows = await query(
      `SELECT \`mes\`, \`valor\` FROM \`FinDrePlanoReceita\`
        WHERE \`empresa_id\` = ? AND YEAR(\`mes\`) = ?
        ORDER BY \`mes\``,
      [empresaId, ano]
    );
    res.json(rows);
  }));

  return router;
}
