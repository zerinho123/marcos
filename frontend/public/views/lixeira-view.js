// ============================================================================
// views/lixeira-view.js — listagem/restauração de FinLixeira
// ============================================================================

import {
  state, escapeHtml, formatCurrencyBase, lixeiraFiltrada
} from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader, tableHeader, renderEmptyRow } from './shared.js?v=20260727-finance-v87';

const ENTIDADE_LABELS = {
  transacao:         'Lançamento',
  categoria:         'Categoria',
  categoria_pessoal: 'Categoria',
  conta_bancaria:    'Conta bancária',
  orcamento:         'Orçamento',
  divida:            'Dívida',
  meta:              'Meta',
  investimento:      'Investimento',
  aporte:            'Aporte',
  conta_pagar:       'Conta a pagar',
  conta_receber:     'Conta a receber',
  empresa:           'Empresa',
  usuario:           'Usuário',
  vinculo_empresa:   'Vínculo de empresa',
  delegacao:         'Delegação'
};

const CHIPS_PADRAO = ['transacao', 'categoria', 'conta_bancaria', 'orcamento', 'divida', 'meta', 'investimento', 'conta_pagar', 'conta_receber'];
const CHIPS_DONO = ['empresa', 'usuario', 'vinculo_empresa', 'delegacao'];

function entidadeLabel(entidade) {
  return ENTIDADE_LABELS[entidade] || entidade || '-';
}

function formatDateTimeBR(value) {
  if (!value) return '-';
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function renderLixeiraView() {
  const isOwner = Boolean(state.currentUser?.is_owner);
  const list = lixeiraFiltrada();
  const f = state.filters.lixeiraEntidade;
  const chips = ['todas', ...CHIPS_PADRAO, ...(isOwner ? CHIPS_DONO : [])];
  const showEmpresaCol = isOwner && state.filters.lixeiraGlobal;

  return `
    <section class="page-section">
      ${pageHeader({
        titulo: 'Lixeira',
        subtitulo: `${list.length} item(ns) excluído(s) recuperável(is)`,
        actions: isOwner ? `
          <button class="btn ${state.filters.lixeiraGlobal ? 'btn-primary' : 'btn-ghost'} btn-sm" data-action="toggle-lixeira-global">
            ${state.filters.lixeiraGlobal ? 'Vendo todas as empresas' : 'Ver todas as empresas'}
          </button>` : ''
      })}

      <div class="filter-bar">
        ${chips.map((c) => `
          <button class="chip ${f === c ? 'active' : ''}" data-action="filter-lixeira" data-param="${escapeHtml(c)}">
            ${c === 'todas' ? 'Todas' : escapeHtml(entidadeLabel(c))}
          </button>
        `).join('')}
      </div>

      <div class="card">
        <table class="data-table">
          ${tableHeader([
            'Excluído em', 'Tipo', 'Descrição',
            ...(showEmpresaCol ? ['Empresa'] : []),
            'Valor', 'Excluído por', ''
          ])}
          <tbody>
            ${list.length === 0 ? renderEmptyRow(showEmpresaCol ? 7 : 6, 'Nada na lixeira com este filtro.') : list.map((item) => `
              <tr>
                <td>${formatDateTimeBR(item.excluido_em)}</td>
                <td><span class="badge badge-neutral">${escapeHtml(entidadeLabel(item.entidade))}</span></td>
                <td>${escapeHtml(item.rotulo || '(sem descrição)')}</td>
                ${showEmpresaCol ? `<td>${escapeHtml(item.empresa_nome || '-')}</td>` : ''}
                <td>${item.valor != null ? formatCurrencyBase({ valor: item.valor }) : '-'}</td>
                <td>${escapeHtml(item.excluido_por_nome || '-')}</td>
                <td style="text-align:right; white-space:nowrap">
                  <button class="btn btn-ghost btn-sm" data-action="restaurar-lixeira" data-param="${escapeHtml(item.id)}">Restaurar</button>
                  ${isOwner ? `<button class="btn-icon" data-action="purgar-lixeira" data-param="${escapeHtml(item.id)}" title="Excluir definitivamente" aria-label="Excluir definitivamente">&times;</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}
