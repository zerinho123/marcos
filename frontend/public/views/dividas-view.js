// ============================================================================
// views/dividas-view.js - FinDividaPessoal
// ============================================================================

import { state, escapeHtml, formatCurrency, totalDividas } from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader, renderStatusBadge } from './shared.js?v=20260727-finance-v87';

function dividaProgress(d) {
  const saldo = Math.max(0, Number(d.saldo_devedor || 0));
  const originalRaw = Number(d.valor_original || 0);
  const original = Math.max(originalRaw, saldo);
  const pago = Math.max(0, original - saldo);
  const pct = original > 0 ? Math.min(100, (pago / original) * 100) : 0;
  return { original, pago, saldo, pct };
}

function renderDebtProgress(d) {
  const p = dividaProgress(d);
  const pctLabel = `${p.pct.toFixed(1)}%`;
  return `
    <div class="debt-progress" aria-label="Progresso da dívida">
      <div class="debt-progress-head">
        <span>${pctLabel} quitado</span>
        <strong>${formatCurrency(p.pago)}</strong>
      </div>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.pct.toFixed(1)}">
        <span style="width:${p.pct.toFixed(1)}%"></span>
      </div>
      <div class="debt-progress-foot">
        <span>Restante ${formatCurrency(p.saldo)}</span>
        <span>Original ${formatCurrency(p.original)}</span>
      </div>
    </div>`;
}

function renderDebtCard(d) {
  const p = dividaProgress(d);
  const tipo = String(d.tipo || '').replace('_', ' ');
  return `
    <article class="card debt-card">
      <header class="debt-card-head">
        <div>
          <h3>${escapeHtml(d.credor || 'Dívida')}</h3>
          <p>${escapeHtml(tipo || 'outro')}</p>
        </div>
        ${renderStatusBadge(d.status)}
      </header>
      ${renderDebtProgress(d)}
      <div class="debt-card-metrics">
        <div>
          <span>Saldo</span>
          <strong class="text-danger">${formatCurrency(p.saldo)}</strong>
        </div>
        <div>
          <span>Taxa</span>
          <strong>${d.taxa_juros ? `${Number(d.taxa_juros).toFixed(2)}% a.m.` : '-'}</strong>
        </div>
        <div>
          <span>Quitado</span>
          <strong class="text-success">${formatCurrency(p.pago)}</strong>
        </div>
      </div>
      <footer class="debt-card-actions">
        <button class="btn btn-sm" data-action="open-modal-divida-edit" data-param="${escapeHtml(d.id)}">Editar</button>
        <button class="btn btn-danger btn-sm" data-action="delete-divida" data-param="${escapeHtml(d.id)}">Excluir</button>
      </footer>
    </article>`;
}

export function renderDividasView() {
  const list = state.data.dividas || [];

  return `
    <section class="page-section debt-page">
      ${pageHeader({
        titulo: 'Dívidas',
        subtitulo: `${list.length} dívida(s) - Total ${formatCurrency(totalDividas())}`,
        actions: `<button class="btn btn-primary" data-action="open-modal-divida">+ Cadastrar</button>`
      })}

      ${list.length === 0 ? `
        <div class="card empty-state">
          <h3>Sem dívidas cadastradas</h3>
          <p>Cadastre uma dívida para acompanhar saldo, taxa e progresso de quitação.</p>
          <button class="btn btn-primary" data-action="open-modal-divida">+ Cadastrar primeira dívida</button>
        </div>
      ` : `
        <div class="debt-grid">
          ${list.map(renderDebtCard).join('')}
        </div>
      `}
    </section>`;
}
