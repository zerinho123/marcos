// ============================================================================
// views/dashboard-pessoal-view.js — visão Pessoal (saldo, transações, etc)
// ============================================================================

import {
  state, escapeHtml, formatCurrency, formatDateBR,
  saldoTotal, receitasMes, despesasMes, totalDividas, sortTransacoesDesc
} from '../finance-core.js?v=20260727-finance-v87';
import { renderKpiCard, pageHeader, renderStatusBadge } from './shared.js?v=20260727-finance-v87';

export function renderDashboardPessoalView() {
  const contas     = state.data.contas || [];
  const transacoes = sortTransacoesDesc(state.data.transacoes).slice(0, 8);
  const dividas    = state.data.dividas || [];
  const saldo      = saldoTotal();
  const receitas   = receitasMes();
  const despesas   = despesasMes();
  const economia   = receitas - despesas;
  const econPct    = receitas > 0 ? (economia / receitas) * 100 : 0;

  return `
    <section class="page-section">
      ${pageHeader({
        titulo: 'Dashboard',
        subtitulo: 'Visão geral da sua vida financeira',
        actions: `
          <button class="btn btn-primary" data-action="open-modal-transacao" data-param="despesa">+ Novo lançamento</button>
        `
      })}

      <div class="kpi-grid">
        ${renderKpiCard({ label: 'Saldo total',     valor: formatCurrency(saldo),      hint: `${contas.length} conta(s)`, kind: 'primary' })}
        ${renderKpiCard({ label: 'Receitas do mês', valor: formatCurrency(receitas),   hint: 'Mês corrente', kind: 'success' })}
        ${renderKpiCard({ label: 'Despesas do mês', valor: formatCurrency(despesas),   hint: 'Mês corrente', kind: 'danger' })}
        ${renderKpiCard({ label: 'Economia',        valor: formatCurrency(economia),   hint: `${econPct.toFixed(1)}% das receitas`, kind: economia >= 0 ? 'success' : 'danger' })}
        ${renderKpiCard({ label: 'Dívidas ativas',  valor: formatCurrency(totalDividas()), hint: `${dividas.length} dívida(s)`, kind: 'warning' })}
      </div>

      <div class="grid-2col">
        <div class="card">
          <div class="card-header">
            <h3>Contas bancárias</h3>
            <button class="btn btn-sm btn-ghost" data-action="open-modal-conta">+ Conta</button>
          </div>
          ${contas.length === 0
            ? `<div class="empty-state-sm">Nenhuma conta cadastrada. <a data-action="open-modal-conta">Criar a primeira</a></div>`
            : `<ul class="list-clean">
                ${contas.map((c) => `
                  <li>
                    <span class="dot" style="background:${escapeHtml(c.cor || '#22d3ee')}"></span>
                    <span class="grow">${escapeHtml(c.nome)}</span>
                    <strong>${formatCurrency(c.saldo, c.moeda)}</strong>
                  </li>`).join('')}
              </ul>`
          }
        </div>

        <div class="card">
          <div class="card-header">
            <h3>Últimas transações</h3>
            <button class="btn btn-sm btn-ghost" data-action="change-view" data-param="transacoes">Ver todas</button>
          </div>
          ${transacoes.length === 0
            ? `<div class="empty-state-sm">Nenhum lançamento ainda. <a data-action="open-modal-transacao" data-param="despesa">Criar primeiro</a></div>`
            : `<ul class="list-clean">
                ${transacoes.map((t) => `
                  <li>
                    <span class="dot ${t.tipo === 'receita' ? 'dot-success' : 'dot-danger'}"></span>
                    <div class="grow">
                      <div>${escapeHtml(t.descricao || t.categoria_nome || '(sem descrição)')}</div>
                      <small class="muted">${formatDateBR(t.data)} · ${escapeHtml(t.categoria_nome || 'Sem categoria')} · ${escapeHtml(t.conta_nome || '')}</small>
                    </div>
                    <strong class="${t.tipo === 'receita' ? 'text-success' : 'text-danger'}">
                      ${t.tipo === 'receita' ? '+' : '-'} ${formatCurrency(t.valor, t.moeda)}
                    </strong>
                  </li>`).join('')}
              </ul>`
          }
        </div>
      </div>
    </section>`;
}
