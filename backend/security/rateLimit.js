// ============================================================================
// security/rateLimit.js — express-rate-limit
// ============================================================================

import rateLimit from 'express-rate-limit';
import { loadEnv } from './env.js';
import { ERR } from './errors.js';

const env = loadEnv();

function rateLimitHandler(req, res) {
  const err = ERR.RATE_LIMITED(0);
  res.status(429).json({ error: err.code, message: err.message });
}

export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_GLOBAL_WINDOW_MS,
  max: env.RATE_LIMIT_GLOBAL_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

export const loginLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_LOGIN_WINDOW_MS,
  max: env.RATE_LIMIT_LOGIN_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

// Auto-registro público: mais estrito que login (criação de conta é a
// superfície mais abusável — spam de cadastros pendentes p/ afogar o admin).
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});
