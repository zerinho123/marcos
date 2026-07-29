// ============================================================================
// config.js - configuracao global do frontend Finance
// ============================================================================
// Carregado em todos os HTMLs antes de qualquer modulo ES.
// Pode ser sobrescrito por window.__CF_API_ORIGIN__ no console em dev.
// ============================================================================
(function () {
  if (typeof window === 'undefined') return;
  if (!window.__CF_API_ORIGIN__) {
    // API standalone do Finance (NAO api.cfsistema.site, que e o CRM).
    window.__CF_API_ORIGIN__ = 'https://apifinanceiro.cfsistema.site';
  }
  if (!window.__CF_FINANCE_VERSION__) {
    window.__CF_FINANCE_VERSION__ = '20260727-finance-v87';
  }
})();
