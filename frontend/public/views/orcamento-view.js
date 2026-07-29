// ============================================================================
// views/orcamento-view.js — FinOrcamento por categoria
// ============================================================================

import { state, escapeHtml, formatCurrency, formatDateBR } from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader } from './shared.js?v=20260727-finance-v87';

function currentMonthLabel() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

export function renderOrcamentoView() {
  const list = state.data.orcamentos || [];

  return `
    <section class="page-section">
      ${pageHeader({
        titulo: 'Orçamento',
        subtitulo: `${list.length} categoria(s) com orçamento em ${currentMonthLabel()}`,
        actions: `<button class="btn btn-primary" data-action="open-modal-orcamento">Novo orçamento</button>`
      })}

      ${list.length === 0 ? `
        <div class="card empty-state">
          <h3>Sem orçamentos definidos</h3>
          <p>Defina um limite mensal para cada categoria de despesa para acompanhar quanto já foi gasto em relação ao planejado.</p>
          <button class="btn btn-primary" data-action="open-modal-orcamento">Criar orçamento</button>
        </div>
      ` : `
        <div class="card">
          <ul class="list-clean">
            ${list.map((o) => {
              const usado = Number(o.usado ?? o.gasto_atual ?? 0);
              const lim   = Number(o.limite || 0) || 1;
              const pct   = Math.min(100, Number(o.percentual ?? ((usado / lim) * 100)));
              const ovr   = usado > lim;
              const periodo = o.data_inicio && o.data_fim
                ? `${formatDateBR(o.data_inicio)} até ${formatDateBR(o.data_fim)}`
                : 'Período mensal';
              return `
                <li style="flex-direction:column;align-items:stretch;">
                  <div style="display:flex;width:100%;align-items:center;gap:8px;">
                    <span class="grow"><strong>${escapeHtml(o.categoria_nome || '-')}</strong></span>
                    <span class="${ovr ? 'text-danger' : ''}">${formatCurrency(usado)} <small class="muted">/ ${formatCurrency(lim)}</small></span>
                    <button type="button" class="btn-icon" data-action="open-modal-orcamento-edit" data-param="${escapeHtml(o.id)}" aria-label="Editar orçamento">✎</button>
                    <button type="button" class="btn-icon" data-action="delete-orcamento" data-param="${escapeHtml(o.id)}" aria-label="Excluir orçamento">×</button>
                  </div>
                  <div class="progress"><span class="${ovr ? 'progress-danger' : ''}" style="width:${pct.toFixed(1)}%"></span></div>
                  <div class="muted" style="font-size:12px;margin-top:4px;">Período: ${escapeHtml(periodo)} - Restante: ${formatCurrency(o.restante ?? Math.max(0, lim - usado))}</div>
                </li>`;
            }).join('')}
          </ul>
        </div>
      `}
    </section>`;
}
