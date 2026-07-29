// ============================================================================
// routes/contas-receber.js — Contas a receber
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
const ENC = ['devedor_nome', 'devedor_email', 'descricao'];

export function buildContasReceberRouter({
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
    const { status, origem, data_inicio, data_fim } = req.query;
    const where = ['cr.`empresa_id` = ?', 'cr.`escopo` = ?'];
    const params = [empresaId, escopo];
    if (status)      { where.push('cr.`status` = ?');       params.push(status); }
    if (origem)      { where.push('cr.`origem` = ?');       params.push(origem); }
    if (data_inicio) { where.push('cr.`vencimento` >= ?');  params.push(parseDate(data_inicio)); }
    if (data_fim)    { where.push('cr.`vencimento` <= ?');  params.push(parseDate(data_fim)); }

    const contas = await queryFn(
      `SELECT cr.\`id\`, cr.\`devedor_nome\`, cr.\`devedor_email\`, cr.\`valor\`, cr.\`vencimento\`,
              cr.\`status\`, cr.\`valor_pago\`, cr.\`data_recebimento\`,
              cr.\`origem\`, cr.\`crm_lead_id\`, cr.\`descricao\`,
              cr.\`categoria_id\`, c.\`nome\` AS categoria_nome,
              cr.\`conta_bancaria_id\`, cb.\`nome\` AS conta_nome, cb.\`moeda\` AS moeda
         FROM \`FinContaReceber\` cr
         LEFT JOIN \`FinCategoria\` c ON c.\`id\` = cr.\`categoria_id\`
         LEFT JOIN \`FinContaBancaria\` cb ON cb.\`id\` = cr.\`conta_bancaria_id\`
        WHERE ${where.join(' AND ')}
        ORDER BY cr.\`vencimento\` ASC`,
      params
    );

    const pend = await queryOneFn(
      `SELECT COALESCE(SUM(\`valor\` - \`valor_pago\`), 0) AS total
         FROM \`FinContaReceber\`
        WHERE \`empresa_id\` = ? AND \`escopo\` = ? AND \`status\` IN ('pendente','parcial')`,
      [empresaId, escopo]
    );
    const venc = await queryOneFn(
      `SELECT COALESCE(SUM(\`valor\` - \`valor_pago\`), 0) AS total
         FROM \`FinContaReceber\`
        WHERE \`empresa_id\` = ? AND \`escopo\` = ? AND \`status\` = 'vencido'`,
      [empresaId, escopo]
    );
    const moedaBase = await resolveMoedaBase(empresaId, queryOneFn);
    const converted = await enrichRowsWithBase(contas, {
      moedaBase,
      cambioSvc,
      fields: ['valor', 'valor_pago']
    });
    const totalPendenteBase = converted.rows
      .filter((item) => ['pendente', 'parcial'].includes(item.status))
      .reduce((sum, item) => sum + Number(item.saldo_base || 0), 0);
    const totalVencidoBase = converted.rows
      .filter((item) => item.status === 'vencido')
      .reduce((sum, item) => sum + Number(item.saldo_base || 0), 0);
    res.json({
      contas: decRows(converted.rows, ENC), total: contas.length,
      total_pendente: Number(pend?.total || 0),
      total_vencido: Number(venc?.total || 0),
      total_pendente_base: totalPendenteBase,
      total_vencido_base: totalVencidoBase,
      moeda_base: converted.moeda_base,
      moeda_incompleta: converted.moeda_incompleta
    });
  }));

  router.post('/', wrap(async (req, res) => {
    requireFields(req.body, ['devedor_nome', 'valor', 'vencimento', 'conta_bancaria_id']);
    const empresaId = resolveFinanceEmpresa(req);
    const valor = parseDecimal(req.body.valor);
    const vencimento = parseDate(req.body.vencimento);
    const { categoria_id = null, conta_bancaria_id } = req.body;
    const devedor_nome = capText(req.body.devedor_nome, 150, 'devedor_nome');
    if (!devedor_nome) throw ERR.VALIDATION('devedor_nome obrigatorio.'); // "  " passa no requireFields
    const devedor_email = capText(req.body.devedor_email, 150, 'devedor_email');
    const descricao = capText(req.body.descricao, 255, 'descricao');
    const categoriaId = String(categoria_id ?? '').trim();
    let categoria = null;
    if (categoriaId) {
      categoria = await queryOneFn(
        'SELECT `id`, `escopo` FROM `FinCategoria` WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1 LIMIT 1',
        [categoriaId, empresaId]
      );
      if (!categoria) throw ERR.VALIDATION('Categoria inválida');
    }
    const conta = await assertConta(empresaId, conta_bancaria_id);
    if (categoria && (categoria.escopo || 'pessoal') !== conta.escopo) {
      throw ERR.VALIDATION('Categoria de outro escopo (Pessoal x Empresarial).');
    }

    const id = randomUUID();
    // escopo do recebível = escopo da conta bancária (Pessoal x Empresarial não cruzam).
    await queryFn(
      `INSERT INTO \`FinContaReceber\`
         (\`id\`, \`empresa_id\`, \`devedor_nome\`, \`devedor_email\`, \`valor\`,
          \`vencimento\`, \`categoria_id\`, \`conta_bancaria_id\`, \`escopo\`, \`origem\`, \`descricao\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
      [id, empresaId, encryptField(devedor_nome), encryptField(devedor_email), valor, vencimento, categoriaId || null, conta_bancaria_id, conta.escopo, encryptField(descricao)]
    );
    res.status(201).json({ id });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    if (req.body.valor != null) parseDecimal(req.body.valor);
    if (req.body.vencimento) parseDate(req.body.vencimento);
    const atual = await queryOneFn(
      'SELECT `categoria_id`, `conta_bancaria_id`, `escopo` FROM `FinContaReceber` WHERE `id` = ? AND `empresa_id` = ? LIMIT 1',
      [req.params.id, empresaId]
    );
    if (!atual) throw ERR.NOT_FOUND('Conta nao encontrada.');
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
      `UPDATE \`FinContaReceber\`
          SET \`devedor_nome\`  = COALESCE(?, \`devedor_nome\`),
              \`devedor_email\` = COALESCE(?, \`devedor_email\`),
              \`valor\`         = COALESCE(?, \`valor\`),
              \`vencimento\`    = COALESCE(?, \`vencimento\`),
              \`categoria_id\` = COALESCE(?, \`categoria_id\`),
              \`conta_bancaria_id\` = COALESCE(?, \`conta_bancaria_id\`),
              \`descricao\`     = COALESCE(?, \`descricao\`),
              \`updatedAt\`     = NOW(3)
        WHERE \`id\` = ? AND \`empresa_id\` = ?`,
      [
        // COALESCE preserva o valor do banco quando o body não envia o campo;
        // quando envia, cap + cifra antes de gravar.
        encryptField(capText(req.body.devedor_nome, 150, 'devedor_nome')),
        encryptField(capText(req.body.devedor_email, 150, 'devedor_email')),
        req.body.valor ?? null, req.body.vencimento ?? null,
        req.body.categoria_id ?? null,
        req.body.conta_bancaria_id ?? null,
        encryptField(capText(req.body.descricao, 255, 'descricao')),
        req.params.id, empresaId
      ]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Conta nao encontrada.');
    res.json({ ok: true });
  }));

  router.patch('/:id/receber', wrap(async (req, res) => {
    requireFields(req.body, ['valor_recebido', 'data_recebimento']);
    const empresaId = resolveFinanceEmpresa(req);
    const valorRecebido = parseDecimal(req.body.valor_recebido);
    const dataRecebimento = parseDate(req.body.data_recebimento);

    const conn = await poolRef.getConnection();
    let novoPago;
    let novoStatus;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT `devedor_nome`, `valor`, `valor_pago`, `categoria_id`, `conta_bancaria_id`, `escopo`, `lancamento_id` FROM `FinContaReceber` WHERE `id` = ? AND `empresa_id` = ? FOR UPDATE',
        [req.params.id, empresaId]
      );
      const conta = rows[0];
      if (!conta) throw ERR.NOT_FOUND('Conta nao encontrada.');
      const contaBancariaId = req.body.conta_bancaria_id || conta.conta_bancaria_id;
      const contaBanc = await assertContaBancaria(empresaId, contaBancariaId, conn);
      // Invariante: a baixa não pode usar conta bancária de outro escopo.
      if (contaBanc.escopo !== conta.escopo) {
        throw ERR.VALIDATION('Conta bancária de outro escopo (Pessoal x Empresarial).');
      }
      // Regra: todo recebível precisa de categoria antes de ser recebido.
      const categoriaId = req.body.categoria_id || conta.categoria_id;
      if (!categoriaId) throw ERR.VALIDATION('Categoria obrigatória antes de receber.');
      novoPago = Number(conta.valor_pago) + valorRecebido;
      if (novoPago > Number(conta.valor)) throw ERR.VALIDATION('Valor excede saldo restante.');
      novoStatus = novoPago >= Number(conta.valor) ? 'pago' : 'parcial';

      // A baixa GERA um lançamento (origem=conta_a_receber) que credita o caixa.
      const lancamentoId = await createLancamento(conn, {
        empresaId, tipo: 'receita', valor: valorRecebido, data: dataRecebimento,
        // decryptField: devedor_nome vem do banco possivelmente cifrado — decifra
        // ANTES da interpolação (senão ciphertext vaza pra descrição do lançamento).
        descricao: `Recebimento: ${decryptField(conta.devedor_nome)}`, categoriaId, contaId: contaBancariaId,
        escopo: conta.escopo, origem: 'conta_a_receber', origemId: req.params.id, status: 'recebido'
      });

      await conn.execute(
        `UPDATE \`FinContaReceber\`
            SET \`valor_pago\` = ?, \`data_recebimento\` = ?, \`status\` = ?,
                \`categoria_id\` = ?, \`conta_bancaria_id\` = ?,
                \`lancamento_id\` = COALESCE(\`lancamento_id\`, ?), \`updatedAt\` = NOW(3)
          WHERE \`id\` = ? AND \`empresa_id\` = ?`,
        [novoPago, dataRecebimento, novoStatus, categoriaId, contaBancariaId, lancamentoId, req.params.id, empresaId]
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
      const snapshotAR = await snapshotLinha(conn, 'FinContaReceber', req.params.id, empresaId, { forUpdate: true });
      if (!snapshotAR) throw ERR.NOT_FOUND('Conta nao encontrada.');
      if (snapshotAR.origem === 'crm') throw ERR.FORBIDDEN('Conta de origem CRM nao pode ser excluida diretamente.');
      // Captura os filhos ANTES do estorno — reverseLancamentos flags ativo=0,
      // depois disso o filtro `ativo=1` abaixo nao acharia mais nada.
      const [filhos] = await conn.execute(
        'SELECT `id`, `tipo`, `valor`, `escopo`, `descricao` FROM `FinTransacao` WHERE `empresa_id` = ? AND `origem` = ? AND `origem_id` = ? AND `ativo` = 1',
        [empresaId, 'conta_a_receber', req.params.id]
      );
      // Excluir o recebível estorna os lançamentos que as baixas geraram
      // (soft-delete + retirada do crédito do saldo). Cobre o espelho do histórico.
      estornado = await reverseLancamentos(conn, empresaId, 'conta_a_receber', req.params.id);
      await conn.execute(
        'DELETE FROM `FinContaReceber` WHERE `id` = ? AND `empresa_id` = ?',
        [req.params.id, empresaId]
      );
      const grupoId = novoGrupo();
      await registrarExclusao(conn, {
        grupoId, entidade: 'conta_receber', entidadeId: req.params.id,
        empresaId, escopo: snapshotAR.escopo, estrategia: 'snapshot', snapshot: snapshotAR,
        rotulo: 'Conta a receber excluida', valor: snapshotAR.valor, req
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
