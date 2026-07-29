// ============================================================================
// views/shared.js — componentes UI reutilizáveis (cards, badges, stubs)
// ============================================================================

import { escapeHtml, formatCurrency, formatPercent } from '../finance-core.js?v=20260727-finance-v87';

export function renderStubView(titulo, descricao = '') {
  return `
    <section class="page-section">
      <header class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(titulo)}</h1>
          <p class="page-subtitle">${escapeHtml(descricao)}</p>
        </div>
      </header>
      <div class="card empty-state">
        <span class="empty-icon">[?]</span>
        <h3>Em construção</h3>
        <p>${escapeHtml(descricao || 'Esta tela ainda não tem implementação.')}</p>
      </div>
    </section>`;
}

export function renderKpiCard({ label, valor, hint, kind = 'neutral' }) {
  return `
    <div class="kpi-card kpi-${escapeHtml(kind)}">
      <span class="kpi-label">${escapeHtml(label)}</span>
      <span class="kpi-value">${escapeHtml(valor)}</span>
      ${hint ? `<span class="kpi-hint">${escapeHtml(hint)}</span>` : ''}
    </div>`;
}

export function renderStatusBadge(status) {
  const cls = {
    pago: 'success', recebido: 'success',
    pendente: 'warning',
    vencido: 'danger', atrasado: 'danger',
    parcial: 'info', em_negociacao: 'info', renegociada: 'info',
    ativa: 'warning', quitada: 'success'
  }[status] || 'neutral';
  return `<span class="badge badge-${cls}">${escapeHtml(status || '-')}</span>`;
}

export function renderEmptyRow(colspan, message) {
  return `<tr><td colspan="${colspan}" class="table-empty">${escapeHtml(message)}</td></tr>`;
}

export function tableHeader(cols) {
  return `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`;
}

export function pageHeader({ titulo, subtitulo, actions = '' }) {
  return `
    <header class="page-header">
      <div>
        <h1 class="page-title">${escapeHtml(titulo)}</h1>
        ${subtitulo ? `<p class="page-subtitle">${escapeHtml(subtitulo)}</p>` : ''}
      </div>
      <div class="page-actions">${actions}</div>
    </header>`;
}

export function renderCurrencyWarning(incomplete, moedaBase = 'BRL') {
  if (!incomplete) return '';
  return `<div class="currency-warning" role="status">
    <strong>Conversão de moeda incompleta.</strong>
    <span>Alguns valores não puderam ser convertidos para ${escapeHtml(moedaBase)}. Os totais precisam ser conferidos.</span>
  </div>`;
}

export { escapeHtml, formatCurrency, formatPercent };
