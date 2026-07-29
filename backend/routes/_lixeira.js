// ============================================================================
// routes/_lixeira.js — mecanismo generico da Lixeira universal (FinLixeira)
// ----------------------------------------------------------------------------
// Duas estrategias de exclusao no sistema, uma camada de registro:
//   - 'flag'     — a tabela ja tinha soft-delete (ativo=0 / status / deleted_at).
//                  A LINHA CONTINUA NO BANCO; restaurar so precisa ler o valor
//                  atual e reverter a flag. Nada e guardado em `snapshot`.
//   - 'snapshot' — hard delete de verdade. A linha SOME do banco no exato
//                  instante do DELETE; `snapshot` guarda o JSON de `SELECT *`
//                  tirado ANTES do DELETE, unica forma de trazer o dado de
//                  volta depois.
// Em ambos os casos, `registrarExclusao` roda DENTRO da mesma transacao do
// delete que a chamou — se o delete faz rollback, a lixeira nao fica com
// fantasma.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { ERR } from '../security/errors.js';
import { encryptField } from '../security/encryption.js';
import { assertContaBancaria, moveSaldoConta } from './_accounts.js';

export function novoGrupo() {
  return randomUUID();
}

// Converte Date -> string no formato que o MySQL aceita nativamente pra
// DATE/DATETIME ('YYYY-MM-DD HH:MM:SS.mmm'). Sem isso, JSON.stringify vira
// ISO-8601 com 'T'/'Z' (ex.: '2026-07-27T00:00:00.000Z'), que alguns modos
// estritos do MySQL recusam como valor de bind pra coluna de data.
function toMysqlDateTime(d) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
       + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

function serializeForSnapshot(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? toMysqlDateTime(v) : v;
  }
  return out;
}

// Tira uma foto da linha ANTES do DELETE (uso exclusivo da estrategia
// 'snapshot' — hard delete). `empresaId` opcional: algumas tabelas auxiliares
// (ex.: FinanceUserEmpresa) nao tem coluna empresa_id propria. `forUpdate`
// mantem o mesmo lock pessimista que a rota original tinha (contas-pagar,
// contas-receber) — evita corrida entre duas exclusoes concorrentes do mesmo
// titulo.
export async function snapshotLinha(conn, tabela, id, empresaId = null, { forUpdate = false } = {}) {
  const where = empresaId != null ? '`id` = ? AND `empresa_id` = ?' : '`id` = ?';
  const params = empresaId != null ? [id, empresaId] : [id];
  const [rows] = await conn.execute(
    `SELECT * FROM \`${tabela}\` WHERE ${where} LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    params
  );
  return rows[0] ? serializeForSnapshot(rows[0]) : null;
}

// Registra uma exclusao na lixeira. SEMPRE dentro da mesma transacao (conn)
// do DELETE/UPDATE que a disparou.
//   grupoId    — itens excluidos na mesma operacao restauram juntos.
//   entidade   — chave de REGISTRO_ENTIDADES (dispatch de restauracao).
//   snapshot   — objeto JS (ja serializado por snapshotLinha) ou null p/ 'flag'.
//   rotulo     — texto PLAINTEXT legivel; esta funcao cifra antes de gravar.
export async function registrarExclusao(conn, {
  grupoId, entidade, entidadeId, empresaId = null, escopo = null,
  estrategia, snapshot = null, rotulo = null, valor = null, req = null
}) {
  const id = randomUUID();
  await conn.execute(
    `INSERT INTO \`FinLixeira\`
       (\`id\`, \`grupo_id\`, \`entidade\`, \`entidade_id\`, \`empresa_id\`, \`escopo\`,
        \`estrategia\`, \`snapshot\`, \`rotulo\`, \`valor\`, \`excluido_por\`, \`excluido_por_nome\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, grupoId, entidade, entidadeId, empresaId, escopo,
      estrategia, snapshot != null ? JSON.stringify(snapshot) : null,
      rotulo != null ? encryptField(String(rotulo)) : null,
      valor != null ? valor : null,
      req?.financeUser?.id ?? null, req?.financeUser?.nome ?? null
    ]
  );
  return id;
}

// ────────────────────────────────────────────────────────────────────────────
// Restauracao por snapshot — INSERT de volta a partir do JSON. As chaves do
// objeto vem de um `SELECT *` anterior (snapshotLinha), nunca de entrada do
// usuario, entao interpolar o nome das colunas no SQL aqui e seguro.
// ────────────────────────────────────────────────────────────────────────────

// Colunas GERADAS (STORED) nao podem aparecer num INSERT — o MySQL recusa.
const GENERATED_COLUMNS = {
  FinAporteInvestimento: ['total']
};

async function restaurarPorSnapshot(conn, tabela, item) {
  if (!item.snapshot) throw ERR.CONFLICT('Snapshot ausente. Nao e possivel restaurar este item.');
  const snapshot = typeof item.snapshot === 'string' ? JSON.parse(item.snapshot) : item.snapshot;

  const [existe] = await conn.execute(`SELECT \`id\` FROM \`${tabela}\` WHERE \`id\` = ? LIMIT 1`, [item.entidade_id]);
  if (existe[0]) throw ERR.CONFLICT('Ja existe um registro com este id. Restauracao cancelada.');

  const excluir = new Set(GENERATED_COLUMNS[tabela] || []);
  const cols = Object.keys(snapshot).filter((c) => !excluir.has(c));
  const colList = cols.map((c) => `\`${c}\``).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map((c) => snapshot[c]);
  await conn.execute(`INSERT INTO \`${tabela}\` (${colList}) VALUES (${placeholders})`, values);
}

// ────────────────────────────────────────────────────────────────────────────
// Restauracao por flag — a linha nunca saiu do banco; le o estado atual e
// reverte o soft-delete. Idempotente (restaurar 2x nao duplica efeito).
// ────────────────────────────────────────────────────────────────────────────

async function restaurarTransacao(conn, item) {
  const [rows] = await conn.execute(
    'SELECT `id`, `tipo`, `valor`, `conta_bancaria_id`, `empresa_id`, `ativo` FROM `FinTransacao` WHERE `id` = ? LIMIT 1',
    [item.entidade_id]
  );
  const row = rows[0];
  if (!row) throw ERR.CONFLICT('Lancamento nao existe mais.');
  if (Number(row.ativo) === 1) return; // ja ativo — restauracao repetida, sem-op.

  if (row.conta_bancaria_id) {
    // Valida ANTES de gravar qualquer coisa — 409 sem efeito colateral se a
    // conta sumiu ou foi arquivada nesse meio-tempo.
    try {
      await assertContaBancaria(row.empresa_id, row.conta_bancaria_id, conn);
    } catch {
      throw ERR.CONFLICT('Conta bancaria deste lancamento nao existe mais ou esta inativa. Restaure a conta primeiro.');
    }
  }

  await conn.execute(
    'UPDATE `FinTransacao` SET `ativo` = 1, `cancelado_em` = NULL, `cancelado_por` = NULL, `updatedAt` = NOW(3) WHERE `id` = ?',
    [row.id]
  );
  if (row.conta_bancaria_id) {
    const delta = row.tipo === 'receita' ? Number(row.valor) : -Number(row.valor);
    await moveSaldoConta(conn, row.empresa_id, row.conta_bancaria_id, delta);
  }
}

async function restaurarContaBancaria(conn, item) {
  const [r] = await conn.execute(
    'UPDATE `FinContaBancaria` SET `ativo` = 1, `updatedAt` = NOW(3) WHERE `id` = ?',
    [item.entidade_id]
  );
  if (!r.affectedRows) throw ERR.CONFLICT('Conta bancaria nao existe mais.');
}

async function restaurarMeta(conn, item) {
  // A rota de delete sempre grava status='cancelada' independente do status
  // anterior (ver routes/metas.js) — restaurar volta pra 'ativa' por design.
  const [r] = await conn.execute(
    "UPDATE `FinMeta` SET `status` = 'ativa', `updatedAt` = NOW(3) WHERE `id` = ?",
    [item.entidade_id]
  );
  if (!r.affectedRows) throw ERR.CONFLICT('Meta nao existe mais.');
}

async function restaurarInvestimento(conn, item) {
  const [r] = await conn.execute(
    'UPDATE `FinInvestimento` SET `ativo` = 1, `updatedAt` = NOW(3) WHERE `id` = ?',
    [item.entidade_id]
  );
  if (!r.affectedRows) throw ERR.CONFLICT('Investimento nao existe mais.');
}

async function restaurarUsuario(conn, item) {
  const [rows] = await conn.execute(
    'SELECT `session_version` FROM `FinanceUser` WHERE `id` = ? LIMIT 1',
    [item.entidade_id]
  );
  if (!rows[0]) throw ERR.CONFLICT('Usuario nao existe mais.');
  await conn.execute(
    'UPDATE `FinanceUser` SET `deleted_at` = NULL, `session_version` = ?, `updatedAt` = NOW(3) WHERE `id` = ?',
    [Number(rows[0].session_version || 0) + 1, item.entidade_id]
  );
}

async function restaurarDelegacao(conn, item) {
  // DELETE /delegacoes/:id so faz ativo=0 (a linha nunca sai do banco) — flag,
  // nao snapshot, mesmo que o snapshot tenha sido gravado por documentacao.
  const [r] = await conn.execute(
    'UPDATE `FinanceDelegacao` SET `ativo` = 1, `updatedAt` = NOW(3) WHERE `id` = ?',
    [item.entidade_id]
  );
  if (!r.affectedRows) throw ERR.CONFLICT('Delegacao nao existe mais.');
}

// ────────────────────────────────────────────────────────────────────────────
// Dispatch por entidade
// ────────────────────────────────────────────────────────────────────────────

export const REGISTRO_ENTIDADES = {
  transacao:        { tabela: 'FinTransacao',         restaurar: restaurarTransacao },
  conta_bancaria:    { tabela: 'FinContaBancaria',      restaurar: restaurarContaBancaria },
  meta:              { tabela: 'FinMeta',               restaurar: restaurarMeta },
  investimento:      { tabela: 'FinInvestimento',       restaurar: restaurarInvestimento },
  usuario:           { tabela: 'FinanceUser',           restaurar: restaurarUsuario },
  delegacao:         { tabela: 'FinanceDelegacao',      restaurar: restaurarDelegacao },
  categoria:         { tabela: 'FinCategoria',          restaurar: (conn, item) => restaurarPorSnapshot(conn, 'FinCategoria', item) },
  categoria_pessoal: { tabela: 'FinCategoriaPessoal',   restaurar: (conn, item) => restaurarPorSnapshot(conn, 'FinCategoriaPessoal', item) },
  orcamento:         { tabela: 'FinOrcamento',          restaurar: (conn, item) => restaurarPorSnapshot(conn, 'FinOrcamento', item) },
  divida:            { tabela: 'FinDividaPessoal',      restaurar: (conn, item) => restaurarPorSnapshot(conn, 'FinDividaPessoal', item) },
  aporte:            { tabela: 'FinAporteInvestimento', restaurar: (conn, item) => restaurarPorSnapshot(conn, 'FinAporteInvestimento', item) },
  conta_pagar:       { tabela: 'FinContaPagar',         restaurar: (conn, item) => restaurarPorSnapshot(conn, 'FinContaPagar', item) },
  conta_receber:     { tabela: 'FinContaReceber',       restaurar: (conn, item) => restaurarPorSnapshot(conn, 'FinContaReceber', item) },
  empresa:           { tabela: 'Empresa',               restaurar: (conn, item) => restaurarPorSnapshot(conn, 'Empresa', item) },
  vinculo_empresa:   { tabela: 'FinanceUserEmpresa',    restaurar: (conn, item) => restaurarPorSnapshot(conn, 'FinanceUserEmpresa', item) }
};

// Ordem de restauracao dentro de um grupo — "pais" antes de "filhos" (ex.:
// empresa antes de vinculo_empresa; conta_pagar antes dos lancamentos que ela
// gerou). Entidade fora da lista vai pro fim, sem quebrar nada.
const RESTORE_ORDER = [
  'empresa', 'usuario', 'delegacao', 'investimento', 'conta_bancaria',
  'categoria', 'categoria_pessoal', 'conta_pagar', 'conta_receber',
  'divida', 'orcamento', 'meta', 'aporte', 'transacao', 'vinculo_empresa'
];
function restoreOrderIndex(entidade) {
  const i = RESTORE_ORDER.indexOf(entidade);
  return i === -1 ? RESTORE_ORDER.length : i;
}

// Restaura TODOS os itens pendentes de um grupo (mesma operacao de exclusao),
// numa unica transacao — ou tudo, ou nada. `conn` precisa estar dentro de um
// beginTransaction() aberto pelo chamador (rota).
export async function restaurarGrupo(conn, grupoId, req) {
  const [rows] = await conn.execute(
    'SELECT * FROM `FinLixeira` WHERE `grupo_id` = ? AND `restaurado_em` IS NULL AND `purgado_em` IS NULL FOR UPDATE',
    [grupoId]
  );
  if (!rows.length) throw ERR.NOT_FOUND('Nada para restaurar neste grupo.');

  const ordenados = [...rows].sort((a, b) => restoreOrderIndex(a.entidade) - restoreOrderIndex(b.entidade));

  for (const item of ordenados) {
    const registro = REGISTRO_ENTIDADES[item.entidade];
    if (!registro) throw ERR.INTERNAL(req?.id);
    await registro.restaurar(conn, item);
  }

  const ids = rows.map((r) => r.id);
  await conn.execute(
    `UPDATE \`FinLixeira\` SET \`restaurado_em\` = NOW(3), \`restaurado_por\` = ?
      WHERE \`id\` IN (${ids.map(() => '?').join(',')})`,
    [req?.financeUser?.id ?? null, ...ids]
  );
  return { count: rows.length, entidades: ordenados.map((r) => r.entidade) };
}
