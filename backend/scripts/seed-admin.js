// ============================================================================
// scripts/seed-admin.js — cria empresa + usuario admin inicial
// ----------------------------------------------------------------------------
// Uso:
//   node scripts/seed-admin.js <username> <senha> [nomeEmpresa]
//
// Exemplo:
//   node scripts/seed-admin.js admin MinhaSenh@123 "CF Mentoria"
//
// Le DATABASE_URL do .env (via bootstrap). Idempotente: se a empresa/usuario
// ja existirem, atualiza a senha do admin.
// ============================================================================

import '../bootstrap.js';
import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { hashPassword } from '../security/auth.js';

const [, , username, senha, nomeEmpresa = 'CF Mentoria'] = process.argv;

if (!username || !senha) {
  console.error('Uso: node scripts/seed-admin.js <username> <senha> [nomeEmpresa]');
  process.exit(1);
}
if (senha.length < 8) {
  console.error('Senha precisa ter pelo menos 8 caracteres.');
  process.exit(1);
}

async function main() {
  const conn = await pool.getConnection();
  try {
    // 1) Empresa — reusa a primeira existente ou cria
    const [empRows] = await conn.execute('SELECT `id` FROM `Empresa` LIMIT 1');
    let empresaId;
    if (empRows[0]) {
      empresaId = empRows[0].id;
      console.log(`Empresa existente reaproveitada: ${empresaId}`);
    } else {
      empresaId = randomUUID();
      await conn.execute(
        'INSERT INTO `Empresa` (`id`, `nome`) VALUES (?, ?)',
        [empresaId, nomeEmpresa]
      );
      console.log(`Empresa criada: ${empresaId} (${nomeEmpresa})`);
    }

    // 2) Usuario admin
    const hash = await hashPassword(senha);
    const [userRows] = await conn.execute(
      'SELECT `id` FROM `FinanceUser` WHERE `username` = ? LIMIT 1',
      [username.toLowerCase()]
    );

    if (userRows[0]) {
      await conn.execute(
        'UPDATE `FinanceUser` SET `password` = ?, `role` = ?, `empresa_id` = ?, `updatedAt` = NOW(3) WHERE `id` = ?',
        [hash, 'admin', empresaId, userRows[0].id]
      );
      console.log(`Admin "${username}" ja existia — senha atualizada.`);
    } else {
      await conn.execute(
        `INSERT INTO \`FinanceUser\`
           (\`id\`, \`username\`, \`password\`, \`nome\`, \`role\`, \`empresa_id\`, \`createdAt\`, \`updatedAt\`)
         VALUES (?, ?, ?, ?, 'admin', ?, NOW(3), NOW(3))`,
        [randomUUID(), username.toLowerCase(), hash, 'Administrador', empresaId]
      );
      console.log(`Admin "${username}" criado com sucesso.`);
    }

    console.log('\nPronto! Faca login com:');
    console.log(`  usuario: ${username.toLowerCase()}`);
    console.log(`  senha:   ${senha}`);
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Erro ao criar admin:', e?.message || e);
  process.exit(1);
});
