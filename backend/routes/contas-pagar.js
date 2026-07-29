// ============================================================================
// routes/contas-pagar.js — Contas a pagar
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne } from '../db.js';
import { wrap, requireFields, parseDecimal, parseDate, capText, resolveFinanceEmpresa, resolveFinanceEscopo } from './_common.js';
import { ERR } from '../security/errors.js';
import { encryptField, decryptField, decRows } from '../security/encryption.js';
import { cambio } from '../security/cambio.js';
import { assertContaBancaria, createLancamentoFromOrigem, reverseLancamentosByOrigem } from './_accounts.js';
import { enrichRowsWithBase, resolveMoedaBase } from './_currency.js';
import { novoGrupo, registrarExclusao, snapshotLinha } from './_lixeira.js';

// Campos cifrados em repouso (enc:v1:...) — decifrar em toda leitura.
const ENC = ['credor', 'descricao'];

export function buildContasPagarRouter({
  poolRef = pool,
  queryFn = query,
  queryOneFn = queryOne,
  cambioSvc = cambio,
  assertConta = assertContaBancaria,
  createLancamento = createLancamentoFromOrigem,
  reverseLancamentos = reverseLancamentosByOrigem
} = {}) {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const escopo = resolveFinanceEscopo(req, 'empresarial');
    const { status, data_inicio, data_fim, categoria_id } = req.query;
    const where = ['cp.`empresa_id` = ?', 'cp.`escopo` = ?'];
    const params = [empresaId, escopo];
    if (status)       { where.push('cp.`status` = ?');        params.push(status); }
    if (categoria_id) { where.push('cp.`categoria_id` = ?');  params.push(categoria_id); }
    if (data_inicio)  { where.push('cp.`vencimento` >= ?');   params.push(parseDate(data_inicio)); }
    if (data_fim)     { where.push('cp.`vencimento` <= ?');   params.push(parseDate(data_fim)); }

    const contas = await queryFn(
      `SELECT cp.\`id\`, cp.\`credor\`, cp.\`valor\`, cp.\`vencimento\`, cp.\`status\`,
              cp.\`valor_pago\`, cp.\`data_pagamento\`, cp.\`descricao\`,
              c.\`id\` AS categoria_id, c.\`nome\` AS categoria_nome,
              cp.\`conta_bancaria_id\`, cb.\`nome\` AS conta_nome, cb.\`moeda\` AS moeda
         FROM \`FinContaPagar\` cp
         LEFT JOIN \`FinCategoria\` c ON c.\`id\` = cp.\`categoria_id\`
         LEFT JOIN \`FinContaBancaria\` cb ON cb.\`id\` = cp.\`conta_bancaria_id\`
        WHERE ${where.join(' AND ')}
        ORDER BY cp.\`vencimento\` ASC`,
      params
    );

    const totRow = await queryOneFn(
      `SELECT COALESCE(SUM(\`valor\` - \`valor_pago\`), 0) AS total_pendente
         FROM \`FinContaPagar\`
        WHERE \`empresa_id\` = ? AND \`escopo\` = ? AND \`status\` IN ('pendente','parcial','vencido')`,
      [empresaId, escopo]
    );
    const moedaBase = await resolveMoedaBase(empresaId, queryOneFn);
    const converted = await enrichRowsWithBase(contas, {
      moedaBase,
      cambioSvc,
      fields: ['valor', 'valor_pago']
    });
    const totalPendenteBase = converted.rows
      .filter((item) => ['pendente', 'parcial', 'vencido'].includes(item.status))
      .reduce((sum, item) => sum + Number(item.saldo_base || 0), 0);
    res.json({
      contas: decRows(converted.rows, ENC),
      total: contas.length,
      total_pendente: Number(totRow?.total_pendente || 0),
      total_pendente_base: totalPendenteBase,
      moeda_base: converted.moeda_base,
      moeda_incompleta: converted.moeda_incompleta
    });
  }));

  router.post('/', wrap(async (req, res) => {
    requireFields(req.body, ['credor', 'valor', 'vencimento', 'conta_bancaria_id']);
    const empresaId = resolveFinanceEmpresa(req);
    const valor = parseDecimal(req.body.valor);
    const vencimento = parseDate(req.body.vencimento);
    const categoria_id = String(req.body.categoria_id ?? '').trim();
    if (!categoria_id) throw ERR.VALIDATION('Categoria obrigatória');
    const categoria = await queryOneFn(
      'SELECT `id`, `escopo` FROM `FinCategoria` WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1 LIMIT 1',
      [categoria_id, empresaId]
    );
    if (!categoria) throw ERR.VALIDATION('Categoria inválida');
    const { conta_bancaria_id } = req.body;
    const credor = capText(req.body.credor, 150, 'credor');
    if (!credor) throw ERR.VALIDATION('credor obrigatorio.'); // "  " passa no requireFields
    const descricao = capText(req.body.descricao, 255, 'descricao');
    const conta = await assertConta(empresaId, conta_bancaria_id);
    if ((categoria.escopo || 'pessoal') !== conta.escopo) {
      throw ERR.VALIDATION('Categoria de outro escopo (Pessoal x Empresarial).');
    }

    const id = randomUUID();
    // escopo da conta a pagar = escopo da conta bancária (não cruza Pessoal/Empresarial).
    await queryFn(
      `INSERT INTO \`FinContaPagar\`
         (\`id\`, \`empresa_id\`, \`credor\`, \`valor\`, \`vencimento\`, \`categoria_id\`, \`conta_bancaria_id\`, \`escopo\`, \`descricao\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, empresaId, encryptField(credor), valor, vencimento, categoria_id, conta_bancaria_id, conta.escopo, encryptField(descricao)]
    );
    res.status(201).json({ id });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    if (req.body.valor != null) parseDecimal(req.body.valor);
    if (req.body.vencimento) parseDate(req.body.vencimento);
    const atual = await queryOneFn(
      'SELECT `categoria_id`, `conta_bancaria_id`, `escopo` FROM `FinContaPagar` WHERE `id` = ? AND `empresa_id` = ? LIMIT 1',
      [req.params.id, empresaId]
    );
    if (!atual) throw ERR.NOT_FOUND('Conta nao encontrada ou ja paga.');
    const conta = req.body.conta_bancaria_id
      ? await assertConta(empresaId, req.body.conta_bancaria_id)
      : { escopo: atual.escopo };
    const categoriaId = req.body.categoria_id ?? atual.categoria_id;
    if (categoriaId) {
      const categoria = await queryOneFn(
        'SELECT `id`, `escopo` FROM `FinCategoria` WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1 LIMIT 1',
        [categoriaId, empresaId]
      );
      if (!categoria) throw ERR.VALIDATION('Categoria inválida');
      if ((categoria.escopo || 'pessoal') !== conta.escopo) {
        throw ERR.VALIDATION('Categoria de outro escopo (Pessoal x Empresarial).');
      }
    }
    const r = await queryFn(
      `UPDATE \`FinContaPagar\`
          SET \`credor\`       = COALESCE(?, \`credor\`),
              \`valor\`        = COALESCE(?, \`valor\`),
              \`vencimento\`   = COALESCE(?, \`vencimento\`),
              \`categoria_id\` = COALESCE(?, \`categoria_id\`),
              \`conta_bancaria_id\` = COALESCE(?, \`conta_bancaria_id\`),
              \`descricao\`    = COALESCE(?, \`descricao\`),
              \`updatedAt\`    = NOW(3)
        WHERE \`id\` = ? AND \`empresa_id\` = ?
          AND \`status\` IN ('pendente','parcial','vencido')`,
      [
        // COALESCE preserva o valor do banco quando o body não envia o campo;
        // quando envia, cap + cifra antes de gravar.
        encryptField(capText(req.body.credor, 150, 'credor')),
        req.body.valor ?? null, req.body.vencimento ?? null,
        req.body.categoria_id ?? null, req.body.conta_bancaria_id ?? null,
        encryptField(capText(req.body.descricao, 255, 'descricao')),
        req.params.id, empresaId
      ]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Conta nao encontrada ou ja paga.');
    res.json({ ok: true });
  }));

  router.patch('/:id/pagar', wrap(async (req, res) => {
    requireFields(req.body, ['valor_pago', 'data_pagamento']);
    const empresaId = resolveFinanceEmpresa(req);
    const valorPago = parseDecimal(req.body.valor_pago);
    const dataPagamento = parseDate(req.body.data_pagamento);

    const conn = await poolRef.getConnection();
    let novoPago;
    let novoStatus;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT `credor`, `valor`, `valor_pago` AS pago_atual, `categoria_id`, `conta_bancaria_id`, `escopo`, `lancamento_id` FROM `FinContaPagar` WHERE `id` = ? AND `empresa_id` = ? FOR UPDATE',
        [req.params.id, empresaId]
      );
      const conta = rows[0];
      if (!conta) throw ERR.NOT_FOUND('Conta nao encontrada.');
      const contaBancariaId = req.body.conta_bancaria_id || conta.conta_bancaria_id;
      const contaBanc = await assertConta(empresaId, contaBancariaId, conn);
      // Invariante: a baixa não pode usar conta bancária de outro escopo.
      if (contaBanc.escopo !== conta.escopo) {
        throw ERR.VALIDATION('Conta bancária de outro escopo (Pessoal x Empresarial).');
      }
      // Regra: toda AP precisa de categoria antes de ser paga (classifica o lançamento).
      const categoriaId = req.body.categoria_id || conta.categoria_id;
      if (!categoriaId) throw ERR.VALIDATION('Categoria obrigatória antes de pagar.');
      novoPago = Number(conta.pago_atual) + valorPago;
      if (novoPago > Number(conta.valor)) throw ERR.VALIDATION('Valor excede saldo restante.');
      novoStatus = novoPago >= Number(conta.valor) ? 'pago' : 'parcial';

      // A baixa GERA um lançamento (origem=conta_a_pagar) que move o caixa. Fonte
      // única: nenhum relatório lê valor_pago direto — todos leem FinTransacao.
      const lancamentoId = await createLancamento(conn, {
        empresaId, tipo: 'despesa', valor: valorPago, data: dataPagamento,
        // decryptField: credor vem do banco possivelmente cifrado — decifra ANTES
        // da interpolação (senão ciphertext vaza pra descrição do lançamento).
        descricao: `Pagamento: ${decryptField(conta.credor)}`, categoriaId, contaId: contaBancariaId,
        escopo: conta.escopo, origem: 'conta_a_pagar', origemId: req.params.id, status: 'pago'
      });

      await conn.execute(
        `UPDATE \`FinContaPagar\`
            SET \`valor_pago\` = ?, \`data_pagamento\` = ?, \`status\` = ?,
                \`categoria_id\` = ?, \`conta_bancaria_id\` = ?,
                \`lancamento_id\` = COALESCE(\`lancamento_id\`, ?), \`updatedAt\` = NOW(3)
          WHERE \`id\` = ? AND \`empresa_id\` = ?`,
        [novoPago, dataPagamento, novoStatus, categoriaId, contaBancariaId, lancamentoId, req.params.id, empresaId]
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ status: novoStatus, valor_pago: novoPago.toFixed(2) });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const conn = await poolRef.getConnection();
    let estornado = 0;
    try {
      await conn.beginTransaction();
      const snapshotAP = await snapshotLinha(conn, 'FinContaPagar', req.params.id, empresaId, { forUpdate: true });
      if (!snapshotAP) throw ERR.NOT_FOUND('Conta nao encontrada.');
      // Captura os filhos ANTES do estorno — reverseLancamentos flags ativo=0,
      // depois disso o filtro `ativo=1` abaixo nao acharia mais nada.
      const [filhos] = await conn.execute(
        'SELECT `id`, `tipo`, `valor`, `escopo`, `descricao` FROM `FinTransacao` WHERE `empresa_id` = ? AND `origem` = ? AND `origem_id` = ? AND `ativo` = 1',
        [empresaId, 'conta_a_pagar', req.params.id]
      );
      // Excluir a AP estorna os lançamentos que as baixas geraram (soft-delete +
      // devolução ao saldo). Cobre baixa total e parcial, e o espelho do histórico.
      estornado = await reverseLancamentos(conn, empresaId, 'conta_a_pagar', req.params.id);
      await conn.execute(
        'DELETE FROM `FinContaPagar` WHERE `id` = ? AND `empresa_id` = ?',
        [req.params.id, empresaId]
      );
      const grupoId = novoGrupo();
      await registrarExclusao(conn, {
        grupoId, entidade: 'conta_pagar', entidadeId: req.params.id,
        empresaId, escopo: snapshotAP.escopo, estrategia: 'snapshot', snapshot: snapshotAP,
        rotulo: 'Conta a pagar excluida', valor: snapshotAP.valor, req
      });
      for (const filho of filhos) {
        await registrarExclusao(conn, {
          grupoId, entidade: 'transacao', entidadeId: filho.id,
          empresaId, escopo: filho.escopo, estrategia: 'flag',
          rotulo: decryptField(filho.descricao) || null, valor: filho.valor, req
        });
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ ok: true, saldo_estornado: estornado.toFixed(2) });
  }));

  return router;
}
