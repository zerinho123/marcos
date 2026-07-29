// ============================================================================
// security/ambiente.js — resolução/validação do "ambiente ativo" (Pessoal x
// Empresarial) sobre o vínculo FinanceUserEmpresa + delegação entre usuários.
// ============================================================================
// Modelo: cada usuário tem 1 empresa "pessoal" oculta (Empresa.tipo='pessoal')
// além de N empresas normais vinculadas via FinanceUserEmpresa. O ambiente
// ativo escolhido pelo usuário vira uma claim no JWT (ver financeAuth.js) —
// aqui só resolvemos/validamos, nunca confiamos em empresa_id vindo cru do
// cliente sem checar vínculo.
//
// Delegação (v87): um gestor pode comandar a conta Pessoal de outro usuário
// sem nunca saber a senha dele — FinanceDelegacao é a fonte única da verdade
// (nunca duplicada em FinanceUserEmpresa). O acesso ao Pessoal alheio é NEGADO
// POR PADRÃO; só abre com uma linha ativa em FinanceDelegacao concedida pelo
// dono do sistema (ver routes/delegacoes.js).

import { randomUUID } from 'node:crypto';
import { query, queryOne } from '../db.js';
import { ERR } from './errors.js';

// Lista as empresas que o usuário pode acessar, separando a pessoal (se já
// existir) das empresariais normais.
export async function listAmbientes(userId) {
  const rows = await query(
    `SELECT fue.\`empresa_id\`, fue.\`perfil\`, e.\`nome\`, e.\`tipo\`
       FROM \`FinanceUserEmpresa\` fue
       JOIN \`Empresa\` e ON e.\`id\` = fue.\`empresa_id\`
      WHERE fue.\`user_id\` = ? AND fue.\`ativo\` = 1
      ORDER BY e.\`nome\` ASC`,
    [userId]
  );
  const pessoal = rows.find((r) => r.tipo === 'pessoal') ?? null;
  const empresas = rows.filter((r) => r.tipo !== 'pessoal');
  return { pessoal, empresas };
}

// Contas que `gestorId` comanda por delegação — alimenta o painel lateral do
// frontend e a tela /delegacoes/minhas.
export async function listDelegacoes(gestorId) {
  return query(
    `SELECT d.\`id\`, d.\`usuario_id\`, d.\`permissao\`, u.\`nome\`, u.\`username\`
       FROM \`FinanceDelegacao\` d
       JOIN \`FinanceUser\` u ON u.\`id\` = d.\`usuario_id\` AND u.\`deleted_at\` IS NULL
      WHERE d.\`gestor_id\` = ? AND d.\`ativo\` = 1
      ORDER BY u.\`nome\` ASC`,
    [gestorId]
  );
}

// Confirma que `gestorId` tem delegação ATIVA sobre `usuarioId` e devolve a
// permissao corrente ('visualizar' | 'operar'). Lança FORBIDDEN se não tiver
// — nunca deixa passar em silêncio. Revalidado a CADA request por
// buildRequireFinanceAuth (financeAuth.js), então uma revogação/downgrade
// feito pelo dono vale no próximo request, sem esperar o token expirar.
export async function assertDelegacao(gestorId, usuarioId) {
  const row = await queryOne(
    `SELECT d.\`permissao\`
       FROM \`FinanceDelegacao\` d
       JOIN \`FinanceUser\` u ON u.\`id\` = d.\`usuario_id\` AND u.\`deleted_at\` IS NULL
      WHERE d.\`gestor_id\` = ? AND d.\`usuario_id\` = ? AND d.\`ativo\` = 1
        AND COALESCE(u.\`status\`, 'aprovado') = 'aprovado'
      LIMIT 1`,
    [gestorId, usuarioId]
  );
  if (!row) throw ERR.FORBIDDEN('Sem delegacao para esta conta.');
  return row.permissao;
}

// Confirma que o usuário tem vínculo ativo com a empresa informada.
// - `tipo='normal'`: exige vínculo ativo em FinanceUserEmpresa (comportamento
//   original, inalterado).
// - `tipo='pessoal'`: NEGADO POR PADRÃO — só libera se `userId` for o próprio
//   dono dessa empresa pessoal, ou se existir delegação ativa de `userId`
//   sobre esse dono. É o gargalo por onde toda tentativa de acessar o Pessoal
//   de outra pessoa passa (override de admin, troca de ambiente, etc.).
// Lança FORBIDDEN se não tiver — nunca deixa passar em silêncio.
export async function assertEmpresaVinculo(userId, empresaId) {
  const empresa = await queryOne(
    `SELECT e.\`tipo\`,
            (SELECT fue.\`user_id\` FROM \`FinanceUserEmpresa\` fue
              WHERE fue.\`empresa_id\` = e.\`id\` AND fue.\`perfil\` = 'dono' AND fue.\`ativo\` = 1
              LIMIT 1) AS dono_id,
            (SELECT 1 FROM \`FinanceUserEmpresa\` fue
              WHERE fue.\`user_id\` = ? AND fue.\`empresa_id\` = e.\`id\` AND fue.\`ativo\` = 1
              LIMIT 1) AS vinculo
       FROM \`Empresa\` e WHERE e.\`id\` = ? LIMIT 1`,
    [userId, empresaId]
  );
  if (!empresa) throw ERR.FORBIDDEN('Usuario sem vinculo com esta empresa.');

  if (empresa.tipo === 'pessoal') {
    if (empresa.dono_id && String(empresa.dono_id) === String(userId)) return;
    if (empresa.dono_id) {
      const delegacao = await queryOne(
        'SELECT 1 FROM `FinanceDelegacao` WHERE `gestor_id` = ? AND `usuario_id` = ? AND `ativo` = 1 LIMIT 1',
        [userId, empresa.dono_id]
      );
      if (delegacao) return;
    }
    throw ERR.FORBIDDEN('Usuario sem vinculo com esta empresa.');
  }

  if (!empresa.vinculo) throw ERR.FORBIDDEN('Usuario sem vinculo com esta empresa.');
}

// Self-heal equivalente ao ensureUserEmpresa (server.js), mas para a empresa
// pessoal sintética. Lazy: só cria na primeira vez que alguém pede o ambiente
// Pessoal daquele usuário (o próprio dono, ou um gestor delegado) — cobre
// usuários criados depois do backfill em
// database/migrations/004_backfill_empresa_pessoal.sql.
export async function ensureUserPessoalEmpresa(user) {
  const { pessoal } = await listAmbientes(user.id);
  if (pessoal) return pessoal.empresa_id;

  const empresaId = randomUUID();
  await query(
    'INSERT INTO `Empresa` (`id`, `nome`, `tipo`) VALUES (?, ?, ?)',
    [empresaId, `Pessoal — ${user.nome}`, 'pessoal']
  );
  await query(
    'INSERT INTO `FinanceUserEmpresa` (`id`, `user_id`, `empresa_id`, `perfil`) VALUES (?, ?, ?, ?)',
    [randomUUID(), user.id, empresaId, 'dono']
  );
  return empresaId;
}

// Resolve o ambiente pedido pelo front em { tipo, empresa_id, usuario_id }
// para o par que efetivamente vira claim no JWT — validando vínculo/delegação
// no caminho. TODO role passa por assertEmpresaVinculo, admin incluso: o
// acesso amplo que o admin tinha vira vínculo explícito em FinanceUserEmpresa
// (backfill em schema-evolution.js + vínculo automático na criação de
// empresa), então nada quebra — mas o acesso passa a ser auditável e
// revogável (ativo=0).
export async function resolveAmbienteAlvo(financeUser, { tipo, empresa_id, usuario_id } = {}) {
  if (tipo === 'pessoal') {
    // Ambiente Pessoal DELEGADO: usuario_id aponta pra conta de terceiro que o
    // chamador comanda. Sem usuario_id (ou apontando pro próprio chamador), o
    // comportamento é o de sempre — Pessoal do próprio usuário, sem checagem
    // extra.
    if (usuario_id && String(usuario_id).trim() && String(usuario_id).trim() !== String(financeUser.id)) {
      const geridoId = String(usuario_id).trim();
      const permissao = await assertDelegacao(financeUser.id, geridoId);
      const gerido = await queryOne(
        'SELECT `id`, `nome` FROM `FinanceUser` WHERE `id` = ? AND `deleted_at` IS NULL LIMIT 1',
        [geridoId]
      );
      if (!gerido) throw ERR.FORBIDDEN('Sem delegacao para esta conta.');
      const empresaId = await ensureUserPessoalEmpresa(gerido);
      return { tipo: 'pessoal', empresa_id: empresaId, owner_id: gerido.id, owner_nome: gerido.nome, permissao };
    }
    const empresaId = await ensureUserPessoalEmpresa(financeUser);
    return { tipo: 'pessoal', empresa_id: empresaId };
  }
  if (tipo === 'empresarial') {
    if (!empresa_id) throw ERR.VALIDATION('empresa_id obrigatorio para ambiente empresarial.');
    const empresaId = String(empresa_id).trim();
    // so empresa 'normal' pode virar ambiente empresarial — fecha o vetor de
    // disfarcar uma empresa pessoal alheia de "empresa" no seletor.
    const empresa = await queryOne('SELECT `tipo` FROM `Empresa` WHERE `id` = ? LIMIT 1', [empresaId]);
    if (!empresa || empresa.tipo !== 'normal') {
      throw ERR.VALIDATION('Empresa invalida para ambiente empresarial.');
    }
    await assertEmpresaVinculo(financeUser.id, empresaId);
    return { tipo: 'empresarial', empresa_id: empresaId };
  }
  throw ERR.VALIDATION("tipo invalido. Valores aceitos: 'pessoal', 'empresarial'.");
}
