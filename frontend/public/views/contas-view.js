// ============================================================================
// views/contas-view.js — FinContaBancaria
// ============================================================================

import { state, escapeHtml, formatCurrency, contasDoWorkspace } from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader } from './shared.js?v=20260727-finance-v87';

const TIPO_LABEL = {
  corrente: 'Conta corrente', poupanca: 'Poupança', carteira: 'Carteira / Dinheiro',
  investimento: 'Investimento', outro: 'Outro'
};

export function renderContasView() {
  const contas = contasDoWorkspace();
  const total = contas.reduce((s, c) => s + Number(c.saldo || 0), 0);
  const moedas = [...new Set(contas.map((c) => String(c.moeda || 'BRL').toUpperCase()))];
  const dashboard = state.data.dashboard;
  const temConsolidado = dashboard?.moeda_base && Number.isFinite(Number(dashboard?.saldo_total));
  const totalLabel = temConsolidado
    ? `Total consolidado ${formatCurrency(dashboard.saldo_total, dashboard.moeda_base)}${dashboard.moeda_incompleta ? ' (câmbio incompleto)' : ''}`
    : moedas.length <= 1
      ? `Total ${formatCurrency(total, moedas[0] || 'BRL')}`
      : 'Saldos em múltiplas moedas';
  const escopoLabel = state.workspace === 'empresarial' ? 'empresariais' : 'pessoais';

  return `
    <section class="page-section">
      ${pageHeader({
        titulo: 'Contas bancárias',
        subtitulo: `${contas.length} conta(s) ${escopoLabel} - ${totalLabel}`,
        actions: `<button class="btn btn-primary" data-action="open-modal-conta">+ Nova conta</button>`
      })}

      ${contas.length === 0 ? `
        <div class="card empty-state">
          <h3>Sem contas cadastradas</h3>
          <p>Comece criando uma conta bancária pra acompanhar saldos e lançamentos.</p>
          <button class="btn btn-primary" data-action="open-modal-conta">+ Criar conta</button>
        </div>
      ` : `
        <p class="hint" style="color:var(--t2);margin:-4px 0 14px;font-size:.9rem;">
          Contas bancárias mostram onde o dinheiro entra ou sai. Em uso, prefira arquivar em vez de excluir.
        </p>
        <div class="grid-3col">
          ${contas.map((c) => {
            const uso = Number(c.lancamentos_count || 0);
            const emUso = uso > 0;
            const semSaldo = Number(c.saldo || 0) === 0;
            return `
            <div class="card">
              <div class="card-header" style="margin-bottom:8px">
                <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                  <span class="dot-lg" style="background:${escapeHtml(c.cor || '#22d3ee')}"></span>
                  <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.nome)}</strong>
                </div>
              </div>
              <div class="kpi-value">${formatCurrency(c.saldo, c.moeda)}</div>
              <small class="muted">${escapeHtml(TIPO_LABEL[c.tipo] || c.tipo || '-')} · ${escapeHtml(c.moeda || 'BRL')} · ${uso} lançamento(s)</small>
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;">
                ${emUso
                  ? `<button class="btn btn-ghost btn-sm" data-action="ver-movimentacoes-conta" data-param="${escapeHtml(c.id)}">Ver movimentações</button>`
                  : ''}
                <button class="btn btn-ghost btn-sm" data-action="open-modal-conta-edit" data-param="${escapeHtml(c.id)}">Editar</button>
                <button class="btn btn-ghost btn-sm" data-action="arquivar-conta" data-param="${escapeHtml(c.id)}" title="Tira a conta da lista, preserva o histórico">Arquivar</button>
                ${(!emUso && semSaldo)
                  ? `<button class="btn btn-ghost btn-sm" data-action="delete-conta" data-param="${escapeHtml(c.id)}" title="Excluir (sem movimentações)" style="color:var(--red);">Excluir</button>`
                  : `<button class="btn btn-ghost btn-sm" disabled title="${emUso ? 'Conta com movimentações — arquive em vez de excluir.' : 'Zere o saldo antes de excluir.'}" style="opacity:.4;cursor:not-allowed;">Excluir</button>`}
              </div>
            </div>`;
          }).join('')}
        </div>
      `}
    </section>`;
}
