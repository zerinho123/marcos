// ============================================================================
// security/validation.js — middleware Zod para Express
// ============================================================================

import { z } from 'zod';
import { ERR } from './errors.js';

export { z };

export function validate({ body, query, params } = {}) {
  return (req, _res, next) => {
    try {
      req.validated = req.validated || {};
      if (body) {
        const r = body.safeParse(req.body);
        if (!r.success) {
          const msgs = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          throw ERR.VALIDATION(msgs);
        }
        req.validated.body = r.data;
      }
      if (query) {
        const r = query.safeParse(req.query);
        if (!r.success) {
          const msgs = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          throw ERR.VALIDATION(msgs);
        }
        req.validated.query = r.data;
      }
      if (params) {
        const r = params.safeParse(req.params);
        if (!r.success) {
          const msgs = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          throw ERR.VALIDATION(msgs);
        }
        req.validated.params = r.data;
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}
