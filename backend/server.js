// ============================================================================
// server.js — CF Finance standalone backend
// ============================================================================

import './bootstrap.js';  // PRIMEIRO — carrega .env + error handlers
import express      from 'express';
import cookieParser from 'cookie-parser';

import { loadEnv, isProd }                        from './security/env.js';
import {
  applySecurityHeaders, corsMiddleware, corsAllowlist,
  globalLimiter,
  requestId, requestLogger,
  buildErrorHandler, notFoundHandler,
  buildRequireFinanceAuth, requireFinanceAdmin, requireFinanceOwner, requireFinanceWriteAccess,
  financeCsrfMiddleware,
  isEncryptionEnabled,
  logger
} from './security/index.js';
import { createReadinessGate }                    from './security/readiness.js';
import { query, queryOne }                        from './db.js';
import { buildAuthRouter }                        from './routes/auth.js';
import { buildFinanceRouter }                     from './routes/index.js';
import { buildWebhookCrmRouter }                  from './routes/webhook-crm.js';
import {
  ensureFinanceAccountLinks,
  ensureFinanceTransactionSoftDelete,
  ensureFinanceUserLockout,
  ensureFinanceUserEmail,
  ensureFinanceUserAprovacao,
  ensureFinanceUserCadastroDados,
  ensureFinanceCategoriaOwner,
  ensureFinanceCategoriaPessoal,
  ensureFinanceOrcamentoPessoal,
  ensureFinanceWebhookTokenHash,
  ensureFinanceDreConfig,
  ensureFinanceDashboardConfig,
  ensureFinanceMoeda,
  ensureFinanceTransactionCurrencySnapshot,
  ensureFinancePricing,
  ensureFinanceEscopo,
  ensureFinanceLancamentoModel,
  ensureFinanceAmbientePessoal,
  ensureFinancePessoalBackfill,
  ensureFinanceAuditLog,
  ensureFinanceFieldEncryptionColumns,
  ensureFinanceUserSecurityLifecycle,
  ensureFinanceUserAccessLevel,
  backfillFinanceUserPii,
  ensureFinanceLixeira,
  ensureFinanceDelegacao,
  ensureFinanceDono
} from './schema-evolution.js';

// ────────────────────────────────────────────────────────────────────────────
// Env (valida e trava se inválida)
// ────────────────────────────────────────────────────────────────────────────

const env = loadEnv();

// ⚠️ NADA de top-level await neste módulo. O loader do LiteSpeed na Hostinger
// (lsnode.js) carrega o server com require(); a partir do Node 20.17+, require()
// de um módulo ESM que tenha top-level await lança ERR_REQUIRE_ASYNC_MODULE —
// foi exatamente o que derrubou o boot e gerou os 503 (Service Unavailable).
//
// As migrações rodam sem top-level await. O healthcheck continua disponível,
// mas as rotas Finance ficam em 503 até o schema estar pronto.
const schemaReadiness = createReadinessGate();
const schemaEvolution = ensureFinanceAccountLinks()
  .then(() => ensureFinanceTransactionSoftDelete())
  .then(() => ensureFinanceUserLockout())
  .then(() => ensureFinanceUserSecurityLifecycle())
  .then(() => ensureFinanceUserAccessLevel())
  .then(() => ensureFinanceUserEmail())
  .then(() => ensureFinanceUserAprovacao())
  .then(() => ensureFinanceUserCadastroDados())
  .then(() => ensureFinanceCategoriaOwner())
  .then(() => ensureFinanceCategoriaPessoal())
  .then(() => ensureFinanceOrcamentoPessoal())
  .then(() => ensureFinanceEscopo())
  .then(() => ensureFinanceWebhookTokenHash())
  .then(() => ensureFinanceDreConfig())
  .then(() => ensureFinanceDashboardConfig())
  .then(() => ensureFinanceMoeda())
  .then(() => ensureFinancePricing())
  // Depois de escopo + DRE config: backfill usa cp.escopo/dre_secao já presentes.
  .then(() => ensureFinanceLancamentoModel())
  .then(() => ensureFinanceTransactionCurrencySnapshot())
  // Separação Pessoal x Empresarial: cria FinanceUserEmpresa + empresa pessoal
  // por usuário (aditivo puro, seguro rodar sempre). Precisa rodar DEPOIS de
  // ensureFinanceEscopo (usa a coluna escopo).
  .then(() => ensureFinanceAmbientePessoal())
  // O backfill que MOVE dados (escopo='pessoal' → empresa pessoal do dono) NAO
  // roda sozinho em produção: exige backup prévio e janela (decisão D0, ver
  // docs/plano-implementacao.md). Ligar com FINANCE_PESSOAL_BACKFILL=1 na env,
  // ou rodar database/migrations/005-006 manualmente.
  .then(() => (process.env.FINANCE_PESSOAL_BACKFILL === '1'
    ? ensureFinancePessoalBackfill()
    : console.log('[schema-evolution] backfill pessoal PULADO (setar FINANCE_PESSOAL_BACKFILL=1 ou rodar migrations 005-006 na mao)')))
  // Hardening 2026-07-07: trilha de auditoria + colunas TEXT p/ ciphertext.
  .then(() => ensureFinanceAuditLog())
  // v87: lixeira universal + delegacao de usuarios + papel dono. Depois do
  // audit log (mesmo raciocinio de "sem FK, sobrevive a delecao") e antes das
  // colunas de cifra (nenhuma dependencia entre elas, ordem so por afinidade).
  .then(() => ensureFinanceLixeira())
  .then(() => ensureFinanceDelegacao())
  .then(() => ensureFinanceDono())
  .then(() => ensureFinanceFieldEncryptionColumns())
  .then(() => (isEncryptionEnabled() ? backfillFinanceUserPii() : { updated: 0 }))
  .then(({ updated = 0 } = {}) => {
    schemaReadiness.markReady();
    console.log(`[schema-evolution] migrações OK; usuários protegidos=${updated}`);
  })
  .catch((err) => {
    schemaReadiness.markFailed(err);
    logger.error({ error: err?.message || String(err) }, 'Schema Finance indisponível');
  });

void schemaEvolution;

// ────────────────────────────────────────────────────────────────────────────
// Auth factories
// ────────────────────────────────────────────────────────────────────────────

async function lookupFinanceUser(id) {
  const user = await queryOne(
    `SELECT \`id\`,\`username\`,\`nome\`,\`role\`,\`status\`,\`workspaces\`,\`access_level\`,\`empresa_id\`,\`mfa_enabled\`,
            \`locked_until\`,\`session_version\`,\`deleted_at\`
       FROM \`FinanceUser\` WHERE \`id\` = ? AND \`deleted_at\` IS NULL LIMIT 1`,
    [id]
  );
  return ensureUserEmpresa(user);
}

// Self-heal: qualquer usuario (admin OU usuario comum) sem empresa_id vinculado
// travaria as rotas em resolveFinanceEmpresa. Idempotente: roda so enquanto
// empresa_id for NULL. Ordem de resolucao (do mais legitimo ao bootstrap):
//   1. vinculo ativo em FinanceUserEmpresa com empresa normal → usa essa;
//   2. banco sem NENHUMA empresa (bootstrap de instalacao) → cria a default;
//   3. existem empresas, mas nenhuma e do usuario → cria a empresa PESSOAL dele
//      e usa como "home". NUNCA vincula a empresa de terceiros: o comportamento
//      antigo ("primeira empresa do banco") vazava tenant num cenario
//      multi-empresa.
async function ensureUserEmpresa(user) {
  if (!user || user.empresa_id) return user;

  let empresaId = null;
  try {
    const vinculo = await queryOne(
      `SELECT fue.\`empresa_id\`
         FROM \`FinanceUserEmpresa\` fue
         JOIN \`Empresa\` e ON e.\`id\` = fue.\`empresa_id\` AND e.\`tipo\` = 'normal'
        WHERE fue.\`user_id\` = ? AND fue.\`ativo\` = 1
        ORDER BY fue.\`createdAt\` LIMIT 1`,
      [user.id]
    );
    empresaId = vinculo?.empresa_id ?? null;
  } catch {
    // FinanceUserEmpresa/coluna tipo ainda nao existem (schema-evolution em
    // andamento no primeiro boot) — segue para os caminhos abaixo.
  }

  if (!empresaId) {
    const empresa = await queryOne("SELECT `id` FROM `Empresa` LIMIT 1");
    if (!empresa) {
      // 2) Instalacao zerada: cria a empresa default (comportamento original).
      empresaId = process.env.FINANCE_DEFAULT_EMPRESA_ID || 'empresa-1';
      await query(
        'INSERT INTO `Empresa` (`id`, `nome`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `id` = `id`',
        [empresaId, 'Minha Empresa']
      );
    } else {
      // 3) Ha empresas, mas nenhuma do usuario: home = empresa pessoal dele.
      const { ensureUserPessoalEmpresa } = await import('./security/ambiente.js');
      empresaId = await ensureUserPessoalEmpresa(user);
    }
  }

  await query('UPDATE `FinanceUser` SET `empresa_id` = ? WHERE `id` = ?', [empresaId, user.id]);
  user.empresa_id = empresaId;
  return user;
}

const requireFinanceAuth = buildRequireFinanceAuth({ lookupFinanceUser, logger });
// Usa o allowlist efetivo (env + origens de produção) — mesma defesa do CORS,
// pra escrita pós-login não quebrar se CORS_ORIGIN vier vazio do ambiente.
const csrfMiddleware     = financeCsrfMiddleware({ allowedOrigins: corsAllowlist });

// ────────────────────────────────────────────────────────────────────────────
// Express
// ────────────────────────────────────────────────────────────────────────────

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

applySecurityHeaders(app);
app.use(corsMiddleware);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser(env.COOKIE_SECRET));
app.use(requestId);
app.use(requestLogger);
app.use(globalLimiter);

// ────────────────────────────────────────────────────────────────────────────
// Rotas públicas
// ────────────────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, service: 'cf-finance-api', ts: new Date().toISOString() })
);
app.get('/api/ready', (_req, res) => {
  const state = schemaReadiness.snapshot();
  return res.status(state.ready ? 200 : 503).json({
    ok: state.ready,
    service: 'cf-finance-api',
    ...(state.error ? { error: 'schema_not_ready' } : {})
  });
});

app.use('/api/finance', schemaReadiness.middleware);

// Auth — loginLimiter aplicado só em POST /login (dentro do router)
app.use('/api/finance/auth', buildAuthRouter({ requireFinanceAuth, csrfMiddleware }));

// ────────────────────────────────────────────────────────────────────────────
// Webhook CRM → Finance (token no header, sem cookie)
// ────────────────────────────────────────────────────────────────────────────

app.use('/api/finance/webhook/crm', buildWebhookCrmRouter());

// ────────────────────────────────────────────────────────────────────────────
// Rotas protegidas (cookie JWT + CSRF)
// ────────────────────────────────────────────────────────────────────────────

app.use(
  '/api/finance',
  requireFinanceAuth,
  requireFinanceWriteAccess,
  csrfMiddleware,
  buildFinanceRouter({ requireFinanceAdmin, requireFinanceOwner })
);

// ────────────────────────────────────────────────────────────────────────────
// Error handling
// ────────────────────────────────────────────────────────────────────────────

app.use(notFoundHandler);
app.use(buildErrorHandler({ isProd: isProd(), logger }));

// ────────────────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────────────────

// Hostinger e PaaS injetam PORT via env — sempre prefira essa
const PORT = Number(process.env.PORT) || env.PORT;
const HOST = process.env.HOST || env.HOST;

app.listen(PORT, HOST, () => {
  console.log(`[boot] CF Finance API listening on ${HOST}:${PORT} (env=${env.NODE_ENV})`);
  logger.info(
    { port: PORT, host: HOST, env: env.NODE_ENV },
    'CF Finance API iniciada'
  );
});
