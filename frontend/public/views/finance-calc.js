// ============================================================================
// views/finance-calc.js � c�lculo client-side: proje��o de caixa + break-even
// ----------------------------------------------------------------------------
// Puro, sem I/O. Alimenta as views de Fluxo de Caixa e DRE a partir do state
// j� carregado (contas, contas a receber/pagar, resumo do DRE).
// Espelha a l�gica do backend (routes/_calc-financeiro.js) � mantenha em sincronia.
// ============================================================================

const OPEN_STATUS = ['pendente', 'vencido', 'parcial'];

export function calcularPercentualReceita(despesa, totalReceitaLiquida) {
  const valorDespesa = Number(despesa);
  const receitaLiquida = Number(totalReceitaLiquida);
  if (!Number.isFinite(valorDespesa) || !Number.isFinite(receitaLiquida) || receitaLiquida <= 0) {
    return null;
  }
  return (valorDespesa / receitaLiquida) * 100;
}

/** Conta ainda em aberto (n�o quitada)? */
export function isOpen(item) {
  return OPEN_STATUS.includes(item?.status);
}

/** Saldo em aberto: valor - valor j� pago/recebido (nunca negativo). */
export function outstanding(item) {
  const saldoBase = Number(item?.saldo_base);
  if (Number.isFinite(saldoBase)) return Math.max(0, saldoBase);
  return Math.max(0, Number(item?.valor || 0) - Number(item?.valor_pago || 0));
}

/** Dias entre `venc` (YYYY-MM-DD) e a data-base (hoje 00:00). Negativo = vencido. */
function daysUntil(venc, base) {
  const d = new Date(String(venc).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return Infinity;
  return Math.floor((d - base) / 86400000);
}

/**
 * Proje��o de caixa Realizado vs Previsto em janelas 30/60/90 dias.
 *   saldoProjetado(h) = caixaAtual + S receb�veis_abertos(venc = h)
 *                                   - S pag�veis_abertos(venc = h)
 * Vencidos (venc < hoje) entram no horizonte imediato e s�o reportados � parte.
 *
 * @param {{
 *   caixaAtual?: number,
 *   recebiveis?: Array<{vencimento:string, valor:number, valor_pago?:number, status:string}>,
 *   pagaveis?:   Array<{vencimento:string, valor:number, valor_pago?:number, status:string}>,
 *   asOf?: string|null
 * }} input
 */
export function calcCashFlowForecast({ caixaAtual = 0, recebiveis = [], pagaveis = [], asOf = null } = {}) {
  const base = asOf ? new Date(asOf + 'T00:00:00') : new Date();
  base.setHours(0, 0, 0, 0);

  const ar = recebiveis.filter(isOpen).map((r) => ({ d: daysUntil(r.vencimento, base), v: outstanding(r) }));
  const ap = pagaveis.filter(isOpen).map((p) => ({ d: daysUntil(p.vencimento, base), v: outstanding(p) }));
  const caixa = Number(caixaAtual || 0);

  const buckets = [30, 60, 90].map((h) => {
    const entradas = ar.filter((x) => x.d <= h).reduce((s, x) => s + x.v, 0);
    const saidas   = ap.filter((x) => x.d <= h).reduce((s, x) => s + x.v, 0);
    return {
      horizonte: h,
      entradas,
      saidas,
      liquido: entradas - saidas,
      saldoProjetado: caixa + entradas - saidas
    };
  });

  return {
    caixaAtual: caixa,
    vencidas: {
      receber: ar.filter((x) => x.d < 0).reduce((s, x) => s + x.v, 0),
      pagar:   ap.filter((x) => x.d < 0).reduce((s, x) => s + x.v, 0)
    },
    aberto: {
      receber: ar.reduce((s, x) => s + x.v, 0),
      pagar:   ap.reduce((s, x) => s + x.v, 0)
    },
    buckets
  };
}

/**
 * Ponto de equil�brio derivado do resumo do DRE (/relatorios/dre ? `resumo`).
 *   custosFixos = margemContribui��o - EBITDA
 *   mc%         = margemContribui��o / receitaL�quida
 *   PE receita  = custosFixos / mc%
 *   margem seg. = (receitaL�quida - PE) / receitaL�quida
 *
 * @param {{ receita_liquida:number, margem_bruta:number, ebtda:number }} resumo
 */
export function calcBreakEven(resumo) {
  const receitaLiquida = Number(resumo?.receita_liquida || 0);
  const margemContrib  = Number(resumo?.margem_bruta || 0);   // backend chama MC de "margem_bruta"
  const ebitda         = Number(resumo?.ebtda || 0);          // sic: backend usa a chave "ebtda"
  const custosFixos    = margemContrib - ebitda;
  const mcRatio        = receitaLiquida > 0 ? margemContrib / receitaLiquida : 0;
  const atinge         = mcRatio > 0;
  const peReceita      = atinge ? custosFixos / mcRatio : null;
  const margemSeg      = (atinge && receitaLiquida > 0) ? (receitaLiquida - peReceita) / receitaLiquida : null;

  return { receitaLiquida, margemContrib, ebitda, custosFixos, mcRatio, atinge, peReceita, margemSeg };
}
