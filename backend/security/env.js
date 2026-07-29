// ============================================================================
// security/env.js — validacao de variaveis de ambiente do Finance Backend
// ============================================================================

import { z } from 'zod';

const trueLike = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() === 'true' : Boolean(v)),
  z.boolean()
);

const intFrom = (def) =>
  z.preprocess((v) => {
    if (v === undefined || v === '') return def;
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) ? n : def;
  }, z.number().int());

const csvList = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []),
  z.array(z.string().min(1))
);

const strongSecret = z.string().min(32, 'segredo precisa ter pelo menos 32 caracteres');

const schema = z.object({
  NODE_ENV:  z.enum(['development', 'staging', 'production']).default('production'),
  HOST:      z.string().default('0.0.0.0'),
  PORT:      intFrom(3001),

  DATABASE_URL: z.string().url().or(z.string().startsWith('mysql://')),

  // TLS do banco. Por padrão (compat. com hosting que usa cert self-signed) a
  // validação fica desligada, mas é controlável: setar DB_SSL_CA_PATH com a CA
  // liga a validação completa automaticamente; ou force DB_SSL_REJECT_UNAUTHORIZED=true.
  DB_SSL_REJECT_UNAUTHORIZED: trueLike.default(false),
  DB_SSL_CA_PATH: z.string().optional().default(''),

  JWT_SECRET_CURRENT:  strongSecret,
  JWT_SECRET_PREVIOUS: z.string().min(0).optional().default(''),
  JWT_ISSUER:          z.string().min(1).default('cfsistema.site'),
  JWT_AUDIENCE:        z.string().min(1).default('cfsistema-web'),
  COOKIE_DOMAIN:   z.string().min(1),
  COOKIE_SECRET:   strongSecret,
  COOKIE_SAMESITE: z.enum(['Strict', 'Lax', 'None']).default('Lax'),

  CSRF_SECRET: strongSecret,

  // Criptografia em repouso dos campos sensíveis (AES-256-GCM). Obrigatória em
  // produção; opcional em desenvolvimento. PREVIOUS permite rotação de chave.
  // Gerar com: openssl rand -hex 32.
  // ⚠️ PERDA DA CHAVE = PERDA IRREVERSÍVEL DOS DADOS CIFRADOS. Guardar em cofre.
  FINANCE_ENC_KEY_CURRENT: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    z.string().regex(/^[0-9a-f]{64}$/i, 'FINANCE_ENC_KEY_CURRENT: 64 chars hex (openssl rand -hex 32)').optional()
  ).default(''),
  FINANCE_ENC_KEY_PREVIOUS: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    z.string().regex(/^[0-9a-f]{64}$/i, 'FINANCE_ENC_KEY_PREVIOUS: 64 chars hex').optional()
  ).default(''),

  CORS_ORIGIN: csvList,

  BCRYPT_COST: intFrom(12),

  RATE_LIMIT_GLOBAL_MAX:       intFrom(200),
  RATE_LIMIT_GLOBAL_WINDOW_MS: intFrom(60000),
  RATE_LIMIT_LOGIN_MAX:        intFrom(5),
  RATE_LIMIT_LOGIN_WINDOW_MS:  intFrom(900000),

  LOG_LEVEL:    z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_REQUESTS: trueLike.default(true),

  // Webhook CRM→Finance (token secreto). Aceita "" (desabilitado) ou >= 16 chars.
  FINANCE_WEBHOOK_SECRET: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    z.string().min(16).optional()
  ).default(''),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === 'production' && !value.FINANCE_ENC_KEY_CURRENT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FINANCE_ENC_KEY_CURRENT'],
      message: 'obrigatoria em producao (openssl rand -hex 32)'
    });
  }
});

let cached = null;

export function loadEnv(source = process.env) {
  if (cached) return cached;

  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    console.error('\n[boot] Variaveis de ambiente invalidas:\n' + issues + '\n');
    // Inclui as issues no Error pra aparecer no boot.log via uncaughtException
    throw new Error(
      'Configuracao de ambiente invalida — boot abortado.\n' + issues
    );
  }

  cached = Object.freeze(result.data);
  return cached;
}

export function isProd() {
  return loadEnv().NODE_ENV === 'production';
}
