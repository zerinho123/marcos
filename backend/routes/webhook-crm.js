// ============================================================================
// routes/webhook-crm.js — Webhook CRM → Finance (server-to-server)
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query, queryOne } from '../db.js';
import { wrap, requireFields, parseDecimal, parseDate, capText } from './_common.js';
import { ERR } from '../security/errors.js';
import { sha256Hex, encryptField } from '../security/encryption.js';
import { logAuditEvent } from '../security/auditLog.js';

function buildRequireWebhookToken(queryFn, queryOneFn) {
  return async function requireWebhookToken(req, _res, next) {
    try {
      const token = String(req.headers['x-webhook-token'] || '').trim();
      if (!token) throw ERR.UNAUTHENTICATED();
      const tokenHash = sha256Hex(token);

      // Lookup primário: por hash (token guardado de forma segura).
      let row = await queryOneFn(
        'SELECT `id`, `empresa_id` FROM `FinanceWebhookToken` WHERE `token_hash` = ? AND `ativo` = 1 LIMIT 1',
        [tokenHash]
      );

      // Fallback legado: token ainda em texto puro no banco. Valida e migra para
      // hash (apagando o texto puro) na 1ª utilização — migração lazy e idempotente.
      if (!row) {
        const legacy = await queryOneFn(
          'SELECT `id`, `empresa_id` FROM `FinanceWebhookToken` WHERE `token` = ? AND `ativo` = 1 LIMIT 1',
          [token]
        );
        if (legacy) {
          row = legacy;
          queryFn(
            'UPDATE `FinanceWebhookToken` SET `token_hash` = ?, `token` = NULL WHERE `id` = ?',
            [tokenHash, legacy.id]
          ).catch(() => {});
        }
      }

      if (!row) throw ERR.UNAUTHENTICATED();
      req.webhookEmpresaId = row.empresa_id;
      queryFn('UPDATE `FinanceWebhookToken` SET `last_used_at` = NOW(3) WHERE `id` = ?', [row.id]).catch(() => {});
      next();
    } catch (e) { next(e); }
  };
}

export function buildWebhookCrmRouter({ queryFn = query, queryOneFn = queryOne, auditFn = logAuditEvent } = {}) {
  const router = Router();
  router.use(buildRequireWebhookToken(queryFn, queryOneFn));

  router.post('/contrato', wrap(async (req, res) => {
    requireFields(req.body, ['contrato_id', 'aluno_nome', 'valor', 'vencimento']);
    const empresaId = req.webhookEmpresaId;
    const valor = parseDecimal(req.body.valor);
    const vencimento = parseDate(req.body.vencimento);
    const contratoId = String(req.body.contrato_id).trim();
    const alunoNome  = capText(req.body.aluno_nome, 150, 'aluno_nome');
    if (!alunoNome) throw ERR.VALIDATION('aluno_nome obrigatorio.');
    const alunoEmail = capText(req.body.aluno_email, 150, 'aluno_email');
    const descricao  = capText(req.body.descricao, 255, 'descricao');

    const existente = await queryOne(
      'SELECT `id` FROM `FinContaReceber` WHERE `empresa_id` = ? AND `crm_lead_id` = ? LIMIT 1',
      [empresaId, contratoId]
    );
    if (existente) return res.json({ conta_id: existente.id, criado: false });

    const id = randomUUID();
    await query(
      `INSERT INTO \`FinContaReceber\`
         (\`id\`, \`empresa_id\`, \`devedor_nome\`, \`devedor_email\`, \`valor\`,
          \`vencimento\`, \`origem\`, \`crm_lead_id\`, \`descricao\`, \`status\`)
       VALUES (?, ?, ?, ?, ?, ?, 'crm', ?, ?, 'pendente')`,
      // Campos sensíveis cifrados em repouso (mesma regra das rotas de AR).
      [id, empresaId, encryptField(alunoNome), encryptField(alunoEmail), valor, vencimento, contratoId, encryptField(descricao)]
    );
    // Auditoria: webhook fica fora do choke point do Finance (auth por token,
    // sem financeUser) — loga explicitamente, sem dados do corpo.
    auditFn({
      action: 'webhook_contrato', empresa_id: empresaId, user_id: null,
      method: 'POST', path: (req.baseUrl || '') + '/contrato',
      entity: 'contas-receber', entity_id: id, status_code: 201,
      ip: req.ip, request_id: req.id
    });
    res.status(201).json({ conta_id: id, criado: true });
  }));

  router.get('/health', (req, res) => {
    res.json({ ok: true, empresa_id: req.webhookEmpresaId });
  });

  return router;
}
