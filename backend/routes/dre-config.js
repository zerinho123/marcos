// ============================================================================
// routes/dre-config.js — DRE editável POR USUÁRIO (Fase 1)
// ----------------------------------------------------------------------------
// Escopo (dreScope): '' = template da empresa; <adminId> = DRE pessoal do admin.
// Leitura: qualquer autenticado (comum só enxerga o template). Escrita: admin
// only (requireFinanceAdmin) — carimba o user_id do escopo resolvido.
// Estrutura (linhas), mapa categoria→linha (FinDreUserMapa), metas/projetado+ajuste
// e layout de colunas (FinDreUserConfig) são todos por escopo.
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query, queryOne, getConnection } from '../db.js';
import { wrap, requireFields, enumOr, parseDecimal, parseMonth, resolveFinanceEmpresa, dreScope } from './_common.js';
import { ERR } from '../security/errors.js';
import { ensureFinanceDreLinhasSeeded, ensureFinanceDreUserSeeded, DRE_SECOES } from './_dre-linhas-seed.js';
import {
  ensureFinanceDreFormulasSeeded, validateFormula, topoOrderFormulas, SECTION_KEYS, SECTION_ROWS
} from './_dre-formula.js';

// Colunas configuráveis do DRE (a coluna "Linha" é sempre visível e não entra aqui).
export const DRE_COLUNAS = [
  'realizado', 'ajuste', 'unit', 'pct', 'projetado', 'delta',
  'total12', 'total12_pct', 'media12', 'media12_pct'
];

// Valida/normaliza o JSON de layout. Sem eval: só chaves conhecidas (whitelist).
export function validateDreConfig(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw ERR.VALIDATION('config deve ser um objeto.');
  }
  const out = {};
  if (raw.columns !== undefined) {
    if (!Array.isArray(raw.columns)) throw ERR.VALIDATION('columns deve ser array.');
    const seen = new Set();
    out.columns = raw.columns.map((c) => {
      const key = String(c?.key || '');
      if (!DRE_COLUNAS.includes(key)) throw ERR.VALIDATION('coluna desconhecida: ' + key);
      if (seen.has(key)) throw ERR.VALIDATION('coluna duplicada: ' + key);
      seen.add(key);
      return { key, visible: c?.visible !== false };
    });
  }
  if (raw.sectionOrder !== undefined) {
    if (!Array.isArray(raw.sectionOrder)) throw ERR.VALIDATION('sectionOrder deve ser array.');
    out.sectionOrder = raw.sectionOrder.map((s) => {
      const v = String(s);
      if (!DRE_SECOES.includes(v)) throw ERR.VALIDATION('secao desconhecida: ' + v);
      return v;
    });
  }
  return out;
}

export function buildDreConfigRouter({
  requireFinanceAdmin, queryFn, queryOneFn, getConnectionFn, ensureSeedFn
} = {}) {
  const router = Router();
  const adminGate = requireFinanceAdmin || ((_req, _res, next) => next());
  // Injeção opcional p/ teste (default: db real + seeds reais).
  const q = queryFn || query;
  const q1 = queryOneFn || queryOne;
  const getConn = getConnectionFn || getConnection;
  const ensureSeed = ensureSeedFn || (async (empresaId, userId) => {
    await ensureFinanceDreLinhasSeeded(empresaId);
    await ensureFinanceDreUserSeeded(empresaId, userId);
    await ensureFinanceDreFormulasSeeded(empresaId, userId);
  });

  // Carrega as linhas-computed do escopo já com os termos parseados.
  async function loadFormulas(empresaId, userId) {
    const rows = await q(
      'SELECT `id`, `chave`, `nome`, `formula`, `formato`, `oculto`, `ordem` FROM `FinDreFormula` WHERE `empresa_id` = ? AND `user_id` = ? AND `ativo` = 1 ORDER BY `ordem`',
      [empresaId, userId]
    );
    return rows.map((r) => {
      let terms = [];
      try { terms = JSON.parse(r.formula)?.terms || []; } catch { terms = []; }
      return { id: r.id, chave: r.chave, nome: r.nome, formato: r.formato, oculto: Number(r.oculto), ordem: Number(r.ordem), terms };
    });
  }

  // Resolve empresa + escopo (user_id) e garante a estrutura semeada.
  async function scopeOf(req) {
    const empresaId = resolveFinanceEmpresa(req);
    const userId = dreScope(req);
    await ensureSeed(empresaId, userId);
    return { empresaId, userId };
  }

  // GET /estrutura — linhas do escopo + categorias com o mapa do escopo.
  router.get('/estrutura', wrap(async (req, res) => {
    const { empresaId, userId } = await scopeOf(req);
    const linhas = await q(
      'SELECT `id`, `secao`, `nome`, `ordem`, `ativo` FROM `FinDreLinha` WHERE `empresa_id` = ? AND `user_id` = ? ORDER BY `secao`, `ordem`, `nome`',
      [empresaId, userId]
    );
    const categorias = await q(
      `SELECT c.\`id\`, c.\`nome\`, c.\`tipo\`, c.\`dre_secao\`, m.\`linha_id\` AS dre_linha_id, c.\`ativo\`
         FROM \`FinCategoria\` c
         LEFT JOIN \`FinDreUserMapa\` m
           ON m.\`categoria_id\` = c.\`id\` AND m.\`empresa_id\` = c.\`empresa_id\` AND m.\`user_id\` = ?
        WHERE c.\`empresa_id\` = ?
        ORDER BY c.\`nome\``,
      [userId, empresaId]
    );
    const formulas = await loadFormulas(empresaId, userId);
    // Catálogo de referências p/ o construtor guiado (seções + linhas-computed).
    const refs = {
      secoes: SECTION_ROWS.map((s) => ({ key: 'sec:' + s.secao, label: s.nome })),
      rows: formulas.map((f) => ({ key: 'row:' + f.chave, label: f.nome }))
    };
    res.json({ secoes: DRE_SECOES, linhas, categorias, formulas, refs });
  }));

  // GET /config — layout de colunas/ordem do escopo (default: vazio = tudo visível).
  router.get('/config', wrap(async (req, res) => {
    const { empresaId, userId } = await scopeOf(req);
    const row = await q1(
      'SELECT `config` FROM `FinDreUserConfig` WHERE `empresa_id` = ? AND `user_id` = ?',
      [empresaId, userId]
    );
    let config = {};
    if (row?.config) { try { config = JSON.parse(row.config); } catch { config = {}; } }
    res.json({ colunas: DRE_COLUNAS, config });
  }));

  // PUT /config — salva o layout do escopo (admin). Valida contra a whitelist.
  router.put('/config', adminGate, wrap(async (req, res) => {
    const { empresaId, userId } = await scopeOf(req);
    const clean = validateDreConfig(req.body?.config ?? req.body ?? {});
    await q(
      `INSERT INTO \`FinDreUserConfig\` (\`empresa_id\`, \`user_id\`, \`config\`)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE \`config\` = VALUES(\`config\`), \`updatedAt\` = NOW(3)`,
      [empresaId, userId, JSON.stringify(clean)]
    );
    res.json({ ok: true, config: clean });
  }));

  // POST /linhas — cria linha de detalhe no escopo.
  router.post('/linhas', adminGate, wrap(async (req, res) => {
    requireFields(req.body, ['secao', 'nome']);
    const { empresaId, userId } = await scopeOf(req);
    const secao = enumOr(req.body.secao, DRE_SECOES, 'secao');
    const nome = String(req.body.nome).trim();
    if (!nome) throw ERR.VALIDATION('Nome obrigatorio.');

    let ordem = Number(req.body.ordem);
    if (!Number.isFinite(ordem)) {
      const row = await q1(
        'SELECT COALESCE(MAX(`ordem`), -1) AS m FROM `FinDreLinha` WHERE `empresa_id` = ? AND `user_id` = ? AND `secao` = ?',
        [empresaId, userId, secao]
      );
      ordem = Number(row?.m ?? -1) + 1;
    }

    const id = randomUUID();
    await q(
      'INSERT INTO `FinDreLinha` (`id`, `empresa_id`, `user_id`, `secao`, `nome`, `ordem`, `ativo`) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [id, empresaId, userId, secao, nome, ordem]
    );
    res.status(201).json({ id });
  }));

  // PUT /linhas/:id — renomear / mover de seção / reordenar / ativar (no escopo).
  router.put('/linhas/:id', adminGate, wrap(async (req, res) => {
    const { empresaId, userId } = await scopeOf(req);
    if (req.body.secao) enumOr(req.body.secao, DRE_SECOES, 'secao');
    const nome = req.body.nome != null ? String(req.body.nome).trim() : null;
    const ordem = Number.isFinite(Number(req.body.ordem)) ? Number(req.body.ordem) : null;
    const ativo = req.body.ativo == null ? null : (req.body.ativo ? 1 : 0);

    const r = await q(
      `UPDATE \`FinDreLinha\`
          SET \`secao\` = COALESCE(?, \`secao\`),
              \`nome\`  = COALESCE(?, \`nome\`),
              \`ordem\` = COALESCE(?, \`ordem\`),
              \`ativo\` = COALESCE(?, \`ativo\`),
              \`updatedAt\` = NOW(3)
        WHERE \`id\` = ? AND \`empresa_id\` = ? AND \`user_id\` = ?`,
      [req.body.secao || null, nome, ordem, ativo, req.params.id, empresaId, userId]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Linha nao encontrada.');
    res.json({ ok: true });
  }));

  // DELETE /linhas/:id — remove a linha do escopo + o mapa dela (metas cascateiam por FK).
  router.delete('/linhas/:id', adminGate, wrap(async (req, res) => {
    const { empresaId, userId } = await scopeOf(req);
    const r = await q(
      'DELETE FROM `FinDreLinha` WHERE `id` = ? AND `empresa_id` = ? AND `user_id` = ?',
      [req.params.id, empresaId, userId]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Linha nao encontrada.');
    // FinDreUserMapa não tem FK → limpa o mapeamento órfão do escopo.
    await q(
      'DELETE FROM `FinDreUserMapa` WHERE `empresa_id` = ? AND `user_id` = ? AND `linha_id` = ?',
      [empresaId, userId, req.params.id]
    );
    res.json({ ok: true });
  }));

  // PUT /meta — upsert do projetado de uma linha num mês (no escopo).
  router.put('/meta', adminGate, wrap(async (req, res) => {
    requireFields(req.body, ['linha_id', 'mes']);
    const { empresaId, userId } = await scopeOf(req);
    const mes = parseMonth(req.body.mes);
    const valor = parseDecimal(req.body.valor, { allowZero: true });

    const linha = await q1(
      'SELECT `id` FROM `FinDreLinha` WHERE `id` = ? AND `empresa_id` = ? AND `user_id` = ?',
      [req.body.linha_id, empresaId, userId]
    );
    if (!linha) throw ERR.NOT_FOUND('Linha nao encontrada.');

    await q(
      `INSERT INTO \`FinDreMeta\` (\`empresa_id\`, \`user_id\`, \`linha_id\`, \`mes\`, \`valor\`)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`valor\` = VALUES(\`valor\`), \`updatedAt\` = NOW(3)`,
      [empresaId, userId, req.body.linha_id, mes, valor]
    );
    res.json({ ok: true, valor: valor.toFixed(2) });
  }));

  // PUT /valores — upsert em lote do projetado + ajuste manual (no escopo). Atômico.
  router.put('/valores', adminGate, wrap(async (req, res) => {
    const { empresaId, userId } = await scopeOf(req);
    const mes = parseMonth(req.body?.mes);
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : null;
    if (!updates || !updates.length) throw ERR.VALIDATION('Lista de atualizacoes vazia.');
    if (updates.length > 500) throw ERR.VALIDATION('Limite de 500 itens por requisicao.');

    // Normaliza/valida tudo antes de tocar o banco. ajuste_real pode ser negativo
    // (correção para baixo); valor (projetado) é magnitude >= 0.
    const norm = updates.map((u) => {
      if (!u || !u.linha_id) throw ERR.VALIDATION('linha_id obrigatorio em cada item.');
      return {
        linha_id: String(u.linha_id),
        valor: parseDecimal(u.plano ?? 0, { allowZero: true }),
        ajuste: parseDecimal(u.ajuste_real ?? 0, { allowZero: true })
      };
    });

    // Isolamento: todas as linhas precisam ser do escopo (empresa + user_id).
    const ids = [...new Set(norm.map((u) => u.linha_id))];
    const placeholders = ids.map(() => '?').join(',');
    const rows = await q(
      `SELECT \`id\` FROM \`FinDreLinha\` WHERE \`empresa_id\` = ? AND \`user_id\` = ? AND \`id\` IN (${placeholders})`,
      [empresaId, userId, ...ids]
    );
    const validos = new Set(rows.map((r) => String(r.id)));
    const invalido = ids.find((id) => !validos.has(id));
    if (invalido) throw ERR.NOT_FOUND('Linha nao encontrada: ' + invalido);

    const updatedBy = req.financeUser?.id || null;
    const conn = await getConn();
    try {
      await conn.beginTransaction();
      for (const u of norm) {
        await conn.execute(
          `INSERT INTO \`FinDreMeta\` (\`empresa_id\`, \`user_id\`, \`linha_id\`, \`mes\`, \`valor\`, \`ajuste_real\`, \`updated_by\`)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE \`valor\` = VALUES(\`valor\`),
                                   \`ajuste_real\` = VALUES(\`ajuste_real\`),
                                   \`updated_by\` = VALUES(\`updated_by\`),
                                   \`updatedAt\` = NOW(3)`,
          [empresaId, userId, u.linha_id, mes, u.valor, u.ajuste, updatedBy]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ ok: true, count: norm.length });
  }));

  // PUT /mapa — mapeia categoria→linha no escopo (linha_id null/ausente = desmapeia).
  router.put('/mapa', adminGate, wrap(async (req, res) => {
    requireFields(req.body, ['categoria_id']);
    const { empresaId, userId } = await scopeOf(req);
    const categoriaId = String(req.body.categoria_id);
    const linhaId = req.body.linha_id || null;

    if (!linhaId) {
      await q(
        'DELETE FROM `FinDreUserMapa` WHERE `empresa_id` = ? AND `user_id` = ? AND `categoria_id` = ?',
        [empresaId, userId, categoriaId]
      );
      return res.json({ ok: true });
    }

    const linha = await q1(
      'SELECT `id` FROM `FinDreLinha` WHERE `id` = ? AND `empresa_id` = ? AND `user_id` = ?',
      [linhaId, empresaId, userId]
    );
    if (!linha) throw ERR.NOT_FOUND('Linha nao encontrada.');

    await q(
      `INSERT INTO \`FinDreUserMapa\` (\`empresa_id\`, \`user_id\`, \`categoria_id\`, \`linha_id\`)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`linha_id\` = VALUES(\`linha_id\`), \`updatedAt\` = NOW(3)`,
      [empresaId, userId, categoriaId, linhaId]
    );
    res.json({ ok: true });
  }));

  // ── Linhas de total com fórmula editável (Fase 2) ────────────────────────
  // POST /formulas — cria linha-computed no escopo.
  router.post('/formulas', adminGate, wrap(async (req, res) => {
    requireFields(req.body, ['nome']);
    const { empresaId, userId } = await scopeOf(req);
    const nome = String(req.body.nome).trim();
    if (!nome) throw ERR.VALIDATION('Nome obrigatorio.');
    const rowsNow = await loadFormulas(empresaId, userId);
    const rowKeys = new Set(rowsNow.map((r) => r.chave));
    const inputTerms = req.body?.formula?.terms ?? req.body?.terms ?? [];
    const terms = validateFormula(inputTerms, { sectionKeys: SECTION_KEYS, rowKeys });
    const chave = 'c_' + randomUUID().slice(0, 8);
    topoOrderFormulas([...rowsNow, { chave, terms }]); // sanidade (ciclo)
    const formato = req.body?.formato === 'percent' ? 'percent' : 'currency';
    const oculto = req.body?.oculto ? 1 : 0;
    const maxOrdem = rowsNow.reduce((m, r) => Math.max(m, r.ordem), 0);
    const ordem = Number.isFinite(Number(req.body?.ordem)) ? Number(req.body.ordem) : maxOrdem + 10;
    const id = randomUUID();
    await q(
      `INSERT INTO \`FinDreFormula\` (\`id\`,\`empresa_id\`,\`user_id\`,\`chave\`,\`nome\`,\`formula\`,\`formato\`,\`oculto\`,\`ordem\`,\`ativo\`)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
      [id, empresaId, userId, chave, nome, JSON.stringify({ terms }), formato, oculto, ordem]
    );
    res.status(201).json({ id, chave });
  }));

  // PUT /formulas/:id — edita nome/fórmula/ordem/oculto/formato no escopo.
  router.put('/formulas/:id', adminGate, wrap(async (req, res) => {
    const { empresaId, userId } = await scopeOf(req);
    const rowsNow = await loadFormulas(empresaId, userId);
    const alvo = rowsNow.find((r) => r.id === req.params.id);
    if (!alvo) throw ERR.NOT_FOUND('Linha de total nao encontrada.');

    const nome = req.body.nome != null ? String(req.body.nome).trim() : null;
    const ordem = Number.isFinite(Number(req.body.ordem)) ? Number(req.body.ordem) : null;
    const oculto = req.body.oculto == null ? null : (req.body.oculto ? 1 : 0);
    const formato = req.body.formato === 'percent' ? 'percent'
      : (req.body.formato === 'currency' ? 'currency' : null);

    let formulaJson = null;
    if (req.body.formula !== undefined || req.body.terms !== undefined) {
      const rowKeys = new Set(rowsNow.map((r) => r.chave)); // inclui a própria → self-ref vira ciclo
      const inputTerms = req.body?.formula?.terms ?? req.body?.terms ?? [];
      const terms = validateFormula(inputTerms, { sectionKeys: SECTION_KEYS, rowKeys });
      const updated = rowsNow.map((r) => (r.id === alvo.id ? { ...r, terms } : r));
      topoOrderFormulas(updated); // lança se criar ciclo
      formulaJson = JSON.stringify({ terms });
    }

    const r = await q(
      `UPDATE \`FinDreFormula\`
          SET \`nome\` = COALESCE(?, \`nome\`),
              \`formula\` = COALESCE(?, \`formula\`),
              \`formato\` = COALESCE(?, \`formato\`),
              \`oculto\` = COALESCE(?, \`oculto\`),
              \`ordem\` = COALESCE(?, \`ordem\`),
              \`updatedAt\` = NOW(3)
        WHERE \`id\` = ? AND \`empresa_id\` = ? AND \`user_id\` = ?`,
      [nome, formulaJson, formato, oculto, ordem, alvo.id, empresaId, userId]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Linha de total nao encontrada.');
    res.json({ ok: true });
  }));

  // DELETE /formulas/:id — remove a linha-computed do escopo.
  router.delete('/formulas/:id', adminGate, wrap(async (req, res) => {
    const { empresaId, userId } = await scopeOf(req);
    const r = await q(
      'DELETE FROM `FinDreFormula` WHERE `id` = ? AND `empresa_id` = ? AND `user_id` = ?',
      [req.params.id, empresaId, userId]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Linha de total nao encontrada.');
    res.json({ ok: true });
  }));

  return router;
}
