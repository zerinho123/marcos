// ============================================================================
// views/fluxo-view.js — Fluxo de caixa: Realizado (30d) + Previsto (30/60/90d)
// ----------------------------------------------------------------------------
// Realizado : GET /relatorios/fluxo-de-caixa (movimentações liquidadas).
// Previsto  : calculado no cliente a partir do caixa atual + contas a
//             receber/pagar em aberto (calcCashFlowForecast).
// ============================================================================

import {
  state, escapeHtml, formatCurrency, formatCurrencyBase, originalCurrencyHint, formatDateBR, saldoTotal, dateToInput
} from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader, tableHeader, renderEmptyRow, renderKpiCard, renderCurrencyWarning } from './shared.js?v=20260727-finance-v87';
import { calcCashFlowForecast } from './finance-calc.js?v=20260727-finance-v87';
import { api } from '../security-client.js?v=20260727-finance-v87';

let _loaded = false;

async function ensureFluxo() {
  if (_loaded || state.data.fluxo) return;
  _loaded = true;
  try {
    const hoje = new Date();
    const fim = dateToInput(hoje);
    const ini = dateToInput(new Date(hoje.getTime() - 30 * 86400000));
    state.data.fluxo = await api.fluxoCaixa(ini, fim, 'empresarial');
    if (typeof window.__renderApp === 'function') window.__renderApp();
  } catch (e) {
    state.data.fluxo = { erro: e?.message || 'Falha' };
  }
}

function forecastCard(b) {
  const pos = b.saldoProjetado >= 0;
  return `
    <div class="forecast-card ${pos ? 'fc-pos' : 'fc-neg'}">
      <div class="fc-head">
        <span class="fc-h">${b.horizonte} dias</span>
        <span class="fc-tag">saldo projetado</span>
      </div>
      <div class="fc-saldo">${formatCurrency(b.saldoProjetado)}</div>
      <div class="fc-rows">
        <div class="fc-line"><span>Entradas previstas</span><span class="text-success">+${formatCurrency(b.entradas)}</span></div>
        <div class="fc-line"><span>Saídas previstas</span><span class="text-danger">−${formatCurrency(b.saidas)}</span></div>
        <div class="fc-line"><span>Fluxo do período</span><span>${formatCurrency(b.liquido)}</span></div>
      </div>
    </div>`;
}

export function renderFluxoView() {
  ensureFluxo();
  const f = state.data.fluxo;

  // Previsão (cliente) — usa dados já carregados no boot
  const fc = calcCashFlowForecast({
    caixaAtual: saldoTotal(),
    recebiveis: state.data.contasReceber || [],
    pagaveis:   state.data.contasPagar   || []
  });
  const temVencidos = fc.vencidas.receber > 0 || fc.vencidas.pagar > 0;

  const realizado = !f
    ? `<div class="card">Carregando realizado…</div>`
    : f.erro
      ? `<div class="card text-danger">${escapeHtml(f.erro)}</div>`
      : `
        <div class="kpi-grid">
          ${renderKpiCard({ label: 'Entradas (30d)', valor: formatCurrency(f.entradas, f.moeda_base), kind: 'success' })}
          ${renderKpiCard({ label: 'Saídas (30d)',   valor: formatCurrency(f.saidas, f.moeda_base),   kind: 'danger' })}
          ${renderKpiCard({ label: 'Saldo do período', valor: formatCurrency(f.saldo_periodo, f.moeda_base), kind: 'primary' })}
        </div>
        <div class="card" style="margin-top:12px;">
          <div class="card-header"><h3>Movimentações realizadas</h3>
            <span class="muted" style="font-size:11.5px;">${formatDateBR(f.periodo?.inicio)} – ${formatDateBR(f.periodo?.fim)}</span>
          </div>
          <table class="data-table">
            ${tableHeader(['Data', 'Descrição', 'Direção', 'Valor'])}
            <tbody>
              ${(f.movimentacoes || []).length === 0
                ? renderEmptyRow(4, 'Sem movimentações no período.')
                : f.movimentacoes.map((m) => `
                  <tr>
                    <td>${formatDateBR(m.data)}</td>
                    <td>${escapeHtml(m.descricao || '-')}</td>
                    <td>${m.direcao === 'entrada' ? '<span class="text-success">+ Entrada</span>' : '<span class="text-danger">− Saída</span>'}</td>
                    <td>${formatCurrencyBase(m)}${originalCurrencyHint(m) ? `<small class="muted" style="display:block;">orig. ${originalCurrencyHint(m)}</small>` : ''}</td>
                  </tr>`).join('')}
            </tbody>
          </table>
        </div>`;

  return `
    <section class="page-section">
      ${pageHeader({ titulo: 'Fluxo de caixa', subtitulo: 'Realizado e projeção 30 / 60 / 90 dias' })}
      ${renderCurrencyWarning(f?.moeda_incompleta, f?.moeda_base)}

      <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div>
          <span class="kpi-label">Caixa atual</span>
          <div class="kpi-value" style="font-size:22px;">${formatCurrency(fc.caixaAtual)}</div>
        </div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:12.5px;">
          <span class="muted">A receber em aberto<br><strong class="text-success" style="font-size:15px;">${formatCurrency(fc.aberto.receber)}</strong></span>
          <span class="muted">A pagar em aberto<br><strong class="text-danger" style="font-size:15px;">${formatCurrency(fc.aberto.pagar)}</strong></span>
        </div>
      </div>

      ${temVencidos ? `
        <div class="card" style="border-color:var(--red-bdr);margin-top:12px;">
          <span class="text-warning" style="font-size:12.5px;">⚠ Vencidos não incluídos como liquidados — já refletidos no horizonte imediato:
          receber <strong class="text-success">${formatCurrency(fc.vencidas.receber)}</strong> ·
          pagar <strong class="text-danger">${formatCurrency(fc.vencidas.pagar)}</strong></span>
        </div>` : ''}

      <h3 style="margin:18px 0 8px;font-size:14px;color:var(--t0);">Projeção de caixa</h3>
      <div class="forecast-grid">
        ${fc.buckets.map(forecastCard).join('')}
      </div>

      <h3 style="margin:18px 0 8px;font-size:14px;color:var(--t0);">Realizado (últimos 30 dias)</h3>
      ${realizado}
    </section>`;
}
