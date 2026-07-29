// ============================================================================
// views/metas-view.js — FinMeta
// ============================================================================

import { state, escapeHtml, formatCurrency, formatDateBR } from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader } from './shared.js?v=20260727-finance-v87';

export function renderMetasView() {
  const metas = state.data.metas;
  const list = Array.isArray(metas) ? metas.filter((meta) => meta.status !== 'cancelada') : [];

  return `
    <section class="page-section">
      ${pageHeader({
        titulo: 'Metas',
        subtitulo: `${list.length} meta(s) ativa(s)`,
        actions: `<button class="btn btn-primary" data-action="open-modal-meta">+ Nova meta</button>`
      })}

      ${list.length === 0 ? `
        <div class="card empty-state">
          <h3>Sem metas cadastradas</h3>
          <p>Defina objetivos financeiros e acompanhe o progresso.</p>
          <button class="btn btn-primary" data-action="open-modal-meta">+ Criar primeira meta</button>
        </div>
      ` : `
        <div class="grid-3col">
          ${list.map((m) => {
            const atual = Number(m.valor_atual || 0);
            const alvo  = Number(m.valor_alvo  || 1);
            const pct   = Math.min(100, (atual / alvo) * 100);
            const concluida = m.status === 'concluida';
            return `
              <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                  <strong>${escapeHtml(m.nome || m.titulo)}</strong>
                  ${concluida ? '<span class="badge badge-success">Concluída</span>' : ''}
                </div>
                <div class="progress" style="margin:12px 0"><span style="width:${pct.toFixed(1)}%"></span></div>
                <div style="display:flex;justify-content:space-between">
                  <small>${formatCurrency(atual)}</small>
                  <small class="muted">de ${formatCurrency(alvo)}</small>
                </div>
                ${m.prazo ? `<small class="muted">Prazo: ${formatDateBR(m.prazo)}</small>` : ''}
                <div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap;">
                  ${concluida ? '' : `<button class="btn btn-sm btn-primary" data-action="open-modal-meta-aporte" data-param="${escapeHtml(m.id)}">+ Aporte</button>`}
                  <button class="btn btn-sm btn-ghost" data-action="open-modal-meta-edit" data-param="${escapeHtml(m.id)}">Editar</button>
                  <button class="btn btn-sm btn-ghost" data-action="delete-meta" data-param="${escapeHtml(m.id)}">Excluir</button>
                </div>
              </div>`;
          }).join('')}
        </div>
      `}
    </section>`;
}
