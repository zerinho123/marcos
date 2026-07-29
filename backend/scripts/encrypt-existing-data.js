// ============================================================================
// scripts/encrypt-existing-data.js — cifra em lote os dados legados (plaintext)
// ----------------------------------------------------------------------------
// Uso:
//   node scripts/encrypt-existing-data.js --dry-run   (só conta, não grava)
//   node scripts/encrypt-existing-data.js             (cifra de verdade)
//
// Pré-requisitos OBRIGATÓRIOS:
//   1. BACKUP FRESCO do banco (a operação é irreversível sem a chave!);
//   2. FINANCE_ENC_KEY_CURRENT definida no .env (64 chars hex);
//   3. Colunas já alargadas p/ TEXT (sql/20260707_security_features.sql).
//
// Idempotente e retomável: o filtro NOT LIKE 'enc:v1:%' é o cursor — linhas já
// cifradas nunca são reprocessadas; pode rodar N vezes, inclusive após falha.
// Sem este script a migração continua válida (lazy): linhas antigas ficam em
// plaintext (passthrough na leitura) e viram ciphertext quando editadas.
// ============================================================================

import '../bootstrap.js';
import { pool } from '../db.js';
import { encryptField, isEncryptionEnabled, ENC_PREFIX } from '../security/encryption.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 500;

// [tabela, campos cifrados] — mesmo mapa do ensureFinanceFieldEncryptionColumns.
const TARGETS = [
  ['FinTransacao',     ['descricao', 'observacao']],
  ['FinContaPagar',    ['credor', 'descricao']],
  ['FinContaReceber',  ['devedor_nome', 'devedor_email', 'descricao']],
  ['FinDividaPessoal', ['credor', 'descricao']],
  ['FinDividaEvento',  ['descricao']],
  ['Empresa',          ['cnpj', 'email', 'telefone']]
];

async function processTable(conn, table, fields) {
  let totalUpdated = 0;
  for (const field of fields) {
    // Cursor natural: NOT LIKE exclui o que já foi cifrado.
    const whereLegacy = `\`${field}\` IS NOT NULL AND \`${field}\` <> '' AND \`${field}\` NOT LIKE '${ENC_PREFIX}%'`;

    if (DRY_RUN) {
      const [rows] = await conn.query(
        `SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${whereLegacy}`
      );
      console.log(`[dry-run] ${table}.${field}: ${rows[0].n} linha(s) em plaintext`);
      continue;
    }

    for (;;) {
      const [rows] = await conn.query(
        `SELECT \`id\`, \`${field}\` AS v FROM \`${table}\` WHERE ${whereLegacy} LIMIT ${BATCH}`
      );
      if (!rows.length) break;
      for (const row of rows) {
        await conn.execute(
          `UPDATE \`${table}\` SET \`${field}\` = ? WHERE \`id\` = ?`,
          [encryptField(String(row.v)), row.id]
        );
      }
      totalUpdated += rows.length;
      console.log(`${table}.${field}: +${rows.length} (total ${totalUpdated})`);
    }
  }
  return totalUpdated;
}

async function main() {
  if (!isEncryptionEnabled()) {
    console.error('FINANCE_ENC_KEY_CURRENT ausente no .env — nada a fazer. Abortando.');
    process.exit(1);
  }
  console.log(DRY_RUN ? '=== DRY RUN (nenhuma escrita) ===' : '=== CIFRANDO DADOS LEGADOS ===');
  const conn = await pool.getConnection();
  try {
    let total = 0;
    for (const [table, fields] of TARGETS) {
      total += await processTable(conn, table, fields);
    }
    console.log(DRY_RUN ? 'Dry-run concluido.' : `Concluido: ${total} atualizacao(oes).`);
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Falhou:', e?.message || e);
  process.exit(1);
});
