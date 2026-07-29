// ============================================================================
// security/logger.js — logger simples (sem pino para manter deps minimas)
// ============================================================================

import { loadEnv } from './env.js';
import { randomUUID } from 'node:crypto';

const env = loadEnv();

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[env.LOG_LEVEL] ?? 1;

function log(level, obj) {
  if (LEVELS[level] < currentLevel) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    ...obj
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  debug: (obj) => log('debug', obj),
  info:  (obj) => log('info', obj),
  warn:  (obj) => log('warn', obj),
  error: (obj) => log('error', obj)
};

export function requestId(req, _res, next) {
  req.id = req.headers['x-request-id'] || randomUUID();
  next();
}

export function requestLogger(req, res, next) {
  if (!env.LOG_REQUESTS) return next();
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      type: 'request',
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start,
      ip: req.ip,
      rid: req.id
    });
  });
  next();
}
