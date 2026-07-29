// ============================================================================
// routes/dividas.js — Dívidas pessoais + eventos
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne } from '../db.js';
import { wrap, requireFields, parseDecimal, parseDate, enumOr, capText, resolveFinanceEmpresa, resolveFinanceEscopo } from './_common.js';
import { ERR } from '../security/errors.js';
import { encryptField, decRows } from '../security/encryption.js';
import { novoGrupo, registrarExclusao, snapshotLinha } from './_lixeira.js';

const TIPOS   = ['cartao_credito', 'emprestimo', 'financiamento', 'cheque_especial', 'outro'];
const STATUS  = ['ativa', 'em_negociacao', 'renegociada', 'quitada'];
const EVENTOS = ['pagamento', 'renegociacao', 'nota', 'juros_aplicados'];
// Campos cifrados em repouso (enc:v1:...) — decifrar em toda leitura.
const ENC = ['credor', 'descricao'];

export function buildDividasRouter() {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const escopo = resolveFinanceEscopo(req);
    const { status, tipo } = req.query;
    const where = ['`empresa_id` = ?', '`escopo` = ?'];
    const params = [empresaId, escopo];
    if (status) { where.push('`status` = ?'); params.push(status); }
    if (tipo)   { where.push('`tipo` = ?');   params.push(tipo); }

    const dividas = await query(
      `SELECT \`id\`, \`credor\`, \`tipo\`, \`valor_original\`, \`saldo_devedor\`, \`data_inicio\`,
              \`data_vencimento\`, \`taxa_juros\`, \`status\`, \`descricao\`
         FROM \`FinDividaPessoal\`
        WHERE ${where.join(' AND ')}
        ORDER BY \`status\`, \`data_vencimento\` ASC`,
      params
    );

    const tot1 = await queryOne(
      `SELECT COALESCE(SUM(\`saldo_devedor\`), 0) AS t
         FROM \`FinDividaPessoal\` WHERE \`empresa_id\` = ? AND \`escopo\` = ? AND \`status\` = 'ativa'`,
      [empresaId, escopo]
    );
    const tot2 = await queryOne(
      `SELECT COALESCE(SUM(\`saldo_devedor\`), 0) AS t
         FROM \`FinDividaPessoal\` WHERE \`empresa_id\` = ? AND \`escopo\` = ? AND \`status\` = 'em_negociacao'`,
      [empresaId, escopo]
    );
    res.json({
      dividas: decRows(dividas, ENC),
      total_dividas_ativas: Number(tot1?.t || 0),
      total_em_negociacao: Number(tot2?.t || 0)
    });
  }));

  router.post('/', wrap(async (req, res) => {
    const valorOriginalInput = req.body.valor_original ?? req.body.saldo_devedor;
    const dataInicioInput = req.body.data_inicio ?? req.body.data;
    requireFields({ ...req.body, valor_original: valorOriginalInput, data_inicio: dataInicioInput }, ['credor', 'tipo', 'valor_original', 'data_inicio']);
    const empresaId = resolveFinanceEmpresa(req);
    const escopo = resolveFinanceEscopo(req);
    const tipo = enumOr(req.body.tipo, TIPOS, 'tipo');
    const valor_original = parseDecimal(valorOriginalInput);
    const saldo_devedor = req.body.saldo_devedor != null
      ? parseDecimal(req.body.saldo_devedor, { allowZero: true })
      : valor_original;
    const data_inicio = parseDate(dataInicioInput);
    const data_vencimento = req.body.data_vencimento ? parseDate(req.body.data_vencimento) : null;
    const taxa_juros = req.body.taxa_juros != null ? Number(req.body.taxa_juros) : null;
    const credor = capText(req.body.credor, 150, 'credor');
    if (!credor) throw ERR.VALIDATION('credor obrigatorio.'); // "  " passa no requireFields
    const descricao = capText(req.body.descricao, 255, 'descricao');

    const id = randomUUID();
    await query(
      `INSERT INTO \`FinDividaPessoal\`
         (\`id\`, \`empresa_id\`, \`escopo\`, \`credor\`, \`tipo\`, \`valor_original\`, \`saldo_devedor\`,
          \`data_inicio\`, \`data_vencimento\`, \`taxa_juros\`, \`descricao\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, empresaId, escopo, encryptField(credor), tipo, valor_original, saldo_devedor,
       data_inicio, data_vencimento, taxa_juros, encryptField(descricao)]
    );
    res.status(201).json({ id });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const divida = await queryOne(
      'SELECT `status` FROM `FinDividaPessoal` WHERE `id` = ? AND `empresa_id` = ?',
      [req.params.id, empresaId]
    );
    if (!divida) throw ERR.NOT_FOUND('Divida nao encontrada.');
    if (divida.status === 'quitada') throw ERR.CONFLICT('Divida quitada nao pode ser editada.');
    if (req.body.tipo) enumOr(req.body.tipo, TIPOS, 'tipo');

    await query(
      `UPDATE \`FinDividaPessoal\`
          SET \`credor\`          = COALESCE(?, \`credor\`),
              \`tipo\`            = COALESCE(?, \`tipo\`),
              \`valor_original\`  = COALESCE(?, \`valor_original\`),
              \`saldo_devedor\`   = COALESCE(?, \`saldo_devedor\`),
              \`data_inicio\`     = COALESCE(?, \`data_inicio\`),
              \`data_vencimento\` = COALESCE(?, \`data_vencimento\`),
              \`taxa_juros\`      = COALESCE(?, \`taxa_juros\`),
              \`descricao\`       = COALESCE(?, \`descricao\`),
              \`updatedAt\`       = NOW(3)
        WHERE \`id\` = ? AND \`empresa_id\` = ?`,
      [
        // COALESCE preserva o valor do banco quando o body não envia o campo;
        // quando envia, cap + cifra antes de gravar.
        encryptField(capText(req.body.credor, 150, 'credor')), req.body.tipo ?? null,
        req.body.valor_original ?? null, req.body.saldo_devedor ?? null,
        req.body.data_inicio ?? null, req.body.data_vencimento ?? null,
        req.body.taxa_juros ?? null, encryptField(capText(req.body.descricao, 255, 'descricao')),
        req.params.id, empresaId
      ]
    );
    res.json({ ok: true });
  }));

  router.patch('/:id/status', wrap(async (req, res) => {
    requireFields(req.body, ['status']);
    const empresaId = resolveFinanceEmpresa(req);
    const status = enumOr(req.body.status, STATUS, 'status');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [ur] = await conn.execute(
        'UPDATE `FinDividaPessoal` SET `status` = ?, `updatedAt` = NOW(3) WHERE `id` = ? AND `empresa_id` = ?',
        [status, req.params.id, empresaId]
      );
      if (!ur.affectedRows) throw ERR.NOT_FOUND('Divida nao encontrada.');
      const tipoEvento = status === 'renegociada' ? 'renegociacao' : 'nota';
      await conn.execute(
        `INSERT INTO \`FinDividaEvento\` (\`id\`, \`divida_id\`, \`empresa_id\`, \`data\`, \`tipo\`, \`descricao\`)
         VALUES (?, ?, ?, CURDATE(), ?, ?)`,
        [randomUUID(), req.params.id, empresaId, tipoEvento,
         encryptField(capText(req.body.nota, 500, 'nota') || `Status alterado para ${status}`)]
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ ok: true });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const ev = await queryOne(
      'SELECT COUNT(*) AS c FROM `FinDividaEvento` WHERE `divida_id` = ? AND `empresa_id` = ?',
      [req.params.id, empresaId]
    );
    if ((ev?.c || 0) > 0) throw ERR.CONFLICT('Divida tem eventos. Preserve o historico.');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const snapshot = await snapshotLinha(conn, 'FinDividaPessoal', req.params.id, empresaId);
      if (!snapshot) throw ERR.NOT_FOUND('Divida nao encontrada.');
      const [r] = await conn.execute(
        'DELETE FROM `FinDividaPessoal` WHERE `id` = ? AND `empresa_id` = ?',
        [req.params.id, empresaId]
      );
      if (!r.affectedRows) throw ERR.NOT_FOUND('Divida nao encontrada.');
      await registrarExclusao(conn, {
        grupoId: novoGrupo(), entidade: 'divida', entidadeId: req.params.id,
        empresaId, escopo: snapshot.escopo, estrategia: 'snapshot', snapshot,
        rotulo: 'Divida excluida', valor: snapshot.saldo_devedor, req
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

  router.get('/:id/eventos', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const eventos = await query(
      `SELECT \`id\`, \`data\`, \`tipo\`, \`valor\`, \`descricao\`, \`createdAt\`
         FROM \`FinDividaEvento\`
        WHERE \`divida_id\` = ? AND \`empresa_id\` = ?
        ORDER BY \`data\` DESC, \`id\` DESC`,
      [req.params.id, empresaId]
    );
    res.json(decRows(eventos, ['descricao']));
  }));

  router.post('/:id/eventos', wrap(async (req, res) => {
    requireFields(req.body, ['data', 'tipo']);
    const empresaId = resolveFinanceEmpresa(req);
    const tipo = enumOr(req.body.tipo, EVENTOS, 'tipo');
    const data = parseDate(req.body.data);
    const valor = req.body.valor != null ? parseDecimal(req.body.valor, { allowZero: true }) : null;
    if (['pagamento', 'juros_aplicados'].includes(tipo) && valor == null) {
      throw ERR.VALIDATION('Valor obrigatorio para este tipo de evento.');
    }

    const eventoId = randomUUID();
    const conn = await pool.getConnection();
    let saldoNovo;
    try {
      await conn.beginTransaction();
      const [dRows] = await conn.execute(
        'SELECT `saldo_devedor` FROM `FinDividaPessoal` WHERE `id` = ? AND `empresa_id` = ?',
        [req.params.id, empresaId]
      );
      const divida = dRows[0];
      if (!divida) throw ERR.NOT_FOUND('Divida nao encontrada.');

      saldoNovo = Number(divida.saldo_devedor);
      if (tipo === 'pagamento') {
        if (valor > saldoNovo) throw ERR.VALIDATION('Pagamento maior que saldo devedor.');
        saldoNovo -= valor;
      } else if (tipo === 'juros_aplicados') {
        saldoNovo += valor;
      }

      await conn.execute(
        `INSERT INTO \`FinDividaEvento\` (\`id\`, \`divida_id\`, \`empresa_id\`, \`data\`, \`tipo\`, \`valor\`, \`descricao\`)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [eventoId, req.params.id, empresaId, data, tipo, valor,
         encryptField(capText(req.body.descricao, 500, 'descricao'))]
      );
      if (saldoNovo !== Number(divida.saldo_devedor)) {
        await conn.execute(
          'UPDATE `FinDividaPessoal` SET `saldo_devedor` = ?, `updatedAt` = NOW(3) WHERE `id` = ?',
          [saldoNovo, req.params.id]
        );
        if (saldoNovo === 0 && tipo === 'pagamento') {
          await conn.execute(
            "UPDATE `FinDividaPessoal` SET `status` = 'quitada' WHERE `id` = ?",
            [req.params.id]
          );
        }
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.status(201).json({ id: eventoId, saldo_devedor_novo: saldoNovo.toFixed(2) });
  }));

  return router;
}
