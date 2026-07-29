// ============================================================================
// routes/orcamentos.js — Orçamentos mensais por categoria
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne } from '../db.js';
import { wrap, requireFields, parseDecimal, parseDate, parseMonth, resolveFinanceEmpresa, resolveFinanceEscopo } from './_common.js';
import { ERR } from '../security/errors.js';
import { novoGrupo, registrarExclusao, snapshotLinha } from './_lixeira.js';

// Dono do workspace Pessoal ativo — ver nota identica em routes/categorias.js.
function personalUserId(req) {
  return String(req.financeUser?.pessoal_owner_id || req.financeUser?.id || '');
}

function shape(row, escopo) {
  const limite = Number(row.limite || 0);
  const usado = Number(row.gasto_atual || 0);
  return {
    ...row,
    escopo,
    usado,
    percentual: limite > 0 ? Math.round((usado / limite) * 100) : 0,
    restante: Math.max(0, limite - usado),
    estourado: usado > limite
  };
}

function monthRange(mes) {
  const [y, m] = String(mes).slice(0, 7).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    inicio: `${y}-${String(m).padStart(2, '0')}-01`,
    fim: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  };
}

function parsePeriodo(body, mes) {
  const def = monthRange(mes);
  const inicio = body.data_inicio ? parseDate(body.data_inicio) : def.inicio;
  const fim = body.data_fim ? parseDate(body.data_fim) : def.fim;
  if (fim < inicio) throw ERR.VALIDATION('Data final deve ser maior ou igual a data inicial.');
  return { inicio, fim };
}

export function buildOrcamentosRouter({ poolRef = pool, queryFn = query, queryOneFn = queryOne } = {}) {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const escopo = resolveFinanceEscopo(req);
    const mes = parseMonth(req.query.mes);

    if (escopo === 'pessoal') {
      const rows = await queryFn(
        `SELECT o.\`id\`, o.\`mes\`, o.\`limite\`,
                COALESCE(o.\`data_inicio\`, o.\`mes\`) AS data_inicio,
                COALESCE(o.\`data_fim\`, LAST_DAY(o.\`mes\`)) AS data_fim,
                cp.\`id\` AS categoria_id, cp.\`nome\` AS categoria_nome,
                COALESCE((
                  SELECT SUM(t.\`valor\`)
                    FROM \`FinTransacao\` t
                    JOIN \`FinContaBancaria\` cb
                      ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
                   WHERE t.\`empresa_id\` = o.\`empresa_id\`
                     AND t.\`escopo\` = 'pessoal'
                     AND t.\`categoria_pessoal_id\` = o.\`categoria_pessoal_id\`
                     AND t.\`tipo\` = 'despesa'
                     AND t.\`ativo\` = 1
                     AND cb.\`ativo\` = 1
                     AND t.\`data\` >= COALESCE(o.\`data_inicio\`, o.\`mes\`)
                     AND t.\`data\` <= COALESCE(o.\`data_fim\`, LAST_DAY(o.\`mes\`))
                ), 0) AS gasto_atual
           FROM \`FinOrcamento\` o
           JOIN \`FinCategoriaPessoal\` cp
             ON cp.\`id\` = o.\`categoria_pessoal_id\`
            AND cp.\`empresa_id\` = o.\`empresa_id\`
          WHERE o.\`empresa_id\` = ?
            AND o.\`escopo\` = 'pessoal'
            AND o.\`mes\` = ?
            AND cp.\`user_id\` = ?
          ORDER BY cp.\`nome\``,
        [empresaId, mes, personalUserId(req)]
      );
      res.json((rows || []).map((o) => shape(o, escopo)));
      return;
    }

    const rows = await queryFn(
      `SELECT o.\`id\`, o.\`mes\`, o.\`limite\`,
              COALESCE(o.\`data_inicio\`, o.\`mes\`) AS data_inicio,
              COALESCE(o.\`data_fim\`, LAST_DAY(o.\`mes\`)) AS data_fim,
              c.\`id\` AS categoria_id, c.\`nome\` AS categoria_nome,
              COALESCE((
                SELECT SUM(t.\`valor\`)
                  FROM \`FinTransacao\` t
                  JOIN \`FinContaBancaria\` cb
                    ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
                 WHERE t.\`empresa_id\`   = o.\`empresa_id\`
                   AND t.\`escopo\`       = 'empresarial'
                   AND t.\`categoria_id\` = o.\`categoria_id\`
                   AND t.\`tipo\`         = 'despesa'
                   AND t.\`ativo\`        = 1
                   AND cb.\`ativo\`       = 1
                   AND t.\`data\`         >= COALESCE(o.\`data_inicio\`, o.\`mes\`)
                   AND t.\`data\`         <= COALESCE(o.\`data_fim\`, LAST_DAY(o.\`mes\`))
              ), 0) AS gasto_atual
         FROM \`FinOrcamento\` o
         JOIN \`FinCategoria\` c ON c.\`id\` = o.\`categoria_id\`
        WHERE o.\`empresa_id\` = ? AND o.\`escopo\` = 'empresarial' AND o.\`mes\` = ?
        ORDER BY c.\`nome\``,
      [empresaId, mes]
    );
    res.json((rows || []).map((o) => shape(o, escopo)));
  }));

  router.post('/', wrap(async (req, res) => {
    requireFields(req.body, ['categoria_id', 'mes', 'limite']);
    const empresaId = resolveFinanceEmpresa(req);
    const escopo = resolveFinanceEscopo(req);
    const mes = parseMonth(req.body.mes);
    const limite = parseDecimal(req.body.limite);
    const periodo = parsePeriodo(req.body, mes);

    const catId = String(req.body.categoria_id || '').trim();
    const cat = escopo === 'pessoal'
      ? await queryOneFn(
          'SELECT `id` FROM `FinCategoriaPessoal` WHERE `id` = ? AND `empresa_id` = ? AND `user_id` = ? AND `ativo` = 1 AND (`natureza` = "despesa" OR `natureza` IS NULL) LIMIT 1',
          [catId, empresaId, personalUserId(req)]
        )
      : await queryOneFn(
          'SELECT `id` FROM `FinCategoria` WHERE `id` = ? AND `empresa_id` = ? AND `escopo` = "empresarial" AND `ativo` = 1 AND (`natureza` = "despesa" OR `natureza` IS NULL) LIMIT 1',
          [catId, empresaId]
        );
    if (!cat) throw ERR.VALIDATION('Categoria de despesa invalida.');

    const dupe = escopo === 'pessoal'
      ? await queryOneFn(
          'SELECT `id` FROM `FinOrcamento` WHERE `empresa_id` = ? AND `escopo` = "pessoal" AND `categoria_pessoal_id` = ? AND `mes` = ?',
          [empresaId, catId, mes]
        )
      : await queryOneFn(
          'SELECT `id` FROM `FinOrcamento` WHERE `empresa_id` = ? AND `escopo` = "empresarial" AND `categoria_id` = ? AND `mes` = ?',
          [empresaId, catId, mes]
        );
    if (dupe) throw ERR.CONFLICT('Ja existe orcamento para essa categoria/mes.');

    const id = randomUUID();
    if (escopo === 'pessoal') {
      await queryFn(
        `INSERT INTO \`FinOrcamento\` (\`id\`, \`empresa_id\`, \`categoria_id\`, \`categoria_pessoal_id\`, \`escopo\`, \`mes\`, \`data_inicio\`, \`data_fim\`, \`limite\`)
         VALUES (?, ?, NULL, ?, 'pessoal', ?, ?, ?, ?)`,
        [id, empresaId, catId, mes, periodo.inicio, periodo.fim, limite]
      );
    } else {
      await queryFn(
        `INSERT INTO \`FinOrcamento\` (\`id\`, \`empresa_id\`, \`categoria_id\`, \`categoria_pessoal_id\`, \`escopo\`, \`mes\`, \`data_inicio\`, \`data_fim\`, \`limite\`)
         VALUES (?, ?, ?, NULL, 'empresarial', ?, ?, ?, ?)`,
        [id, empresaId, catId, mes, periodo.inicio, periodo.fim, limite]
      );
    }
    res.status(201).json({ id });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const escopo = resolveFinanceEscopo(req);
    const limite = parseDecimal(req.body.limite);
    const mes = req.body.mes ? parseMonth(req.body.mes) : null;
    const periodo = (req.body.data_inicio || req.body.data_fim)
      ? parsePeriodo(req.body, mes || `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}-01`)
      : null;
    const r = await queryFn(
      `UPDATE \`FinOrcamento\`
          SET \`limite\` = ?,
              \`data_inicio\` = COALESCE(?, \`data_inicio\`),
              \`data_fim\` = COALESCE(?, \`data_fim\`),
              \`updatedAt\` = NOW(3)
        WHERE \`id\` = ? AND \`empresa_id\` = ? AND \`escopo\` = ?`,
      [limite, periodo?.inicio ?? null, periodo?.fim ?? null, req.params.id, empresaId, escopo]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Orcamento nao encontrado.');
    res.json({ ok: true });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const escopo = resolveFinanceEscopo(req);
    const conn = await poolRef.getConnection();
    try {
      await conn.beginTransaction();
      const snapshot = await snapshotLinha(conn, 'FinOrcamento', req.params.id, empresaId);
      if (!snapshot || snapshot.escopo !== escopo) throw ERR.NOT_FOUND('Orcamento nao encontrado.');
      const [r] = await conn.execute(
        'DELETE FROM `FinOrcamento` WHERE `id` = ? AND `empresa_id` = ? AND `escopo` = ?',
        [req.params.id, empresaId, escopo]
      );
      if (!r.affectedRows) throw ERR.NOT_FOUND('Orcamento nao encontrado.');
      await registrarExclusao(conn, {
        grupoId: novoGrupo(), entidade: 'orcamento', entidadeId: req.params.id,
        empresaId, escopo, estrategia: 'snapshot', snapshot,
        rotulo: `Orcamento ${snapshot.mes}`, valor: snapshot.limite, req
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
