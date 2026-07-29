// ============================================================================
// routes/transacoes.js — CRUD de FinTransacao + ajuste de saldo de conta
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne } from '../db.js';
import { wrap, requireFields, enumOr, parseDecimal, parseDate, capText, resolveFinanceEmpresa, resolveFinanceEscopo } from './_common.js';
import { ERR } from '../security/errors.js';
import { encryptField, decryptField, decRows } from '../security/encryption.js';
import { cambio } from '../security/cambio.js';
import { assertContaBancaria, moveSaldoConta, reverseSaldoConta } from './_accounts.js';
import { createTransactionCurrencySnapshot, enrichRowsWithBase, resolveMoedaBase } from './_currency.js';
import { novoGrupo, registrarExclusao } from './_lixeira.js';

const TIPOS = ['receita', 'despesa'];
// Campos cifrados em repouso (enc:v1:...) — decifrar em toda leitura.
const ENC = ['descricao'];

// Depois de gravar uma despesa, confere se o orçamento da categoria (no
// período vigente) estourou — inclui o próprio lançamento recém-inserido,
// porque a checagem roda DENTRO da mesma transação (conn ve seus proprios
// writes ainda não commitados). Espelha a mesma logica de "gasto_atual" de
// routes/orcamentos.js (shape/GET), só que virada do avesso: aqui já sabemos
// a categoria e queremos achar o orçamento dela, não o contrário.
// Só orçamento de despesa existe (ver categoria "natureza=despesa" em
// orcamentos.js) — não faz sentido chamar para receita.
async function checkOrcamentoEstourado(conn, { empresaId, escopo, categoriaEmpresarialId, categoriaPessoalId, data }) {
  const isPessoal = escopo === 'pessoal';
  const categoriaId = isPessoal ? categoriaPessoalId : categoriaEmpresarialId;
  if (!categoriaId) return null;

  const [orcRows] = await conn.execute(
    isPessoal
      ? `SELECT o.\`limite\`,
                COALESCE(o.\`data_inicio\`, o.\`mes\`) AS data_inicio,
                COALESCE(o.\`data_fim\`, LAST_DAY(o.\`mes\`)) AS data_fim,
                cp.\`nome\` AS categoria_nome
           FROM \`FinOrcamento\` o
           JOIN \`FinCategoriaPessoal\` cp ON cp.\`id\` = o.\`categoria_pessoal_id\` AND cp.\`empresa_id\` = o.\`empresa_id\`
          WHERE o.\`empresa_id\` = ? AND o.\`escopo\` = 'pessoal' AND o.\`categoria_pessoal_id\` = ?
            AND ? BETWEEN COALESCE(o.\`data_inicio\`, o.\`mes\`) AND COALESCE(o.\`data_fim\`, LAST_DAY(o.\`mes\`))
          LIMIT 1`
      : `SELECT o.\`limite\`,
                COALESCE(o.\`data_inicio\`, o.\`mes\`) AS data_inicio,
                COALESCE(o.\`data_fim\`, LAST_DAY(o.\`mes\`)) AS data_fim,
                c.\`nome\` AS categoria_nome
           FROM \`FinOrcamento\` o
           JOIN \`FinCategoria\` c ON c.\`id\` = o.\`categoria_id\` AND c.\`empresa_id\` = o.\`empresa_id\`
          WHERE o.\`empresa_id\` = ? AND o.\`escopo\` = 'empresarial' AND o.\`categoria_id\` = ?
            AND ? BETWEEN COALESCE(o.\`data_inicio\`, o.\`mes\`) AND COALESCE(o.\`data_fim\`, LAST_DAY(o.\`mes\`))
          LIMIT 1`,
    [empresaId, categoriaId, data]
  );
  const orc = orcRows[0];
  if (!orc) return null;

  const categoriaCol = isPessoal ? 'categoria_pessoal_id' : 'categoria_id';
  const [gastoRows] = await conn.execute(
    `SELECT COALESCE(SUM(t.\`valor\`), 0) AS gasto
       FROM \`FinTransacao\` t
       JOIN \`FinContaBancaria\` cb ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
      WHERE t.\`empresa_id\` = ? AND t.\`escopo\` = ? AND t.\`${categoriaCol}\` = ? AND t.\`tipo\` = 'despesa'
        AND t.\`ativo\` = 1 AND cb.\`ativo\` = 1
        AND t.\`data\` >= ? AND t.\`data\` <= ?`,
    [empresaId, escopo, categoriaId, orc.data_inicio, orc.data_fim]
  );

  const limite = Number(orc.limite || 0);
  const usado = Number(gastoRows[0]?.gasto || 0);
  if (usado <= limite) return null;
  return {
    categoria: orc.categoria_nome,
    limite,
    usado,
    percentual: limite > 0 ? Math.round((usado / limite) * 100) : 0
  };
}

export function buildTransacoesRouter({
  poolRef = pool,
  queryFn = query,
  queryOneFn = queryOne,
  cambioSvc = cambio
} = {}) {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const escopo = resolveFinanceEscopo(req);
    const { tipo, categoria_id, conta_bancaria_id, data_inicio, data_fim } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    // Isolamento por escopo: a conta é a fonte de verdade (cb.escopo). Transações
    // sem conta não aparecem nesta listagem (JOIN), então filtrar por cb basta.
    const where = [
      't.`empresa_id` = ?',
      't.`ativo` = 1',
      'cb.`empresa_id` = ?',
      'cb.`ativo` = 1',
      'cb.`escopo` = ?'
    ];
    const params = [empresaId, empresaId, escopo];
    if (tipo)              { where.push('t.`tipo` = ?');              params.push(tipo); }
    if (categoria_id)      { where.push('(t.`categoria_id` = ? OR t.`categoria_pessoal_id` = ?)'); params.push(categoria_id, categoria_id); }
    if (conta_bancaria_id) { where.push('t.`conta_bancaria_id` = ?'); params.push(conta_bancaria_id); }
    if (data_inicio)       { where.push('t.`data` >= ?');             params.push(parseDate(data_inicio)); }
    if (data_fim)          { where.push('t.`data` <= ?');             params.push(parseDate(data_fim)); }

    const transacoes = await queryFn(
      `SELECT t.\`id\`, t.\`tipo\`, t.\`valor\`, t.\`data\`, t.\`descricao\`,
              COALESCE(cp.\`id\`, c.\`id\`) AS categoria_id,
              COALESCE(cp.\`nome\`, c.\`nome\`) AS categoria_nome,
              cb.\`id\` AS conta_id, cb.\`nome\` AS conta_nome, cb.\`escopo\` AS conta_escopo,
              COALESCE(t.\`moeda\`, cb.\`moeda\`) AS moeda,
              t.\`moeda_base\`, t.\`taxa_cambio\`, t.\`valor_base\`,
              t.\`cotacao_data\`, t.\`cotacao_fonte\`, t.\`cotacao_status\`
         FROM \`FinTransacao\` t
         LEFT JOIN \`FinCategoria\` c
           ON c.\`id\` = t.\`categoria_id\` AND c.\`empresa_id\` = t.\`empresa_id\`
         LEFT JOIN \`FinCategoriaPessoal\` cp
           ON cp.\`id\` = t.\`categoria_pessoal_id\` AND cp.\`empresa_id\` = t.\`empresa_id\`
         JOIN \`FinContaBancaria\` cb
           ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
        WHERE ${where.join(' AND ')}
        ORDER BY t.\`data\` DESC, t.\`id\` DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const totalRow = await queryOneFn(
      `SELECT COUNT(*) AS total
         FROM \`FinTransacao\` t
         JOIN \`FinContaBancaria\` cb
           ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
        WHERE ${where.join(' AND ')}`,
      params
    );
    const moedaBase = await resolveMoedaBase(empresaId, queryOneFn);
    const converted = await enrichRowsWithBase(transacoes, {
      moedaBase,
      cambioSvc,
      fields: ['valor']
    });
    res.json({
      transacoes: decRows(converted.rows, ENC),
      total: Number(totalRow?.total || 0),
      moeda_base: converted.moeda_base,
      moeda_incompleta: converted.moeda_incompleta
    });
  }));

  router.post('/', wrap(async (req, res) => {
    requireFields(req.body, ['tipo', 'valor', 'data', 'conta_bancaria_id', 'categoria_id']);
    const empresaId = resolveFinanceEmpresa(req);
    const tipo = enumOr(req.body.tipo, TIPOS, 'tipo');
    const valor = parseDecimal(req.body.valor);
    const data = parseDate(req.body.data);
    const descricao = capText(req.body.descricao, 255, 'descricao');
    // Regra do modelo Categoria→Lançamento→Conta: todo lançamento NOVO precisa de
    // categoria (classifica) e conta (movimenta). Lançamentos antigos sem categoria
    // não são tocados aqui — serão tratados na tela de Pendências.
    const categoria_id = String(req.body.categoria_id ?? '').trim();
    if (!categoria_id) throw ERR.VALIDATION('Categoria obrigatoria.');
    const conta_bancaria_id = String(req.body.conta_bancaria_id || '').trim();

    const id = randomUUID();
    const conn = await poolRef.getConnection();
    let saldoNovo = null;
    let orcamentoEstourado = null;
    try {
      await conn.beginTransaction();
      const conta = await assertContaBancaria(empresaId, conta_bancaria_id, conn);
      let categoriaEmpresarialId = null;
      let categoriaPessoalId = null;
      if (conta.escopo === 'pessoal') {
        const [catRows] = await conn.execute(
          'SELECT `id` FROM `FinCategoriaPessoal` WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1 LIMIT 1',
          [categoria_id, empresaId]
        );
        if (!catRows[0]) throw ERR.VALIDATION('Categoria invalida.');
        categoriaPessoalId = categoria_id;
      } else {
        const [catRows] = await conn.execute(
          'SELECT `id` FROM `FinCategoria` WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1 LIMIT 1',
          [categoria_id, empresaId]
        );
        if (!catRows[0]) throw ERR.VALIDATION('Categoria invalida.');
        categoriaEmpresarialId = categoria_id;
      }
      // Escopo do lançamento = escopo da conta (Pessoal x Empresarial não cruzam).
      const snapshot = await createTransactionCurrencySnapshot(conn, {
        empresaId, conta, valor, data, cambioSvc
      });
      await conn.execute(
        `INSERT INTO \`FinTransacao\`
           (\`id\`, \`empresa_id\`, \`tipo\`, \`valor\`, \`data\`, \`descricao\`, \`categoria_id\`, \`categoria_pessoal_id\`, \`conta_bancaria_id\`, \`escopo\`,
            \`moeda\`, \`moeda_base\`, \`taxa_cambio\`, \`valor_base\`, \`cotacao_data\`, \`cotacao_fonte\`, \`cotacao_status\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, empresaId, tipo, valor, data, encryptField(descricao), categoriaEmpresarialId, categoriaPessoalId, conta_bancaria_id, conta.escopo,
          snapshot.moeda, snapshot.moeda_base, snapshot.taxa_cambio, snapshot.valor_base,
          snapshot.cotacao_data, snapshot.cotacao_fonte, snapshot.cotacao_status
        ]
      );
      const delta = tipo === 'receita' ? valor : -valor;
      await moveSaldoConta(conn, empresaId, conta_bancaria_id, delta);
      const [rows] = await conn.execute(
        'SELECT `saldo` FROM `FinContaBancaria` WHERE `id` = ? AND `empresa_id` = ?',
        [conta_bancaria_id, empresaId]
      );
      saldoNovo = rows[0]?.saldo;
      orcamentoEstourado = tipo === 'despesa'
        ? await checkOrcamentoEstourado(conn, {
            empresaId, escopo: conta.escopo, categoriaEmpresarialId, categoriaPessoalId, data
          })
        : null;
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.status(201).json({ id, saldo_conta: saldoNovo, orcamento_estourado: orcamentoEstourado });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    if (req.body.tipo) enumOr(req.body.tipo, TIPOS, 'tipo');
    if (req.body.valor != null) parseDecimal(req.body.valor);
    if (req.body.data) parseDate(req.body.data);

    const conn = await poolRef.getConnection();
    let replacementId = null;
    let orcamentoEstourado = null;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT * FROM `FinTransacao` WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1 FOR UPDATE',
        [req.params.id, empresaId]
      );
      const antiga = rows[0];
      if (!antiga) throw ERR.NOT_FOUND('Transacao nao encontrada.');
      if ((antiga.origem || 'lancamento_manual') !== 'lancamento_manual') {
        throw ERR.VALIDATION('Lancamento gerado por conta a pagar ou receber deve ser corrigido na origem.');
      }

      if (antiga.conta_bancaria_id) {
        const deltaRev = antiga.tipo === 'receita' ? -antiga.valor : antiga.valor;
        // Estorno tolerante: a conta antiga pode ter sido excluida; ainda assim
        // revertemos o efeito antes de aplicar o novo lancamento.
        await reverseSaldoConta(conn, empresaId, antiga.conta_bancaria_id, deltaRev);
      }

      const nova = {
        tipo:              req.body.tipo              ?? antiga.tipo,
        valor:             req.body.valor             ?? antiga.valor,
        data:              req.body.data              ?? antiga.data,
        // Nova descrição vem do body (cap + cifra); ausente = mantém a do banco
        // (já cifrada — encryptField é idempotente e não recifra).
        descricao:         req.body.descricao != null
                             ? capText(req.body.descricao, 255, 'descricao')
                             : antiga.descricao,
        categoria_id:      req.body.categoria_id      ?? antiga.categoria_pessoal_id ?? antiga.categoria_id,
        conta_bancaria_id: req.body.conta_bancaria_id ?? antiga.conta_bancaria_id
      };
      if (!nova.conta_bancaria_id) throw ERR.VALIDATION('Conta bancaria obrigatoria.');
      const contaNova = await assertContaBancaria(empresaId, nova.conta_bancaria_id, conn);
      if (!nova.categoria_id) throw ERR.VALIDATION('Categoria obrigatoria.');
      let categoriaEmpresarialId = null;
      let categoriaPessoalId = null;
      if (contaNova.escopo === 'pessoal') {
        const [catRows] = await conn.execute(
          'SELECT `id` FROM `FinCategoriaPessoal` WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1 LIMIT 1',
          [nova.categoria_id, empresaId]
        );
        if (!catRows[0]) throw ERR.VALIDATION('Categoria invalida.');
        categoriaPessoalId = nova.categoria_id;
      } else {
        const [catRows] = await conn.execute(
          'SELECT `id` FROM `FinCategoria` WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1 LIMIT 1',
          [nova.categoria_id, empresaId]
        );
        if (!catRows[0]) throw ERR.VALIDATION('Categoria invalida.');
        categoriaEmpresarialId = nova.categoria_id;
      }

      const snapshot = await createTransactionCurrencySnapshot(conn, {
        empresaId, conta: contaNova, valor: nova.valor, data: nova.data, cambioSvc
      });
      replacementId = randomUUID();
      await conn.execute(
        `INSERT INTO \`FinTransacao\`
           (\`id\`, \`empresa_id\`, \`tipo\`, \`valor\`, \`data\`, \`descricao\`,
            \`categoria_id\`, \`categoria_pessoal_id\`, \`conta_bancaria_id\`, \`escopo\`,
            \`status\`, \`origem\`, \`origem_id\`, \`observacao\`, \`correcao_de_id\`,
            \`moeda\`, \`moeda_base\`, \`taxa_cambio\`, \`valor_base\`, \`cotacao_data\`, \`cotacao_fonte\`, \`cotacao_status\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'lancamento_manual', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          replacementId, empresaId, nova.tipo, nova.valor, nova.data, encryptField(nova.descricao),
          categoriaEmpresarialId, categoriaPessoalId, nova.conta_bancaria_id, contaNova.escopo,
          antiga.status || 'pago', antiga.observacao || null, antiga.id,
          snapshot.moeda, snapshot.moeda_base, snapshot.taxa_cambio, snapshot.valor_base,
          snapshot.cotacao_data, snapshot.cotacao_fonte, snapshot.cotacao_status
        ]
      );
      await conn.execute(
        `UPDATE \`FinTransacao\`
            SET \`ativo\` = 0, \`cancelado_em\` = NOW(3), \`cancelado_por\` = ?, \`updatedAt\` = NOW(3)
          WHERE \`id\` = ? AND \`empresa_id\` = ? AND \`ativo\` = 1`,
        [req.financeUser.id, antiga.id, empresaId]
      );

      if (nova.conta_bancaria_id) {
        const delta = nova.tipo === 'receita' ? Number(nova.valor) : -Number(nova.valor);
        await moveSaldoConta(conn, empresaId, nova.conta_bancaria_id, delta);
      }
      orcamentoEstourado = nova.tipo === 'despesa'
        ? await checkOrcamentoEstourado(conn, {
            empresaId, escopo: contaNova.escopo, categoriaEmpresarialId, categoriaPessoalId, data: nova.data
          })
        : null;
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ ok: true, id: replacementId, correcao_de_id: req.params.id, orcamento_estourado: orcamentoEstourado });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const conn = await poolRef.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT `tipo`, `valor`, `escopo`, `descricao`, `conta_bancaria_id`, `origem` FROM `FinTransacao` WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1 FOR UPDATE',
        [req.params.id, empresaId]
      );
      const antiga = rows[0];
      if (!antiga) throw ERR.NOT_FOUND('Transacao nao encontrada.');
      if ((antiga.origem || 'lancamento_manual') !== 'lancamento_manual') {
        throw ERR.VALIDATION('Lancamento gerado por conta a pagar ou receber deve ser excluido na origem.');
      }

      if (antiga.conta_bancaria_id) {
        const deltaRev = antiga.tipo === 'receita' ? -antiga.valor : antiga.valor;
        // Estorno tolerante: permite excluir ate uma transacao orfa (conta ja
        // excluida) sem cair no antigo erro "Conta bancaria invalida.".
        await reverseSaldoConta(conn, empresaId, antiga.conta_bancaria_id, deltaRev);
      }
      await conn.execute(
        'UPDATE `FinTransacao` SET `ativo` = 0, `cancelado_em` = NOW(3), `cancelado_por` = ?, `updatedAt` = NOW(3) WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1',
        [req.financeUser.id, req.params.id, empresaId]
      );
      await registrarExclusao(conn, {
        grupoId: novoGrupo(), entidade: 'transacao', entidadeId: req.params.id,
        empresaId, escopo: antiga.escopo, estrategia: 'flag',
        rotulo: decryptField(antiga.descricao) || null, valor: antiga.valor, req
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
