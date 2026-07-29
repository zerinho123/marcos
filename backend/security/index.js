// ============================================================================
// security/index.js — re-exports centralizados
// ============================================================================

export { loadEnv, isProd }          from './env.js';
export { ERR, AppError, buildErrorHandler, notFoundHandler } from './errors.js';
export {
  safeEquals, sha256Hex,
  encryptField, decryptField, encMany, decOne, decRows, isEncryptionEnabled
} from './encryption.js';
export { hashPassword, verifyPassword, isBcryptHash } from './auth.js';
export {
  buildRequireFinanceAuth, requireFinanceAdmin, requireFinanceOwner, requireFinanceWriteAccess,
  financeCsrfMiddleware,
  FINANCE_COOKIE_NAMES,
  setFinanceAuthCookie, clearFinanceAuthCookies,
  buildFinanceCsrfToken,
  issueFinanceSession, signFinanceAccessToken, verifyFinanceAccessToken
} from './financeAuth.js';
export { validate, z }              from './validation.js';
export { logger, requestId, requestLogger } from './logger.js';
export { buildAuditMiddleware, logAuditEvent } from './auditLog.js';
export { applySecurityHeaders, corsMiddleware, corsAllowlist, isAllowedOrigin } from './headers.js';
export { globalLimiter, loginLimiter } from './rateLimit.js';
