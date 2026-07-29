// ============================================================================
// routes/categorias.js — CRUD de FinCategoria (com dono por conta de usuário)
// ----------------------------------------------------------------------------
// queryFn/queryOneFn são injetáveis (default = db real) para teste sem banco.
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne } from '../db.js';
import { wrap, requireFields, enumOr, resolveFinanceEmpresa, resolveFinanceEscopo, dreScope } from './_common.js';
import { ensureFinanceCategoriasSeeded } from './_dre-seed.js';
import { ERR } from '../security/errors.js';
import { novoGrupo, registrarExclusao, snapshotLinha } from './_lixeira.js';

const TIPOS = ['pessoal', 'empresarial', 'ambos'];
const NATUREZAS = ['receita', 'despesa', 'transferencia', 'ajuste'];
const COMPORTAMENTOS = ['fixa', 'variavel', 'nao_aplica'];
const DRE_SECOES = [
  'receita_bruta','deducoes','cmv','servicos_terceiros',
  'comerciais','operacionais_diretas','administrativas',
  'nao_operacionais','juros_emprestimos','ir'
];
const PESSOAL_SEED = [
  ['Moradia', 'despesa', 'home', '#38bdf8'],
  ['Alimentacao', 'despesa', 'cart', '#f97316'],
  ['Transporte', 'despesa', 'car', '#22c55e'],
  ['Saude', 'despesa', 'health', '#ef4444'],
  ['Lazer', 'despesa', 'film', '#a855f7'],
  ['Receita pessoal', 'receita', 'wallet', '#14b8a6']
];

function isPersonalRequest(req) {
  return req.query?.escopo === 'pessoal'
    || req.body?.escopo === 'pessoal'
    || req.body?.tipo === 'pessoal'
    || req.financeUser?.ambiente_tipo === 'pessoal';
}

// Dono do workspace Pessoal ativo — o proprio usuario, EXCETO em ambiente
// delegado (gestor comandando a conta de terceiro via FinanceDelegacao), onde
// vira o id de quem foi delegado. NUNCA usar `req.financeUser.id` direto aqui:
// isso gravaria categoria pessoal em nome do gestor dentro do workspace do
// gerido — o dado ficaria orfao quando a delegacao fosse revogada.
function personalUserId(req) {
  return String(req.financeUser?.pessoal_owner_id || req.financeUser?.id || '');
}

function personalShape(row) {
  return {
    id: row.id,
    nome: row.nome,
    tipo: 'pessoal',
    escopo: 'pessoal',
    natureza: row.natureza || null,
    comportamento: null,
    usar_no_dre: 0,
    usar_na_precificacao: 0,
    dre_secao: null,
    dre_secao_efetiva: null,
    icone: row.icone || null,
    cor: row.cor || null,
    ativo: row.ativo,
    user_id: row.user_id,
    lancamentos_count: Number(row.lancamentos_count || 0)
  };
}

async function ensurePersonalCategoriasSeeded(empresaId, userId, queryOneFn, queryFn) {
  const count = await queryOneFn(
    'SELECT COUNT(*) AS c FROM `FinCategoriaPessoal` WHERE `empresa_id` = ? AND `user_id` = ?',
    [empresaId, userId]
  );
  if (Number(count?.c || 0) > 0) return;
  for (const [nome, natureza, icone, cor] of PESSOAL_SEED) {
    await queryFn(
      `INSERT INTO \`FinCategoriaPessoal\`
         (\`id\`, \`empresa_id\`, \`user_id\`, \`nome\`, \`natureza\`, \`icone\`, \`cor\`)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), empresaId, userId, nome, natureza, icone, cor]
    );
  }
}

export function buildCategoriasRouter({ poolRef = pool, queryFn = query, queryOneFn = queryOne } = {}) {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    if (isPersonalRequest(req)) {
      const userId = personalUserId(req);
      await ensurePersonalCategoriasSeeded(empresaId, userId, queryOneFn, queryFn);
      const rows = await queryFn(
        `SELECT cp.\`id\`, cp.\`nome\`, cp.\`natureza\`, cp.\`icone\`, cp.\`cor\`, cp.\`ativo\`, cp.\`user_id\`,
                (SELECT COUNT(*) FROM \`FinTransacao\` t
                  WHERE t.\`categoria_pessoal_id\` = cp.\`id\` AND t.\`empresa_id\` = cp.\`empresa_id\` AND t.\`ativo\` = 1
                ) AS lancamentos_count
           FROM \`FinCategoriaPessoal\` cp
          WHERE cp.\`empresa_id\` = ? AND cp.\`user_id\` = ?
          ORDER BY cp.\`ativo\` DESC, cp.\`nome\``,
        [empresaId, userId]
      );
      res.json((rows || []).map(personalShape));
      return;
    }
    await ensureFinanceCategoriasSeeded(empresaId, queryOneFn);

    // Escopo por conta de usuário: usuário comum vê as próprias (`user_id` dele)
    // + as compartilhadas/legado (`user_id IS NULL`, ex.: defaults semeados).
    // Admin enxerga todas as categorias da empresa (gestão).
    const isAdmin = req.financeUser?.role === 'admin';
    const userId  = req.financeUser?.id ?? null;

    // Isolamento total Pessoal x Empresarial: só as categorias do escopo ativo.
    // (substitui o antigo filtro por `tipo`/`ambos` — `ambos` deixou de existir).
    const escopo = resolveFinanceEscopo(req);
    const { dre_secao } = req.query;
    let sql = 'SELECT `id`, `nome`, `tipo`, `escopo`, `natureza`, `comportamento`, `usar_no_dre`, `usar_na_precificacao`, `dre_secao`, `icone`, `cor`, `ativo`, `user_id` FROM `FinCategoria` WHERE `empresa_id` = ? AND `escopo` = ?';
    const params = [empresaId, escopo];
    if (!isAdmin) { sql += ' AND (`user_id` = ? OR `user_id` IS NULL)'; params.push(userId); }
    if (dre_secao) { sql += ' AND `dre_secao` = ?'; params.push(dre_secao); }
    sql += ' ORDER BY `dre_secao`, `nome`';
    const rows = await queryFn(sql, params);

    // Seção efetiva do DRE por categoria = fonte ÚNICA de classificação. O DRE
    // migrou a classificação pra FinDreUserMapa (categoria→linha→seção, por
    // escopo de usuário); a coluna FinCategoria.dre_secao ficou NULL na maioria
    // das categorias criadas pelo usuário. Sem isto, "Despesas Variáveis" e o
    // Dashboard (que liam só dre_secao) divergiam do DRE — e a tela aparecia
    // vazia. Resolvido com query separada (não mexe no SELECT de ownership) +
    // merge em memória: usa o mapa do escopo do usuário com fallback no template.
    if (Array.isArray(rows) && rows.length) {
      const scopeId = dreScope(req); // '' = template da empresa; <adminId> = DRE pessoal
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const mapaRows = await queryFn(
        `SELECT m.\`categoria_id\` AS categoria_id, m.\`user_id\` AS map_user_id, l.\`secao\` AS secao
           FROM \`FinDreUserMapa\` m
           JOIN \`FinDreLinha\` l ON l.\`id\` = m.\`linha_id\`
          WHERE m.\`empresa_id\` = ? AND m.\`user_id\` IN ('', ?) AND m.\`categoria_id\` IN (${placeholders})`,
        [empresaId, scopeId, ...ids]
      );
      const doEscopo = new Map();   // categoria_id -> seção do escopo do usuário
      const doTemplate = new Map(); // categoria_id -> seção do template (user_id '')
      for (const m of (mapaRows || [])) {
        const dest = String(m.map_user_id) === String(scopeId) ? doEscopo : doTemplate;
        dest.set(String(m.categoria_id), m.secao);
      }
      for (const r of rows) {
        const efetiva = doEscopo.get(String(r.id)) ?? doTemplate.get(String(r.id)) ?? null;
        r.dre_secao_efetiva = efetiva;
      }

      // Contagem de lançamentos vinculados por categoria (FinTransacao ativa) —
      // alimenta a tela de Categorias e o bloqueio de exclusão. Uma query só.
      const usoRows = await queryFn(
        `SELECT \`categoria_id\` AS id, COUNT(*) AS total
           FROM \`FinTransacao\`
          WHERE \`empresa_id\` = ? AND \`ativo\` = 1 AND \`categoria_id\` IN (${placeholders})
          GROUP BY \`categoria_id\``,
        [empresaId, ...ids]
      );
      const usoById = new Map((usoRows || []).map((u) => [String(u.id), Number(u.total || 0)]));
      for (const r of rows) {
        r.lancamentos_count = usoById.get(String(r.id)) || 0;
      }
    }
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    requireFields(req.body, ['nome']);
    const empresaId = resolveFinanceEmpresa(req);
    const userId = req.financeUser?.id ?? null;
    if (isPersonalRequest(req)) {
      const ownerId = personalUserId(req);
      const natureza = req.body.natureza || null;
      if (natureza) enumOr(natureza, ['receita', 'despesa'], 'natureza');
      const dupe = await queryOneFn(
        'SELECT `id` FROM `FinCategoriaPessoal` WHERE `empresa_id` = ? AND `user_id` = ? AND `nome` = ? AND `ativo` = 1 LIMIT 1',
        [empresaId, ownerId, req.body.nome]
      );
      if (dupe) throw ERR.CONFLICT('Categoria com este nome ja existe.');
      const id = randomUUID();
      await queryFn(
        `INSERT INTO \`FinCategoriaPessoal\`
           (\`id\`, \`empresa_id\`, \`user_id\`, \`nome\`, \`natureza\`, \`icone\`, \`cor\`)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, empresaId, ownerId, req.body.nome, natureza, req.body.icone || null, req.body.cor || null]
      );
      res.status(201).json({ id });
      return;
    }
    // Categoria nasce no escopo do workspace ativo. `tipo` (legado pessoal|
    // empresarial|ambos) espelha o escopo — `ambos` não é mais criado.
    const escopo = resolveFinanceEscopo(req, req.body.tipo || 'pessoal');
    const tipo = escopo;
    const dreSecao = req.body.dre_secao || null;
    if (dreSecao) enumOr(dreSecao, DRE_SECOES, 'dre_secao');
    const natureza = req.body.natureza || null;
    if (natureza) enumOr(natureza, NATUREZAS, 'natureza');
    const comportamento = req.body.comportamento || null;
    if (comportamento) enumOr(comportamento, COMPORTAMENTOS, 'comportamento');
    const usarNoDre = req.body.usar_no_dre == null ? 1 : (req.body.usar_no_dre ? 1 : 0);
    const usarNaPrec = req.body.usar_na_precificacao ? 1 : 0;

    // Duplicidade no escopo do usuário: colide com uma categoria própria de mesmo
    // nome OU com uma compartilhada (`user_id IS NULL`). Não colide com a de outro usuário.
    const dupe = await queryOneFn(
      'SELECT `id` FROM `FinCategoria` WHERE `empresa_id` = ? AND `escopo` = ? AND `nome` = ? AND `ativo` = 1 AND (`user_id` = ? OR `user_id` IS NULL) LIMIT 1',
      [empresaId, escopo, req.body.nome, userId]
    );
    if (dupe) throw ERR.CONFLICT('Categoria com este nome ja existe.');

    const id = randomUUID();
    await queryFn(
      `INSERT INTO \`FinCategoria\`
         (\`id\`, \`empresa_id\`, \`user_id\`, \`nome\`, \`tipo\`, \`escopo\`,
          \`natureza\`, \`comportamento\`, \`usar_no_dre\`, \`usar_na_precificacao\`, \`dre_secao\`, \`icone\`, \`cor\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, empresaId, userId, req.body.nome, tipo, escopo,
       natureza, comportamento, usarNoDre, usarNaPrec, dreSecao, req.body.icone || null, req.body.cor || null]
    );
    res.status(201).json({ id });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    if (isPersonalRequest(req)) {
      if (req.body.natureza) enumOr(req.body.natureza, ['receita', 'despesa'], 'natureza');
      const r = await queryFn(
        `UPDATE \`FinCategoriaPessoal\`
            SET \`nome\` = COALESCE(?, \`nome\`),
                \`natureza\` = COALESCE(?, \`natureza\`),
                \`icone\` = COALESCE(?, \`icone\`),
                \`cor\` = COALESCE(?, \`cor\`),
                \`ativo\` = COALESCE(?, \`ativo\`),
                \`updatedAt\` = NOW(3)
          WHERE \`id\` = ? AND \`empresa_id\` = ? AND \`user_id\` = ?`,
        [
          req.body.nome ?? null,
          req.body.natureza ?? null,
          req.body.icone ?? null,
          req.body.cor ?? null,
          req.body.ativo == null ? null : (req.body.ativo ? 1 : 0),
          req.params.id,
          empresaId,
          personalUserId(req)
        ]
      );
      if (!r.affectedRows) throw ERR.NOT_FOUND('Categoria nao encontrada.');
      res.json({ ok: true });
      return;
    }
    const isAdmin = req.financeUser?.role === 'admin';
    const userId  = req.financeUser?.id ?? null;
    if (req.body.tipo) enumOr(req.body.tipo, TIPOS, 'tipo');
    if (req.body.dre_secao) enumOr(req.body.dre_secao, DRE_SECOES, 'dre_secao');
    if (req.body.natureza) enumOr(req.body.natureza, NATUREZAS, 'natureza');
    if (req.body.comportamento) enumOr(req.body.comportamento, COMPORTAMENTOS, 'comportamento');

    // Usuário comum só edita as próprias + compartilhadas; admin edita qualquer uma.
    let where = '`id` = ? AND `empresa_id` = ?';
    const tail = [req.params.id, empresaId];
    if (!isAdmin) { where += ' AND (`user_id` = ? OR `user_id` IS NULL)'; tail.push(userId); }

    // Escopo NAO e editavel via body.tipo: categoria pertence ao ambiente em
    // que nasceu. Antes, `escopoSync` espelhava qualquer `tipo` recebido e
    // migrava a categoria de ambiente sem passar por resolveFinanceEscopo —
    // numa empresa pessoal isso a tornava invisivel pra sempre. Se o body
    // pedir um `tipo` que muda o ambiente, rejeita; front deve criar outra
    // categoria (2026-07 — ver auditoria de isolamento).
    if (['pessoal', 'empresarial'].includes(req.body.tipo) && req.body.tipo !== resolveFinanceEscopo(req)) {
      throw ERR.VALIDATION('Ambiente da categoria nao pode ser alterado. Crie outra categoria no ambiente desejado.');
    }
    const escopoSync = null;
    const r = await queryFn(
      `UPDATE \`FinCategoria\`
          SET \`nome\`          = COALESCE(?, \`nome\`),
              \`tipo\`          = COALESCE(?, \`tipo\`),
              \`escopo\`        = COALESCE(?, \`escopo\`),
              \`natureza\`      = COALESCE(?, \`natureza\`),
              \`comportamento\` = COALESCE(?, \`comportamento\`),
              \`usar_no_dre\`   = COALESCE(?, \`usar_no_dre\`),
              \`usar_na_precificacao\` = COALESCE(?, \`usar_na_precificacao\`),
              \`dre_secao\`     = COALESCE(?, \`dre_secao\`),
              \`icone\`         = COALESCE(?, \`icone\`),
              \`cor\`           = COALESCE(?, \`cor\`),
              \`ativo\`         = COALESCE(?, \`ativo\`),
              \`updatedAt\`     = NOW(3)
        WHERE ${where}`,
      [
        req.body.nome ?? null, req.body.tipo ?? null, escopoSync,
        req.body.natureza ?? null, req.body.comportamento ?? null,
        req.body.usar_no_dre == null ? null : (req.body.usar_no_dre ? 1 : 0),
        req.body.usar_na_precificacao == null ? null : (req.body.usar_na_precificacao ? 1 : 0),
        req.body.dre_secao ?? null,
        req.body.icone ?? null, req.body.cor ?? null,
        req.body.ativo == null ? null : (req.body.ativo ? 1 : 0),
        ...tail
      ]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Categoria nao encontrada.');
    res.json({ ok: true });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    if (isPersonalRequest(req)) {
      const usos = await queryOneFn(
        'SELECT COUNT(*) AS usos FROM `FinTransacao` WHERE `categoria_pessoal_id` = ? AND `empresa_id` = ?',
        [req.params.id, empresaId]
      );
      if ((usos?.usos || 0) > 0) throw ERR.CONFLICT('Categoria em uso. Desative em vez de excluir.');
      const conn = await poolRef.getConnection();
      try {
        await conn.beginTransaction();
        const snapshot = await snapshotLinha(conn, 'FinCategoriaPessoal', req.params.id, empresaId);
        if (!snapshot || snapshot.user_id !== personalUserId(req)) throw ERR.NOT_FOUND('Categoria nao encontrada.');
        const [r] = await conn.execute(
          'DELETE FROM `FinCategoriaPessoal` WHERE `id` = ? AND `empresa_id` = ? AND `user_id` = ?',
          [req.params.id, empresaId, personalUserId(req)]
        );
        if (!r.affectedRows) throw ERR.NOT_FOUND('Categoria nao encontrada.');
        await registrarExclusao(conn, {
          grupoId: novoGrupo(), entidade: 'categoria_pessoal', entidadeId: req.params.id,
          empresaId, escopo: 'pessoal', estrategia: 'snapshot', snapshot,
          rotulo: snapshot.nome || null, req
        });
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      res.json({ ok: true });
      return;
    }
    const usos = await queryOneFn(
      `SELECT (
         (SELECT COUNT(*) FROM \`FinTransacao\`    WHERE \`categoria_id\` = ? AND \`empresa_id\` = ?) +
         (SELECT COUNT(*) FROM \`FinOrcamento\`    WHERE \`categoria_id\` = ? AND \`empresa_id\` = ?) +
         (SELECT COUNT(*) FROM \`FinContaPagar\`   WHERE \`categoria_id\` = ? AND \`empresa_id\` = ?) +
         (SELECT COUNT(*) FROM \`FinContaReceber\` WHERE \`categoria_id\` = ? AND \`empresa_id\` = ?)
       ) AS usos`,
      [
        req.params.id, empresaId, req.params.id, empresaId,
        req.params.id, empresaId, req.params.id, empresaId
      ]
    );
    if ((usos?.usos || 0) > 0) throw ERR.CONFLICT('Categoria em uso. Desative em vez de excluir.');

    // Usuário comum só exclui as próprias + compartilhadas; admin exclui qualquer uma.
    const isAdmin = req.financeUser?.role === 'admin';
    let where = '`id` = ? AND `empresa_id` = ?';
    const tail = [req.params.id, empresaId];
    if (!isAdmin) { where += ' AND (`user_id` = ? OR `user_id` IS NULL)'; tail.push(req.financeUser?.id ?? null); }

    const conn = await poolRef.getConnection();
    try {
      await conn.beginTransaction();
      const snapshot = await snapshotLinha(conn, 'FinCategoria', req.params.id, empresaId);
      if (!snapshot) throw ERR.NOT_FOUND('Categoria nao encontrada.');
      if (!isAdmin && !(snapshot.user_id === (req.financeUser?.id ?? null) || snapshot.user_id == null)) {
        throw ERR.NOT_FOUND('Categoria nao encontrada.');
      }
      const [r] = await conn.execute(`DELETE FROM \`FinCategoria\` WHERE ${where}`, tail);
      if (!r.affectedRows) throw ERR.NOT_FOUND('Categoria nao encontrada.');
      await registrarExclusao(conn, {
        grupoId: novoGrupo(), entidade: 'categoria', entidadeId: req.params.id,
        empresaId, estrategia: 'snapshot', snapshot,
        rotulo: snapshot.nome || null, req
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
