// ============================================================================
// routes/_personal-currency.js — moeda-base do ambiente Pessoal do usuário
// ----------------------------------------------------------------------------
// A "moeda padrão pessoal" de um usuário é o `moeda_base` da Empresa dele com
// tipo='pessoal'. Este módulo centraliza ler/gravar essa moeda para que tanto o
// painel admin (users.js) quanto o self-service do próprio usuário (auth.js)
// usem exatamente a mesma regra — sem duplicar SQL nem divergir de comportamento.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isMoedaSuportada } from '../security/cambio.js';

// Schema reutilizável: normaliza p/ MAIÚSCULA e recusa moeda não suportada pelo
// motor de câmbio. Use dentro de um z.object() (ex.: { moeda: moedaPessoalSchema }).
export const moedaPessoalSchema = z.string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine(isMoedaSuportada, 'Moeda pessoal invalida.');

// Lê a moeda-base da Empresa pessoal do usuário. Default 'BRL' quando o usuário
// ainda não tem empresa pessoal (nunca configurou / conta recém-criada).
export async function readPersonalCurrency(queryOneFn, userId) {
  const row = await queryOneFn(
    `SELECT e.\`moeda_base\`
       FROM \`FinanceUserEmpresa\` fue
       JOIN \`Empresa\` e ON e.\`id\` = fue.\`empresa_id\` AND e.\`tipo\` = 'pessoal'
      WHERE fue.\`user_id\` = ? AND fue.\`ativo\` = 1
      LIMIT 1`,
    [userId]
  );
  return String(row?.moeda_base || 'BRL').toUpperCase();
}

// Grava a moeda-base da Empresa pessoal do usuário. Cria a empresa pessoal (+ link
// de dono) se ainda não existir. Recebe uma connection já em transação — o
// O lock da linha do usuario serializa a primeira criacao e evita duas empresas
// pessoais quando requisicoes concorrentes ainda nao encontram um vinculo.
export async function syncUserPersonalCurrency(conn, user, moedaPessoal) {
  await conn.execute(
    'SELECT `id` FROM `FinanceUser` WHERE `id` = ? LIMIT 1 FOR UPDATE',
    [user.id]
  );
  const [result] = await conn.execute(
    `SELECT e.\`id\`
       FROM \`FinanceUserEmpresa\` fue
       JOIN \`Empresa\` e ON e.\`id\` = fue.\`empresa_id\` AND e.\`tipo\` = 'pessoal'
      WHERE fue.\`user_id\` = ? AND fue.\`ativo\` = 1
      LIMIT 1 FOR UPDATE`,
    [user.id]
  );
  const pessoal = Array.isArray(result) ? result[0] : null;
  if (pessoal?.id) {
    await conn.execute(
      'UPDATE `Empresa` SET `moeda_base` = ?, `updatedAt` = NOW(3) WHERE `id` = ? AND `tipo` = ?',
      [moedaPessoal, pessoal.id, 'pessoal']
    );
    return;
  }

  const empresaId = randomUUID();
  await conn.execute(
    'INSERT INTO `Empresa` (`id`, `nome`, `tipo`, `moeda_base`) VALUES (?, ?, ?, ?)',
    [empresaId, `Pessoal — ${user.nome}`, 'pessoal', moedaPessoal]
  );
  await conn.execute(
    'INSERT INTO `FinanceUserEmpresa` (`id`, `user_id`, `empresa_id`, `perfil`) VALUES (?, ?, ?, ?)',
    [randomUUID(), user.id, empresaId, 'dono']
  );
}
