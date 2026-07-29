// ============================================================================
// views/dre-shared.js — helpers de mês + carregamento do DRE (compartilhados
// entre a view DRE e o Dashboard empresarial, que reusa o mesmo endpoint/cache).
// ============================================================================

import { state } from '../finance-core.js?v=20260727-finance-v87';
import { api } from '../security-client.js?v=20260727-finance-v87';

/** Mês corrente no formato YYYY-MM. */
export function defaultMes() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Rótulo "junho de 2026" a partir de YYYY-MM. */
export function mesLabel(mes) {
  const [y, m] = String(mes).split('-').map(Number);
  if (!y || !m) return mes;
  return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

/** Chave de cache do DRE por mês + escopo. 'template' tem sufixo próprio para não
 *  colidir com o DRE pessoal (cache default = só o mês, compartilhado c/ o Dashboard). */
export function dreCacheKey(mes, scope) {
  return scope === 'template' ? `${mes}@template` : mes;
}

/** Busca e cacheia o DRE de um mês/escopo em state.data.dreCache[chave].
 *  Compartilhado: a view DRE (pessoal/template) e o Dashboard leem o mesmo cache. */
export async function ensureDre(mes, scope) {
  state.data.dreCache = state.data.dreCache || {};
  const key = dreCacheKey(mes, scope);
  if (state.data.dreCache[key]) return;
  state.data.dreCache[key] = { loading: true };
  try {
    state.data.dreCache[key] = await api.dre(mes, scope);
  } catch (e) {
    state.data.dreCache[key] = { erro: e?.message || 'Falha ao carregar DRE' };
  }
  if (typeof window.__renderApp === 'function') window.__renderApp();
}
