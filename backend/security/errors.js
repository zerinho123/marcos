// ============================================================================
// security/errors.js — excecoes tipadas + handler global
// ============================================================================

export class AppError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const ERR = {
  UNAUTHENTICATED: () => new AppError('unauthenticated', 'Sessao necessaria.', 401),
  INVALID_TOKEN:   () => new AppError('invalid_token', 'Token invalido ou expirado.', 401),
  FORBIDDEN:       (msg = 'Permissao insuficiente.') => new AppError('forbidden', msg, 403),
  NOT_FOUND:       (msg = 'Recurso nao encontrado.') => new AppError('not_found', msg, 404),
  VALIDATION:      (msg, extra) => new AppError('validation', msg, 400, extra),
  CONFLICT:        (msg) => new AppError('conflict', msg, 409),
  RATE_LIMITED:    (retryMs) => new AppError('rate_limited', 'Muitas tentativas. Aguarde.', 429, { retryAfterMs: retryMs }),
  LOCKED:          (retryMs) => new AppError('locked', 'Conta temporariamente bloqueada.', 429, { retryAfterMs: retryMs }),
  INVALID_CREDS:   () => new AppError('invalid_credentials', 'Usuario ou senha invalidos.', 401),
  PASSWORD_WEAK:   (reasons) => new AppError('password_weak', 'Senha nao atende aos criterios.', 400, { reasons }),
  CSRF:            () => new AppError('csrf_failure', 'Token CSRF invalido.', 403),
  INTERNAL:        (id) => new AppError('internal_error', 'Erro interno.', 500, { id })
};

export function buildErrorHandler({ isProd, logger }) {
  return (err, req, res, _next) => {
    const requestId = req.id || 'no-rid';

    if (err.type === 'entity.parse.failed') {
      logger.info({ requestId, msg: 'JSON parse error' });
      return res.status(400).json({ error: 'validation', message: 'JSON invalido no corpo da requisicao.' });
    }

    if (err instanceof AppError) {
      if (err.status >= 500) {
        logger.error({ requestId, code: err.code, msg: err.message, stack: err.stack });
      } else {
        logger.info({ requestId, code: err.code, msg: err.message });
      }
      return res.status(err.status).json({
        error: err.code,
        message: err.message,
        ...err.extra
      });
    }

    logger.error({ requestId, msg: err?.message ?? 'unknown', stack: err?.stack });
    return res.status(500).json({
      error: 'internal_error',
      message: 'Erro interno.',
      request_id: requestId,
      ...(isProd ? {} : { stack: err?.stack })
    });
  };
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'not_found' });
}
