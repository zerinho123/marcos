// ============================================================================
// routes/index.js — agrega todos os sub-routers do Finance standalone
// ============================================================================

import { Router } from 'express';
import { requireAmbienteEmpresarial } from './_common.js';
import { assertEmpresaVinculo } from '../security/ambiente.js';
import { buildAuditMiddleware } from '../security/auditLog.js';
import { buildEmpresasRouter }         from './empresas.js';
import { buildCategoriasRouter }       from './categorias.js';
import { buildContasBancariasRouter }  from './contas-bancarias.js';
import { buildTransacoesRouter }       from './transacoes.js';
import { buildOrcamentosRouter }       from './orcamentos.js';
import { buildMetasRouter }            from './metas.js';
import { buildContasPagarRouter }      from './contas-pagar.js';
import { buildContasReceberRouter }    from './contas-receber.js';
import { buildDividasRouter }          from './dividas.js';
import { buildInvestimentosRouter }    from './investimentos.js';
import { buildRelatoriosRouter }       from './relatorios.js';
import { buildDashboardConfigRouter }  from './dashboard-config.js';
import { buildCambioRouter }           from './cambio.js';
import { buildDrePlanoRouter }         from './dre-plano.js';
import { buildDreConfigRouter }        from './dre-config.js';
import { buildFinanceUsersRouter }     from './users.js';
import { buildPrecificacaoRouter }     from './precificacao.js';
import { buildLixeiraRouter }          from './lixeira.js';
import { buildDelegacoesRouter }       from './delegacoes.js';

// Fecha a brecha do "seletor multi-empresa" do admin: quando a request traz um
// empresa_id diferente do da sessao, o vinculo ativo em FinanceUserEmpresa e
// obrigatorio — para QUALQUER role. Usuario comum ja tinha o valor ignorado
// pelas rotas (resolveFinanceEmpresa usa o da sessao); a checagem aqui e para
// o admin, que antes tinha confianca ampla sem validacao.
// assertVinculoFn injetavel (default = banco real) para teste sem banco.
export function buildEmpresaOverrideGuard({ assertVinculoFn = assertEmpresaVinculo } = {}) {
  return async function validateEmpresaOverride(req, _res, next) {
    try {
      const user = req.financeUser;
      if (!user) return next();
      const candidate = req.query?.empresa_id ?? req.body?.empresa_id;
      if (candidate == null || candidate === '') return next();
      const requested = String(candidate).trim();
      if (!requested || requested === String(user.empresa_id)) return next();
      if (user.role !== 'admin') return next();
      await assertVinculoFn(user.id, requested);
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function buildFinanceRouter({ requireFinanceAdmin, requireFinanceOwner, auditMiddleware = buildAuditMiddleware() } = {}) {
  const router = Router();

  router.get('/health', (_req, res) => res.json({ ok: true, module: 'finance' }));

  router.use(buildEmpresaOverrideGuard());
  // Auditoria de toda mutação do Finance (req.financeUser já resolvido aqui).
  router.use(auditMiddleware);

  router.use('/lixeira',           buildLixeiraRouter({ requireFinanceOwner }));
  router.use('/delegacoes',        buildDelegacoesRouter({ requireFinanceOwner }));
  router.use('/empresas',          buildEmpresasRouter({ requireFinanceAdmin }));
  router.use('/categorias',        buildCategoriasRouter());
  router.use('/contas-bancarias',  buildContasBancariasRouter());
  router.use('/transacoes',        buildTransacoesRouter());
  router.use('/orcamentos',        buildOrcamentosRouter());
  router.use('/metas',             buildMetasRouter());
  router.use('/contas-pagar',      requireAmbienteEmpresarial, buildContasPagarRouter());
  router.use('/contas-receber',    requireAmbienteEmpresarial, buildContasReceberRouter());
  router.use('/dividas',           buildDividasRouter());
  router.use('/investimentos',     buildInvestimentosRouter());
  router.use('/relatorios',        buildRelatoriosRouter());
  router.use('/dashboard-config',  buildDashboardConfigRouter());
  router.use('/cambio',            buildCambioRouter());
  router.use('/dre',               requireAmbienteEmpresarial, buildDrePlanoRouter());
  router.use('/dre',               requireAmbienteEmpresarial, buildDreConfigRouter({ requireFinanceAdmin }));
  router.use('/precificacao',       requireAmbienteEmpresarial, buildPrecificacaoRouter({ requireFinanceAdmin }));

  if (requireFinanceAdmin) {
    router.use('/users', buildFinanceUsersRouter({ requireFinanceAdmin }));
  }

  return router;
}
