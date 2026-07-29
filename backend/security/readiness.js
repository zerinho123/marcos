export function createReadinessGate() {
  let ready = false;
  let error = null;

  return {
    markReady() {
      ready = true;
      error = null;
    },

    markFailed(cause) {
      ready = false;
      error = cause instanceof Error ? cause.message : String(cause || 'schema_not_ready');
    },

    snapshot() {
      return { ready, error };
    },

    middleware(req, res, next) {
      if (ready) return next();
      return res.status(503).json({
        error: {
          code: 'service_not_ready',
          message: 'Servico temporariamente indisponivel durante a preparacao do banco.'
        },
        request_id: req.id
      });
    }
  };
}
