import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne } from '../db.js';
import { wrap, enumOr, resolveFinanceEmpresa } from './_common.js';
import { ERR } from '../security/errors.js';
import { calculatePricing, PricingValidationError } from '../pricing/calc.js';

const ITEM_TYPES = ['produto', 'servico'];
const RATEIO_TYPES = ['percentual', 'fixo'];
const DEFAULT_CONFIG = {
  impostos_pct: 0,
  comissao_pct: 0,
  despesas_variaveis_pct: 0,
  margem_padrao_pct: 20,
  rateio_tipo: 'percentual',
  rateio_valor: 0
};

function text(value, field, max = 191, { required = true } = {}) {
  const parsed = String(value ?? '').trim();
  if (required && !parsed) throw ERR.VALIDATION(`${field} obrigatorio.`);
  if (parsed.length > max) throw ERR.VALIDATION(`${field} deve ter no maximo ${max} caracteres.`);
  return parsed || null;
}

function numeric(value, field, { min = 0, max = null } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (max !== null && parsed > max)) {
    throw ERR.VALIDATION(`${field} invalido.`);
  }
  return parsed;
}

function configPayload(body = {}) {
  return {
    impostos_pct: numeric(body.impostos_pct ?? 0, 'impostos_pct', { max: 100 }),
    comissao_pct: numeric(body.comissao_pct ?? 0, 'comissao_pct', { max: 100 }),
    despesas_variaveis_pct: numeric(body.despesas_variaveis_pct ?? 0, 'despesas_variaveis_pct', { max: 100 }),
    margem_padrao_pct: numeric(body.margem_padrao_pct ?? 20, 'margem_padrao_pct', { max: 100 }),
    rateio_tipo: enumOr(body.rateio_tipo ?? 'percentual', RATEIO_TYPES, 'rateio_tipo'),
    rateio_valor: numeric(body.rateio_valor ?? 0, 'rateio_valor')
  };
}

function mapNumbers(row) {
  if (!row) return row;
  const decimalFields = [
    'impostos_pct', 'comissao_pct', 'despesas_variaveis_pct', 'margem_padrao_pct',
    'rateio_valor', 'custo_direto', 'custo_hora', 'quantidade', 'custo_unitario',
    'perda_pct', 'custo_total', 'custo_ajuste_pct', 'margem_alvo_pct',
    'custo_direto_ajustado', 'rateio', 'custo_base', 'preco_minimo',
    'preco_sugerido', 'margem_resultante_pct'
  ];
  const result = { ...row };
  decimalFields.forEach((field) => {
    if (result[field] !== undefined && result[field] !== null) result[field] = Number(result[field]);
  });
  if (result.ativo !== undefined) result.ativo = Boolean(result.ativo);
  return result;
}

async function ensureConfig(empresaId, queryFn = query) {
  await queryFn(
    `INSERT IGNORE INTO \`FinPrecificacaoConfig\`
       (\`empresa_id\`,\`impostos_pct\`,\`comissao_pct\`,\`despesas_variaveis_pct\`,\`margem_padrao_pct\`,\`rateio_tipo\`,\`rateio_valor\`)
     VALUES (?,0,0,0,20,'percentual',0)`,
    [empresaId]
  );
}

async function assertCategory(empresaId, categoryId, queryOneFn = queryOne) {
  if (!categoryId) return null;
  const category = await queryOneFn(
    'SELECT `id` FROM `FinPrecificacaoCategoria` WHERE `id` = ? AND `empresa_id` = ? AND `ativo` = 1',
    [categoryId, empresaId]
  );
  if (!category) throw ERR.VALIDATION('Categoria comercial invalida.');
  return categoryId;
}

function sqlDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw ERR.VALIDATION('vigencia_inicio invalida.');
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function pricingError(error) {
  if (error instanceof PricingValidationError) {
    return ERR.VALIDATION(error.message, error.field ? { field: error.field } : undefined);
  }
  return error;
}

async function loadVersion(empresaId, versionId, queryOneFn = queryOne, queryFn = query) {
  const version = await queryOneFn(
    `SELECT v.*, i.\`tipo\` AS \`tipo_item\`, i.\`nome\` AS \`item_nome\`
       FROM \`FinPrecificacaoVersao\` v
       JOIN \`FinPrecificacaoItem\` i ON i.\`id\` = v.\`item_id\` AND i.\`empresa_id\` = v.\`empresa_id\`
      WHERE v.\`id\` = ? AND v.\`empresa_id\` = ?`,
    [versionId, empresaId]
  );
  if (!version) throw ERR.NOT_FOUND('Versao de precificacao nao encontrada.');
  const [components, ranges] = await Promise.all([
    queryFn('SELECT * FROM `FinPrecificacaoComponente` WHERE `versao_id` = ? AND `empresa_id` = ? ORDER BY `ordem`', [versionId, empresaId]),
    queryFn('SELECT * FROM `FinPrecificacaoFaixa` WHERE `versao_id` = ? AND `empresa_id` = ? ORDER BY `ordem`', [versionId, empresaId])
  ]);
  return {
    ...mapNumbers(version),
    componentes: components.map(mapNumbers),
    faixas: ranges.map(mapNumbers)
  };
}

async function authoritativeComponents(empresaId, components, queryFn = query) {
  const functionIds = [...new Set((components || []).map((c) => c.funcao_id).filter(Boolean))];
  if (!functionIds.length) return components || [];
  const placeholders = functionIds.map(() => '?').join(',');
  const rows = await queryFn(
    `SELECT \`id\`,\`nome\`,\`custo_hora\` FROM \`FinPrecificacaoFuncao\`
      WHERE \`empresa_id\` = ? AND \`ativo\` = 1 AND \`id\` IN (${placeholders})`,
    [empresaId, ...functionIds]
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== functionIds.length) throw ERR.VALIDATION('Funcao de custo invalida ou de outra empresa.');
  return components.map((component) => {
    if (!component.funcao_id) return component;
    const fn = byId.get(component.funcao_id);
    return { ...component, nome: component.nome || fn.nome, custo_unitario: Number(fn.custo_hora) };
  });
}

export function buildPrecificacaoRouter({
  requireFinanceAdmin,
  queryFn = query,
  queryOneFn = queryOne,
  poolRef = pool
} = {}) {
  const router = Router();
  const admin = requireFinanceAdmin || ((_req, _res, next) => next(ERR.FORBIDDEN()));

  router.get('/config', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    await ensureConfig(empresaId, queryFn);
    res.json(mapNumbers(await queryOneFn('SELECT * FROM `FinPrecificacaoConfig` WHERE `empresa_id` = ?', [empresaId])));
  }));

  router.put('/config', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const values = configPayload(req.body);
    if (values.impostos_pct + values.comissao_pct + values.despesas_variaveis_pct + values.margem_padrao_pct >= 100) {
      throw ERR.VALIDATION('Encargos e margem padrao devem somar menos que 100%.');
    }
    await queryFn(
      `INSERT INTO \`FinPrecificacaoConfig\`
       (\`empresa_id\`,\`impostos_pct\`,\`comissao_pct\`,\`despesas_variaveis_pct\`,\`margem_padrao_pct\`,\`rateio_tipo\`,\`rateio_valor\`,\`updated_by\`)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE \`impostos_pct\`=VALUES(\`impostos_pct\`),\`comissao_pct\`=VALUES(\`comissao_pct\`),
       \`despesas_variaveis_pct\`=VALUES(\`despesas_variaveis_pct\`),\`margem_padrao_pct\`=VALUES(\`margem_padrao_pct\`),
       \`rateio_tipo\`=VALUES(\`rateio_tipo\`),\`rateio_valor\`=VALUES(\`rateio_valor\`),
       \`updated_by\`=VALUES(\`updated_by\`),\`updatedAt\`=NOW(3)`,
      [empresaId, values.impostos_pct, values.comissao_pct, values.despesas_variaveis_pct,
        values.margem_padrao_pct, values.rateio_tipo, values.rateio_valor, req.financeUser.id]
    );
    res.json({ ok: true });
  }));

  router.get('/categorias', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    res.json((await queryFn(
      'SELECT * FROM `FinPrecificacaoCategoria` WHERE `empresa_id` = ? ORDER BY `ativo` DESC, `nome`', [empresaId]
    )).map(mapNumbers));
  }));

  router.post('/categorias', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const id = randomUUID();
    await queryFn(
      'INSERT INTO `FinPrecificacaoCategoria` (`id`,`empresa_id`,`nome`) VALUES (?,?,?)',
      [id, empresaId, text(req.body.nome, 'nome', 120)]
    );
    res.status(201).json({ id });
  }));

  router.put('/categorias/:id', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const result = await queryFn(
      'UPDATE `FinPrecificacaoCategoria` SET `nome`=COALESCE(?,`nome`),`ativo`=COALESCE(?,`ativo`),`updatedAt`=NOW(3) WHERE `id`=? AND `empresa_id`=?',
      [req.body.nome == null ? null : text(req.body.nome, 'nome', 120), req.body.ativo == null ? null : (req.body.ativo ? 1 : 0), req.params.id, empresaId]
    );
    if (!result.affectedRows) throw ERR.NOT_FOUND('Categoria comercial nao encontrada.');
    res.json({ ok: true });
  }));

  router.delete('/categorias/:id', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const used = await queryOneFn('SELECT `id` FROM `FinPrecificacaoItem` WHERE `categoria_id`=? AND `empresa_id`=? LIMIT 1', [req.params.id, empresaId]);
    if (used) throw ERR.CONFLICT('Categoria em uso. Desative em vez de excluir.');
    const result = await queryFn('DELETE FROM `FinPrecificacaoCategoria` WHERE `id`=? AND `empresa_id`=?', [req.params.id, empresaId]);
    if (!result.affectedRows) throw ERR.NOT_FOUND('Categoria comercial nao encontrada.');
    res.json({ ok: true });
  }));

  router.get('/funcoes', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    res.json((await queryFn('SELECT * FROM `FinPrecificacaoFuncao` WHERE `empresa_id`=? ORDER BY `ativo` DESC,`nome`', [empresaId])).map(mapNumbers));
  }));

  router.post('/funcoes', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const id = randomUUID();
    await queryFn('INSERT INTO `FinPrecificacaoFuncao` (`id`,`empresa_id`,`nome`,`custo_hora`) VALUES (?,?,?,?)', [
      id, empresaId, text(req.body.nome, 'nome', 120), numeric(req.body.custo_hora, 'custo_hora')
    ]);
    res.status(201).json({ id });
  }));

  router.put('/funcoes/:id', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const result = await queryFn(
      'UPDATE `FinPrecificacaoFuncao` SET `nome`=COALESCE(?,`nome`),`custo_hora`=COALESCE(?,`custo_hora`),`ativo`=COALESCE(?,`ativo`),`updatedAt`=NOW(3) WHERE `id`=? AND `empresa_id`=?',
      [req.body.nome == null ? null : text(req.body.nome, 'nome', 120), req.body.custo_hora == null ? null : numeric(req.body.custo_hora, 'custo_hora'), req.body.ativo == null ? null : (req.body.ativo ? 1 : 0), req.params.id, empresaId]
    );
    if (!result.affectedRows) throw ERR.NOT_FOUND('Funcao nao encontrada.');
    res.json({ ok: true });
  }));

  router.delete('/funcoes/:id', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const used = await queryOneFn('SELECT `id` FROM `FinPrecificacaoComponente` WHERE `funcao_id`=? AND `empresa_id`=? LIMIT 1', [req.params.id, empresaId]);
    if (used) throw ERR.CONFLICT('Funcao em uso. Desative em vez de excluir.');
    const result = await queryFn('DELETE FROM `FinPrecificacaoFuncao` WHERE `id`=? AND `empresa_id`=?', [req.params.id, empresaId]);
    if (!result.affectedRows) throw ERR.NOT_FOUND('Funcao nao encontrada.');
    res.json({ ok: true });
  }));

  router.get('/itens', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const params = [empresaId];
    let where = 'i.`empresa_id` = ?';
    if (req.query.tipo) { where += ' AND i.`tipo` = ?'; params.push(enumOr(req.query.tipo, ITEM_TYPES, 'tipo')); }
    if (req.query.ativo !== undefined) { where += ' AND i.`ativo` = ?'; params.push(['1', 'true'].includes(String(req.query.ativo)) ? 1 : 0); }
    if (req.query.busca) { where += ' AND (i.`nome` LIKE ? OR i.`codigo` LIKE ?)'; const q = `%${String(req.query.busca).slice(0, 100)}%`; params.push(q, q); }
    const rows = await queryFn(
      `SELECT i.*, c.\`nome\` AS \`categoria_nome\`,
        (SELECT v.\`id\` FROM \`FinPrecificacaoVersao\` v WHERE v.\`item_id\`=i.\`id\` AND v.\`empresa_id\`=i.\`empresa_id\` AND v.\`status\`='publicada' AND v.\`vigencia_inicio\`<=UTC_TIMESTAMP(3) ORDER BY v.\`vigencia_inicio\` DESC LIMIT 1) AS \`versao_vigente_id\`,
        (SELECT f.\`preco_sugerido\` FROM \`FinPrecificacaoFaixa\` f JOIN \`FinPrecificacaoVersao\` v ON v.\`id\`=f.\`versao_id\` WHERE v.\`item_id\`=i.\`id\` AND v.\`empresa_id\`=i.\`empresa_id\` AND v.\`status\`='publicada' AND v.\`vigencia_inicio\`<=UTC_TIMESTAMP(3) AND f.\`quantidade_min\`=1 ORDER BY v.\`vigencia_inicio\` DESC LIMIT 1) AS \`preco_vigente\`,
        (SELECT v.\`vigencia_inicio\` FROM \`FinPrecificacaoVersao\` v WHERE v.\`item_id\`=i.\`id\` AND v.\`empresa_id\`=i.\`empresa_id\` AND v.\`status\`='publicada' AND v.\`vigencia_inicio\`>UTC_TIMESTAMP(3) ORDER BY v.\`vigencia_inicio\` ASC LIMIT 1) AS \`proxima_vigencia\`,
        (SELECT v.\`id\` FROM \`FinPrecificacaoVersao\` v WHERE v.\`item_id\`=i.\`id\` AND v.\`empresa_id\`=i.\`empresa_id\` AND v.\`status\`='rascunho' LIMIT 1) AS \`rascunho_id\`
       FROM \`FinPrecificacaoItem\` i LEFT JOIN \`FinPrecificacaoCategoria\` c ON c.\`id\`=i.\`categoria_id\` AND c.\`empresa_id\`=i.\`empresa_id\`
       WHERE ${where} ORDER BY i.\`ativo\` DESC, i.\`nome\``,
      params
    );
    res.json(rows.map(mapNumbers));
  }));

  router.post('/itens', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const categoryId = await assertCategory(empresaId, req.body.categoria_id, queryOneFn);
    const id = randomUUID();
    await queryFn(
      `INSERT INTO \`FinPrecificacaoItem\` (\`id\`,\`empresa_id\`,\`categoria_id\`,\`tipo\`,\`nome\`,\`codigo\`,\`unidade\`,\`descricao\`,\`created_by\`)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, empresaId, categoryId, enumOr(req.body.tipo, ITEM_TYPES, 'tipo'), text(req.body.nome, 'nome'),
        text(req.body.codigo, 'codigo', 80, { required: false }), text(req.body.unidade || 'unidade', 'unidade', 40),
        text(req.body.descricao, 'descricao', 5000, { required: false }), req.financeUser.id]
    );
    res.status(201).json({ id });
  }));

  router.put('/itens/:id', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const categoryId = req.body.categoria_id === undefined ? undefined : await assertCategory(empresaId, req.body.categoria_id, queryOneFn);
    const current = await queryOneFn('SELECT * FROM `FinPrecificacaoItem` WHERE `id`=? AND `empresa_id`=?', [req.params.id, empresaId]);
    if (!current) throw ERR.NOT_FOUND('Item de precificacao nao encontrado.');
    await queryFn(
      `UPDATE \`FinPrecificacaoItem\` SET \`categoria_id\`=?,\`tipo\`=?,\`nome\`=?,\`codigo\`=?,\`unidade\`=?,\`descricao\`=?,\`ativo\`=?,\`updatedAt\`=NOW(3)
        WHERE \`id\`=? AND \`empresa_id\`=?`,
      [categoryId === undefined ? current.categoria_id : categoryId, req.body.tipo ? enumOr(req.body.tipo, ITEM_TYPES, 'tipo') : current.tipo,
        req.body.nome == null ? current.nome : text(req.body.nome, 'nome'), req.body.codigo === undefined ? current.codigo : text(req.body.codigo, 'codigo', 80, { required: false }),
        req.body.unidade == null ? current.unidade : text(req.body.unidade, 'unidade', 40), req.body.descricao === undefined ? current.descricao : text(req.body.descricao, 'descricao', 5000, { required: false }),
        req.body.ativo == null ? current.ativo : (req.body.ativo ? 1 : 0), req.params.id, empresaId]
    );
    res.json({ ok: true });
  }));

  router.get('/itens/:id', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const item = await queryOneFn(
      `SELECT i.*,c.\`nome\` AS \`categoria_nome\` FROM \`FinPrecificacaoItem\` i LEFT JOIN \`FinPrecificacaoCategoria\` c ON c.\`id\`=i.\`categoria_id\` AND c.\`empresa_id\`=i.\`empresa_id\` WHERE i.\`id\`=? AND i.\`empresa_id\`=?`,
      [req.params.id, empresaId]
    );
    if (!item) throw ERR.NOT_FOUND('Item de precificacao nao encontrado.');
    const versions = (await queryFn(
      `SELECT v.*,fu.\`nome\` AS \`created_by_nome\`,fp.\`nome\` AS \`published_by_nome\` FROM \`FinPrecificacaoVersao\` v
       LEFT JOIN \`FinanceUser\` fu ON fu.\`id\`=v.\`created_by\` LEFT JOIN \`FinanceUser\` fp ON fp.\`id\`=v.\`published_by\`
       WHERE v.\`item_id\`=? AND v.\`empresa_id\`=? ORDER BY v.\`numero\` DESC`, [item.id, empresaId]
    )).map(mapNumbers);
    const bundles = [];
    for (const version of versions) bundles.push({
      ...(await loadVersion(empresaId, version.id, queryOneFn, queryFn)),
      created_by_nome: version.created_by_nome,
      published_by_nome: version.published_by_nome
    });
    res.json({ ...mapNumbers(item), versoes: bundles });
  }));

  router.post('/itens/:id/rascunho', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    await ensureConfig(empresaId, queryFn);
    const conn = await poolRef.getConnection();
    const versionId = randomUUID();
    try {
      await conn.beginTransaction();
      const [[item]] = await conn.execute('SELECT * FROM `FinPrecificacaoItem` WHERE `id`=? AND `empresa_id`=? FOR UPDATE', [req.params.id, empresaId]);
      if (!item) throw ERR.NOT_FOUND('Item de precificacao nao encontrado.');
      const [[draft]] = await conn.execute("SELECT `id` FROM `FinPrecificacaoVersao` WHERE `item_id`=? AND `empresa_id`=? AND `status`='rascunho' LIMIT 1", [item.id, empresaId]);
      if (draft) throw ERR.CONFLICT('Ja existe um rascunho para este item.');
      const [[config]] = await conn.execute('SELECT * FROM `FinPrecificacaoConfig` WHERE `empresa_id`=?', [empresaId]);
      const [[source]] = await conn.execute("SELECT * FROM `FinPrecificacaoVersao` WHERE `item_id`=? AND `empresa_id`=? AND `status`='publicada' ORDER BY `vigencia_inicio` DESC LIMIT 1", [item.id, empresaId]);
      const [[seq]] = await conn.execute('SELECT COALESCE(MAX(`numero`),0)+1 AS `numero` FROM `FinPrecificacaoVersao` WHERE `item_id`=? AND `empresa_id`=?', [item.id, empresaId]);
      const snapshot = source || config || DEFAULT_CONFIG;
      await conn.execute(
        `INSERT INTO \`FinPrecificacaoVersao\` (\`id\`,\`empresa_id\`,\`item_id\`,\`numero\`,\`status\`,\`impostos_pct\`,\`comissao_pct\`,\`despesas_variaveis_pct\`,\`margem_padrao_pct\`,\`rateio_tipo\`,\`rateio_valor\`,\`custo_direto\`,\`created_by\`)
         VALUES (?,?,?,?,'rascunho',?,?,?,?,?,?,?,?)`,
        [versionId, empresaId, item.id, seq.numero, snapshot.impostos_pct, snapshot.comissao_pct, snapshot.despesas_variaveis_pct,
          snapshot.margem_padrao_pct, snapshot.rateio_tipo, snapshot.rateio_valor, source?.custo_direto ?? null, req.financeUser.id]
      );
      if (source) {
        const [components] = await conn.execute('SELECT * FROM `FinPrecificacaoComponente` WHERE `versao_id`=? AND `empresa_id`=? ORDER BY `ordem`', [source.id, empresaId]);
        for (const component of components) await conn.execute(
          `INSERT INTO \`FinPrecificacaoComponente\` (\`id\`,\`empresa_id\`,\`versao_id\`,\`funcao_id\`,\`tipo\`,\`nome\`,\`unidade\`,\`quantidade\`,\`custo_unitario\`,\`perda_pct\`,\`custo_total\`,\`ordem\`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [randomUUID(), empresaId, versionId, component.funcao_id, component.tipo, component.nome, component.unidade, component.quantidade, component.custo_unitario, component.perda_pct, component.custo_total, component.ordem]
        );
        const [ranges] = await conn.execute('SELECT * FROM `FinPrecificacaoFaixa` WHERE `versao_id`=? AND `empresa_id`=? ORDER BY `ordem`', [source.id, empresaId]);
        for (const range of ranges) await conn.execute(
          `INSERT INTO \`FinPrecificacaoFaixa\` (\`id\`,\`empresa_id\`,\`versao_id\`,\`quantidade_min\`,\`quantidade_max\`,\`custo_ajuste_pct\`,\`margem_alvo_pct\`,\`custo_direto_ajustado\`,\`rateio\`,\`custo_base\`,\`preco_minimo\`,\`preco_sugerido\`,\`margem_resultante_pct\`,\`ordem\`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [randomUUID(), empresaId, versionId, range.quantidade_min, range.quantidade_max, range.custo_ajuste_pct, range.margem_alvo_pct, range.custo_direto_ajustado, range.rateio, range.custo_base, range.preco_minimo, range.preco_sugerido, range.margem_resultante_pct, range.ordem]
        );
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    res.status(201).json(await loadVersion(empresaId, versionId, queryOneFn, queryFn));
  }));

  router.put('/versoes/:id', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const current = await queryOneFn(
      `SELECT v.*,i.\`tipo\` AS \`tipo_item\` FROM \`FinPrecificacaoVersao\` v JOIN \`FinPrecificacaoItem\` i ON i.\`id\`=v.\`item_id\` AND i.\`empresa_id\`=v.\`empresa_id\` WHERE v.\`id\`=? AND v.\`empresa_id\`=?`,
      [req.params.id, empresaId]
    );
    if (!current) throw ERR.NOT_FOUND('Versao de precificacao nao encontrada.');
    if (current.status !== 'rascunho') throw ERR.CONFLICT('Versoes publicadas ou canceladas sao imutaveis.');
    const components = await authoritativeComponents(empresaId, req.body.componentes, queryFn);
    let calculated;
    try { calculated = calculatePricing({ ...req.body, tipo_item: current.tipo_item, componentes: components }); }
    catch (error) { throw pricingError(error); }
    const conn = await poolRef.getConnection();
    try {
      await conn.beginTransaction();
      const [[locked]] = await conn.execute('SELECT `status` FROM `FinPrecificacaoVersao` WHERE `id`=? AND `empresa_id`=? FOR UPDATE', [req.params.id, empresaId]);
      if (!locked) throw ERR.NOT_FOUND('Versao de precificacao nao encontrada.');
      if (locked.status !== 'rascunho') throw ERR.CONFLICT('O rascunho foi publicado ou cancelado por outro usuario.');
      await conn.execute(
        `UPDATE \`FinPrecificacaoVersao\` SET \`impostos_pct\`=?,\`comissao_pct\`=?,\`despesas_variaveis_pct\`=?,\`margem_padrao_pct\`=?,\`rateio_tipo\`=?,\`rateio_valor\`=?,\`custo_direto\`=?,\`updatedAt\`=NOW(3) WHERE \`id\`=? AND \`empresa_id\`=?`,
        [calculated.impostos_pct, calculated.comissao_pct, calculated.despesas_variaveis_pct, calculated.margem_padrao_pct,
          calculated.rateio_tipo, calculated.rateio_valor, calculated.custo_direto, req.params.id, empresaId]
      );
      await conn.execute('DELETE FROM `FinPrecificacaoComponente` WHERE `versao_id`=? AND `empresa_id`=?', [req.params.id, empresaId]);
      await conn.execute('DELETE FROM `FinPrecificacaoFaixa` WHERE `versao_id`=? AND `empresa_id`=?', [req.params.id, empresaId]);
      for (const [index, component] of calculated.componentes.entries()) await conn.execute(
        `INSERT INTO \`FinPrecificacaoComponente\` (\`id\`,\`empresa_id\`,\`versao_id\`,\`funcao_id\`,\`tipo\`,\`nome\`,\`unidade\`,\`quantidade\`,\`custo_unitario\`,\`perda_pct\`,\`custo_total\`,\`ordem\`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [randomUUID(), empresaId, req.params.id, component.funcao_id || null, component.tipo, component.nome, component.unidade,
          component.quantidade, component.custo_unitario, component.perda_pct, component.custo_total, index]
      );
      for (const [index, range] of calculated.faixas.entries()) await conn.execute(
        `INSERT INTO \`FinPrecificacaoFaixa\` (\`id\`,\`empresa_id\`,\`versao_id\`,\`quantidade_min\`,\`quantidade_max\`,\`custo_ajuste_pct\`,\`margem_alvo_pct\`,\`custo_direto_ajustado\`,\`rateio\`,\`custo_base\`,\`preco_minimo\`,\`preco_sugerido\`,\`margem_resultante_pct\`,\`ordem\`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [randomUUID(), empresaId, req.params.id, range.quantidade_min, range.quantidade_max, range.custo_ajuste_pct, range.margem_alvo_pct,
          range.custo_direto_ajustado, range.rateio, range.custo_base, range.preco_minimo, range.preco_sugerido, range.margem_resultante_pct, index]
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
    res.json({ ok: true, calculo: calculated });
  }));

  router.post('/simular', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const item = await queryOneFn('SELECT `id`,`tipo` FROM `FinPrecificacaoItem` WHERE `id`=? AND `empresa_id`=? AND `ativo`=1', [req.body.item_id, empresaId]);
    if (!item) throw ERR.NOT_FOUND('Item de precificacao nao encontrado.');
    const components = await authoritativeComponents(empresaId, req.body.componentes, queryFn);
    try { res.json(calculatePricing({ ...req.body, tipo_item: item.tipo, componentes: components })); }
    catch (error) { throw pricingError(error); }
  }));

  router.post('/versoes/:id/publicar', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const effectiveAt = sqlDate(req.body.vigencia_inicio);
    const conn = await poolRef.getConnection();
    try {
      await conn.beginTransaction();
      const [[version]] = await conn.execute(
        `SELECT v.*,i.\`tipo\` AS \`tipo_item\` FROM \`FinPrecificacaoVersao\` v JOIN \`FinPrecificacaoItem\` i ON i.\`id\`=v.\`item_id\` AND i.\`empresa_id\`=v.\`empresa_id\` WHERE v.\`id\`=? AND v.\`empresa_id\`=? FOR UPDATE`,
        [req.params.id, empresaId]
      );
      if (!version) throw ERR.NOT_FOUND('Versao de precificacao nao encontrada.');
      if (version.status !== 'rascunho') throw ERR.CONFLICT('Somente rascunhos podem ser publicados.');
      await conn.execute('SELECT `id` FROM `FinPrecificacaoItem` WHERE `id`=? AND `empresa_id`=? FOR UPDATE', [version.item_id, empresaId]);
      const [components] = await conn.execute('SELECT * FROM `FinPrecificacaoComponente` WHERE `versao_id`=? AND `empresa_id`=? ORDER BY `ordem`', [version.id, empresaId]);
      const [ranges] = await conn.execute('SELECT * FROM `FinPrecificacaoFaixa` WHERE `versao_id`=? AND `empresa_id`=? ORDER BY `ordem`', [version.id, empresaId]);
      try {
        calculatePricing({ ...version, tipo_item: version.tipo_item, componentes: components, faixas: ranges });
      } catch (error) { throw pricingError(error); }
      if (new Date(effectiveAt.replace(' ', 'T') + 'Z').getTime() > Date.now()) {
        const [[future]] = await conn.execute(
          "SELECT `id` FROM `FinPrecificacaoVersao` WHERE `item_id`=? AND `empresa_id`=? AND `status`='publicada' AND `vigencia_inicio`>UTC_TIMESTAMP(3) LIMIT 1 FOR UPDATE",
          [version.item_id, empresaId]
        );
        if (future) throw ERR.CONFLICT('Ja existe uma versao futura para este item. Cancele-a antes de agendar outra.');
      }
      await conn.execute(
        "UPDATE `FinPrecificacaoVersao` SET `status`='publicada',`vigencia_inicio`=?,`published_by`=?,`published_at`=UTC_TIMESTAMP(3),`updatedAt`=NOW(3) WHERE `id`=? AND `empresa_id`=?",
        [effectiveAt, req.financeUser.id, version.id, empresaId]
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
    res.json({ ok: true, vigencia_inicio: effectiveAt });
  }));

  router.post('/versoes/:id/cancelar', admin, wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const result = await queryFn(
      "UPDATE `FinPrecificacaoVersao` SET `status`='cancelada',`updatedAt`=NOW(3) WHERE `id`=? AND `empresa_id`=? AND `status`='publicada' AND `vigencia_inicio`>UTC_TIMESTAMP(3)",
      [req.params.id, empresaId]
    );
    if (!result.affectedRows) throw ERR.CONFLICT('Somente uma versao futura pode ser cancelada.');
    res.json({ ok: true });
  }));

  return router;
}
