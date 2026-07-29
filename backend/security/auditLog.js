// ============================================================================
// security/auditLog.js — trilha de auditoria (FinAuditLog)
//
// Regras de ouro:
//   - NUNCA gravar req.body: os campos sensíveis são criptografados em repouso
//     e o audit log não pode virar um vazamento em texto puro. Metadados apenas.
//   - Telemetria HTTP é best-effort. Mutação administrativa crítica usa
//     required=true dentro da mesma transação e falha de forma fechada.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { logger } from './logger.js';

const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const INSERT_SQL = `
  INSERT INTO \`FinAuditLog\`
    (\`id\`, \`empresa_id\`, \`user_id\`, \`username\`, \`role\`, \`action\`,
     \`method\`, \`path\`, \`entity\`, \`entity_id\`, \`status_code\`, \`ip\`, \`request_id\`)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const cap = (v, n) => (v == null ? null : String(v).slice(0, n));

// Heurística frouxa de id: segundo segmento do path só vira entity_id quando
// parece um identificador (>=8 chars com dígito — cobre UUID/cuid), evitando
// capturar sub-ações como /contas-pagar/:id/pagar ou /dre/plano.
function looksLikeId(seg) {
  return typeof seg === 'string' && seg.length >= 8 && /[0-9]/.test(seg);
}

// Grava um evento de auditoria. O modo padrão é best-effort; required=true
// propaga a falha para a transação chamadora.
export function logAuditEvent(fields, { queryFn = query, required = false } = {}) {
  const params = [
    randomUUID(),
    cap(fields.empresa_id, 191),
    cap(fields.user_id, 191),
    cap(fields.username, 191),
    cap(fields.role, 32),
    cap(fields.action ?? 'http', 40),
    cap(fields.method ?? '-', 8),
    cap(fields.path ?? '-', 255),
    cap(fields.entity, 64),
    cap(fields.entity_id, 191),
    Number.isFinite(fields.status_code) ? fields.status_code : null,
    cap(fields.ip, 64),
    cap(fields.request_id, 64)
  ];
  return queryFn(INSERT_SQL, params).catch((e) => {
    logger[required ? 'error' : 'warn']({
      msg: required ? 'audit log obrigatorio falhou' : 'audit log falhou (telemetria)',
      action: fields.action,
      err: e?.message
    });
    if (required) throw e;
  });
}

// Middleware de choke point: montado no router do Finance DEPOIS do
// requireFinanceAuth, então req.financeUser está sempre presente. Audita toda
// mutação (não-GET), inclusive as negadas com 4xx — tentativa também é sinal.
export function buildAuditMiddleware({ queryFn = query } = {}) {
  return function auditMiddleware(req, res, next) {
    if (SKIP_METHODS.has(req.method)) return next();
    res.on('finish', () => {
      if (req.auditHandled) return;
      const user = req.financeUser || {};
      // req.path já vem sem querystring; baseUrl = prefixo do mount.
      const relPath = req.path || '/';
      const segs = relPath.split('/').filter(Boolean);
      logAuditEvent({
        empresa_id: user.empresa_id ?? null,
        user_id: user.id ?? null,
        username: user.username ?? null,
        role: user.role ?? null,
        action: 'http',
        method: req.method,
        path: (req.baseUrl || '') + relPath,
        entity: segs[0] ?? null,
        entity_id: looksLikeId(segs[1]) ? segs[1] : null,
        status_code: res.statusCode,
        ip: req.ip,
        request_id: req.id
      }, { queryFn });
    });
    next();
  };
}
