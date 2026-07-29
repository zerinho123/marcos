// ============================================================================
// routes/dashboard-config.js — preferência de período do dashboard por escopo
// ----------------------------------------------------------------------------
// Persiste a config padrão do filtro de período do dashboard (mês corrente ou
// intervalo livre dia-a-dia), isolada por (empresa_id, user_id, escopo). Assim
// a preferência sincroniza entre dispositivos/sessões do mesmo usuário.
// Leitura e escrita: qualquer autenticado (é preferência do próprio usuário).
// ============================================================================

import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { wrap, parseDate, resolveFinanceEmpresa, resolveFinanceEscopo } from './_common.js';
import { ERR } from '../security/errors.js';

// Valida/normaliza o JSON de período. Sem eval: só chaves conhecidas.
// { tipo:'mes' } (default) OU { tipo:'custom', dataInicio, dataFim } com datas
// YYYY-MM-DD e início <= fim.
export function validateDashboardConfig(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw ERR.VALIDATION('config deve ser um objeto.');
  }
  const tipo = raw.tipo === 'custom' ? 'custom' : 'mes';
  if (tipo === 'mes') return { tipo: 'mes' };

  const dataInicio = parseDate(raw.dataInicio);
  const dataFim = parseDate(raw.dataFim);
  if (dataInicio > dataFim) {
    throw ERR.VALIDATION('dataInicio deve ser anterior ou igual a dataFim.');
  }
  return { tipo: 'custom', dataInicio, dataFim };
}

export function buildDashboardConfigRouter({ queryFn, queryOneFn } = {}) {
  const router = Router();
  const q = queryFn || query;
  const q1 = queryOneFn || queryOne;

  function scopeOf(req) {
    return {
      empresaId: resolveFinanceEmpresa(req),
      userId: String(req.financeUser?.id || ''),
      escopo: resolveFinanceEscopo(req)
    };
  }

  // GET / — período salvo do escopo (default: { tipo:'mes' } = mês corrente).
  router.get('/', wrap(async (req, res) => {
    const { empresaId, userId, escopo } = scopeOf(req);
    const row = await q1(
      'SELECT `config` FROM `FinDashboardUserConfig` WHERE `empresa_id` = ? AND `user_id` = ? AND `escopo` = ?',
      [empresaId, userId, escopo]
    );
    let config = { tipo: 'mes' };
    if (row?.config) { try { config = JSON.parse(row.config); } catch { config = { tipo: 'mes' }; } }
    res.json({ config });
  }));

  // PUT / — salva o período padrão do escopo. Valida contra a whitelist.
  router.put('/', wrap(async (req, res) => {
    const { empresaId, userId, escopo } = scopeOf(req);
    const clean = validateDashboardConfig(req.body?.config ?? req.body ?? {});
    await q(
      `INSERT INTO \`FinDashboardUserConfig\` (\`empresa_id\`, \`user_id\`, \`escopo\`, \`config\`)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`config\` = VALUES(\`config\`), \`updatedAt\` = NOW(3)`,
      [empresaId, userId, escopo, JSON.stringify(clean)]
    );
    res.json({ ok: true, config: clean });
  }));

  return router;
}
