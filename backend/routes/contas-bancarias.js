// ============================================================================
// routes/contas-bancarias.js — CRUD de FinContaBancaria
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne } from '../db.js';
import { wrap, requireFields, enumOr, resolveFinanceEmpresa, resolveFinanceEscopo, parseDecimal } from './_common.js';
import { ERR } from '../security/errors.js';
import { MOEDAS_SUPORTADAS, isMoedaSuportada } from '../security/cambio.js';
import { novoGrupo, registrarExclusao } from './_lixeira.js';

const TIPOS = ['corrente', 'poupanca', 'carteira', 'investimento', 'outro'];
const ESCOPOS = ['pessoal', 'empresarial'];

// Normaliza/valida a moeda da conta (ISO 4217, whitelist do frankfurter).
// Ausente → default 'BRL'. Inválida → 400.
function parseMoeda(value, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw ERR.VALIDATION('Moeda obrigatoria.');
    return 'BRL';
  }
  const m = String(value).trim().toUpperCase();
  if (!isMoedaSuportada(m)) {
    throw ERR.VALIDATION(`Moeda invalida. Valores aceitos: ${MOEDAS_SUPORTADAS.join(', ')}`);
  }
  return m;
}

export function buildContasBancariasRouter({ poolRef = pool, queryFn = query, queryOneFn = queryOne } = {}) {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    // Isolamento total Pessoal x Empresarial: só as contas do escopo ativo.
    const escopo = resolveFinanceEscopo(req);
    const where = ['`empresa_id` = ?', '`escopo` = ?'];
    const params = [empresaId, escopo];
    // Contas excluidas sao soft-delete (ativo=0). A listagem esconde inativas por
    // padrao; passe ?incluir_inativas=1 pra um relatorio/auditoria que precise delas.
    if (!['1', 'true'].includes(String(req.query.incluir_inativas || '').toLowerCase())) {
      where.push('`ativo` = 1');
    }
    const whereCb = where.map((w) => `cb.${w}`).join(' AND ');
    const rows = await queryFn(
      `SELECT cb.\`id\`, cb.\`nome\`, cb.\`tipo\`, cb.\`escopo\`, cb.\`moeda\`, cb.\`saldo\`, cb.\`cor\`, cb.\`ativo\`,
              (SELECT COUNT(*) FROM \`FinTransacao\` t
                WHERE t.\`conta_bancaria_id\` = cb.\`id\` AND t.\`empresa_id\` = cb.\`empresa_id\` AND t.\`ativo\` = 1
              ) AS lancamentos_count
         FROM \`FinContaBancaria\` cb
        WHERE ${whereCb}
        ORDER BY cb.\`ativo\` DESC, cb.\`nome\``,
      params
    );
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    requireFields(req.body, ['nome']);
    const empresaId = resolveFinanceEmpresa(req);
    const tipo = enumOr(req.body.tipo || 'corrente', TIPOS, 'tipo');
    // Conta nasce no escopo do workspace ativo (não confiar em body solto).
    const escopo = resolveFinanceEscopo(req);
    // saldo_inicial e o nome canonico; aceitamos `saldo` por compatibilidade.
    const saldoRaw = req.body.saldo_inicial ?? req.body.saldo;
    const saldoInicial = saldoRaw != null
      ? parseDecimal(saldoRaw, { allowZero: true })
      : 0;
    const cor = req.body.cor || null;
    const moeda = parseMoeda(req.body.moeda);

    const id = randomUUID();
    await queryFn(
      `INSERT INTO \`FinContaBancaria\` (\`id\`, \`empresa_id\`, \`escopo\`, \`nome\`, \`tipo\`, \`moeda\`, \`saldo_inicial\`, \`saldo\`, \`cor\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, empresaId, escopo, req.body.nome, tipo, moeda, saldoInicial, saldoInicial, cor]
    );
    res.status(201).json({ id, moeda, saldo: saldoInicial.toFixed(2) });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    if (Object.hasOwn(req.body, 'saldo') || Object.hasOwn(req.body, 'saldo_inicial')) {
      throw ERR.VALIDATION('Saldo nao pode ser editado diretamente. Registre um lancamento de ajuste.');
    }
    if (req.body.tipo) enumOr(req.body.tipo, TIPOS, 'tipo');
    if (req.body.escopo) enumOr(req.body.escopo, ESCOPOS, 'escopo');
    // moeda só é validada/atualizada se enviada (COALESCE mantém a atual).
    const moeda = (req.body.moeda == null || req.body.moeda === '') ? null : parseMoeda(req.body.moeda);
    if (moeda || req.body.escopo) {
      const atual = await queryOneFn(
        `SELECT cb.\`moeda\`, cb.\`escopo\`,
                ((SELECT COUNT(*) FROM \`FinTransacao\` t WHERE t.\`conta_bancaria_id\` = cb.\`id\` AND t.\`empresa_id\` = cb.\`empresa_id\`) +
                 (SELECT COUNT(*) FROM \`FinContaPagar\` cp WHERE cp.\`conta_bancaria_id\` = cb.\`id\` AND cp.\`empresa_id\` = cb.\`empresa_id\`) +
                 (SELECT COUNT(*) FROM \`FinContaReceber\` cr WHERE cr.\`conta_bancaria_id\` = cb.\`id\` AND cr.\`empresa_id\` = cb.\`empresa_id\`)) AS vinculos_count
           FROM \`FinContaBancaria\` cb
          WHERE cb.\`id\` = ? AND cb.\`empresa_id\` = ? LIMIT 1`,
        [req.params.id, empresaId]
      );
      if (!atual) throw ERR.NOT_FOUND('Conta nao encontrada.');
      const mudaMoeda = moeda && moeda !== String(atual.moeda || 'BRL').toUpperCase();
      const mudaEscopo = req.body.escopo && req.body.escopo !== atual.escopo;
      if (Number(atual.vinculos_count || 0) > 0 && (mudaMoeda || mudaEscopo)) {
        throw ERR.VALIDATION('Moeda e ambiente nao podem mudar depois que a conta possui historico. Crie outra conta.');
      }
    }
    const r = await queryFn(
      `UPDATE \`FinContaBancaria\`
          SET \`nome\`   = COALESCE(?, \`nome\`),
              \`tipo\`   = COALESCE(?, \`tipo\`),
              \`escopo\` = COALESCE(?, \`escopo\`),
              \`moeda\`  = COALESCE(?, \`moeda\`),
              \`cor\`    = COALESCE(?, \`cor\`),
              \`ativo\`  = COALESCE(?, \`ativo\`),
              \`updatedAt\` = NOW(3)
        WHERE \`id\` = ? AND \`empresa_id\` = ?`,
      [
        req.body.nome ?? null, req.body.tipo ?? null, req.body.escopo ?? null,
        moeda,
        req.body.cor ?? null,
        req.body.ativo == null ? null : (req.body.ativo ? 1 : 0),
        req.params.id, empresaId
      ]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Conta nao encontrada.');
    res.json({ ok: true });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const conn = await poolRef.getConnection();
    let transacoesDesativadas = 0;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        `SELECT cb.\`saldo\`, cb.\`nome\`, cb.\`escopo\`,
                ((SELECT COUNT(*) FROM \`FinTransacao\` t WHERE t.\`conta_bancaria_id\` = cb.\`id\` AND t.\`empresa_id\` = cb.\`empresa_id\`) +
                 (SELECT COUNT(*) FROM \`FinContaPagar\` cp WHERE cp.\`conta_bancaria_id\` = cb.\`id\` AND cp.\`empresa_id\` = cb.\`empresa_id\`) +
                 (SELECT COUNT(*) FROM \`FinContaReceber\` cr WHERE cr.\`conta_bancaria_id\` = cb.\`id\` AND cr.\`empresa_id\` = cb.\`empresa_id\`)) AS vinculos_count
           FROM \`FinContaBancaria\` cb
          WHERE cb.\`id\` = ? AND cb.\`empresa_id\` = ? AND cb.\`ativo\` = 1 FOR UPDATE`,
        [req.params.id, empresaId]
      );
      const conta = rows[0];
      if (!conta) throw ERR.NOT_FOUND('Conta nao encontrada.');
      if (Number(conta.saldo) !== 0) {
        throw ERR.VALIDATION('Conta com saldo diferente de zero. Zere antes de excluir.');
      }
      if (Number(conta.vinculos_count || 0) > 0) {
        throw ERR.VALIDATION('Conta com historico nao pode ser excluida. Arquive a conta.');
      }

      const [contaResult] = await conn.execute(
        'UPDATE `FinContaBancaria` SET `ativo` = 0, `updatedAt` = NOW(3) WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1',
        [req.params.id, empresaId]
      );
      if (!contaResult.affectedRows) throw ERR.NOT_FOUND('Conta nao encontrada.');
      await registrarExclusao(conn, {
        grupoId: novoGrupo(), entidade: 'conta_bancaria', entidadeId: req.params.id,
        empresaId, escopo: conta.escopo, estrategia: 'flag',
        rotulo: conta.nome || null, req
      });
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ ok: true, transacoes_desativadas: transacoesDesativadas });
  }));

  return router;
}
