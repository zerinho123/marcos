// ============================================================================
// routes/_accounts.js — validacao e movimento de contas bancarias
// ============================================================================

import { randomUUID } from 'node:crypto';
import { queryOne } from '../db.js';
import { ERR } from '../security/errors.js';
import { encryptField } from '../security/encryption.js';
import { cambio as defaultCambio } from '../security/cambio.js';
import { createTransactionCurrencySnapshot } from './_currency.js';

// Valida a conta e retorna { id, escopo }. O `escopo` é usado pelas rotas para
// carimbar o lançamento no MESMO escopo da conta (Pessoal x Empresarial não
// cruzam) e barrar baixas de AR/AP em conta de outro escopo.
export async function assertContaBancaria(empresaId, contaId, conn = null) {
  if (!contaId) throw ERR.VALIDATION('Conta bancaria obrigatoria.');
  const sql =
    'SELECT `id`, `escopo`, `moeda` FROM `FinContaBancaria` WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1 LIMIT 1';
  if (conn) {
    const [rows] = await conn.execute(sql, [contaId, empresaId]);
    if (!rows[0]) throw ERR.NOT_FOUND('Conta bancaria invalida.');
    return { id: String(rows[0].id), escopo: rows[0].escopo, moeda: String(rows[0].moeda || 'BRL').toUpperCase() };
  }
  const row = await queryOne(sql, [contaId, empresaId]);
  if (!row) throw ERR.NOT_FOUND('Conta bancaria invalida.');
  return { id: String(row.id), escopo: row.escopo, moeda: String(row.moeda || 'BRL').toUpperCase() };
}

export async function moveSaldoConta(conn, empresaId, contaId, delta) {
  await assertContaBancaria(empresaId, contaId, conn);
  const [result] = await conn.execute(
    'UPDATE `FinContaBancaria` SET `saldo` = `saldo` + ? WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1',
    [delta, contaId, empresaId]
  );
  if (!result.affectedRows) throw ERR.NOT_FOUND('Conta bancaria invalida.');
}

// Estorno tolerante: reverte o efeito de uma transacao no saldo SEM exigir conta
// ativa. Usado ao editar/excluir uma transacao — inclusive orfas, presas a uma
// conta ja excluida (soft-delete) — pra que nunca fiquem impossiveis de remover.
// Nao lanca erro se a conta nao existir mais: o estorno simplesmente nao aplica.
export async function reverseSaldoConta(conn, empresaId, contaId, delta) {
  if (!contaId) return;
  await conn.execute(
    'UPDATE `FinContaBancaria` SET `saldo` = `saldo` + ? WHERE `id` = ? AND `empresa_id` = ?',
    [delta, contaId, empresaId]
  );
}

// Cria um lançamento (FinTransacao) a partir de uma origem (baixa de AP/AR) e
// move o saldo da conta. É a ÚNICA forma de uma baixa mexer no caixa: o
// lançamento passa a ser a fonte de verdade que os relatórios leem.
// Retorna o id do lançamento criado.
export async function createLancamentoFromOrigem(conn, {
  empresaId, tipo, valor, data, descricao,
  categoriaId = null, contaId, escopo, origem, origemId, status,
  cambioSvc = defaultCambio
}) {
  const id = randomUUID();
  const conta = await assertContaBancaria(empresaId, contaId, conn);
  const snapshot = await createTransactionCurrencySnapshot(conn, {
    empresaId, conta, valor, data, cambioSvc
  });
  await conn.execute(
    `INSERT INTO \`FinTransacao\`
       (\`id\`, \`empresa_id\`, \`tipo\`, \`valor\`, \`data\`, \`descricao\`,
        \`categoria_id\`, \`conta_bancaria_id\`, \`escopo\`, \`status\`, \`origem\`, \`origem_id\`,
        \`moeda\`, \`moeda_base\`, \`taxa_cambio\`, \`valor_base\`, \`cotacao_data\`, \`cotacao_fonte\`, \`cotacao_status\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    // Choke point único das baixas de AP/AR: cifra a descrição aqui (os callers
    // passam plaintext já decifrado — ex. "Pagamento: <credor legível>").
    [
      id, empresaId, tipo, valor, data, encryptField(descricao), categoriaId, contaId, escopo, status, origem, origemId,
      snapshot.moeda, snapshot.moeda_base, snapshot.taxa_cambio, snapshot.valor_base,
      snapshot.cotacao_data, snapshot.cotacao_fonte, snapshot.cotacao_status
    ]
  );
  const delta = tipo === 'receita' ? valor : -valor;
  await moveSaldoConta(conn, empresaId, contaId, delta);
  return id;
}

// Estorna (soft-delete) todos os lançamentos ativos de uma origem e devolve o
// efeito ao saldo. Usado ao excluir uma AP/AR já baixada: desfaz exatamente o
// que as baixas fizeram no caixa. Estorno tolerante (conta pode estar inativa).
// Retorna o total estornado (valor absoluto somado).
export async function reverseLancamentosByOrigem(conn, empresaId, origem, origemId) {
  const [rows] = await conn.execute(
    'SELECT `tipo`, `valor`, `conta_bancaria_id` FROM `FinTransacao` WHERE `empresa_id` = ? AND `origem` = ? AND `origem_id` = ? AND `ativo` = 1',
    [empresaId, origem, origemId]
  );
  let total = 0;
  for (const t of rows) {
    const deltaRev = t.tipo === 'receita' ? -Number(t.valor) : Number(t.valor);
    await reverseSaldoConta(conn, empresaId, t.conta_bancaria_id, deltaRev);
    total += Number(t.valor);
  }
  if (rows.length) {
    await conn.execute(
      'UPDATE `FinTransacao` SET `ativo` = 0, `updatedAt` = NOW(3) WHERE `empresa_id` = ? AND `origem` = ? AND `origem_id` = ? AND `ativo` = 1',
      [empresaId, origem, origemId]
    );
  }
  return total;
}
