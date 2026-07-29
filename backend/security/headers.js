// ============================================================================
// security/headers.js — helmet + CORS
// ============================================================================

import helmet from 'helmet';
import cors from 'cors';
import { loadEnv } from './env.js';

const env = loadEnv();

export function applySecurityHeaders(app) {
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  }));
}

// Origens de produção conhecidas. Servem de FALLBACK caso a env CORS_ORIGIN
// venha vazia/ausente do ambiente da Hostinger (o que faria o app rejeitar TODA
// origem e quebrar o login com "No 'Access-Control-Allow-Origin'"). São domínios
// nossos, então é seguro garanti-las sempre.
const PROD_ORIGINS = [
  'https://financeiro.cfsistema.site',
  'https://apifinanceiro.cfsistema.site'
];

function normOrigin(o) {
  return String(o || '').trim().replace(/\/+$/, '').toLowerCase();
}

// Allowlist efetiva = CORS_ORIGIN do ambiente ∪ origens de produção conhecidas.
export const corsAllowlist = [...new Set(
  [...(env.CORS_ORIGIN || []), ...PROD_ORIGINS].map(normOrigin).filter(Boolean)
)];

export function isAllowedOrigin(origin) {
  return corsAllowlist.includes(normOrigin(origin));
}

export const corsMiddleware = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server / mesma origem
    if (isAllowedOrigin(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id']
});
