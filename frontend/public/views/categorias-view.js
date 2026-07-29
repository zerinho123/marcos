// ============================================================================
// views/categorias-view.js — FinCategoria (cadastro no painel normal)
// ----------------------------------------------------------------------------
// Tela piloto da padronização Categoria → Lançamento → Conta: deixa claro onde
// cada categoria é usada (contagem de lançamentos vinculados) e impede a
// exclusão direta de categoria em uso (inative em vez de excluir).
// ============================================================================

import { state, escapeHtml, categoriasDoWorkspace } from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader, tableHeader, renderEmptyRow } from './shared.js?v=20260727-finance-v87';

const DRE_SECAO_LABEL = {
  receita_bruta: 'Receita bruta',
  deducoes: 'Deduções',
  cmv: 'CMV',
  servicos_terceiros: 'Serviços de terceiros',
  comerciais: 'Despesas comerciais',
  operacionais_diretas: 'Operacionais diretas',
  administrativas: 'Administrativas',
  nao_operacionais: 'Não operacionais',
  juros_emprestimos: 'Juros/empréstimos',
  ir: 'Impostos (IR)'
};
const NATUREZA_LABEL = { receita: 'Receita', despesa: 'Despesa', transferencia: 'Transferência', ajuste: 'Ajuste' };
const COMPORTAMENTO_LABEL = { fixa: 'Fixa', variavel: 'Variável', nao_aplica: '—' };

function statCard(valor, rotulo) {
  return `<div class="card" style="flex:1;min-width:150px;">
    <div style="font-size:1.6rem;font-weight:700;">${valor}</div>
    <div style="color:var(--t2);font-size:.85rem;">${escapeHtml(rotulo)}</div>
  </div>`;
}

export function renderCategoriasView() {
  // Tela de GESTÃO: lista inclui as inativas (para reativar). `categoriasDoWorkspace`
  // exclui ativo=0 — usar aqui esconderia inativas e zeraria o card "Inativas".
  // O backend já entrega só as categorias do escopo ativo (filtro por escopo).
  const alvo = state.workspace === 'empresarial' ? 'empresarial' : 'pessoal';
  const list = (state.data.categorias || []).filter((c) => {
    const t = c.tipo || 'pessoal';
    return t === alvo || t === 'ambos';
  });
  const escopoLabel = state.workspace === 'empresarial' ? 'empresariais' : 'pessoais';

  // A seção efetiva do DRE vem do mapa (dre_secao_efetiva), com fallback no campo.
  const secaoDe = (c) => c.dre_secao_efetiva ?? c.dre_secao ?? null;
  const usoDe = (c) => Number(c.lancamentos_count || 0);

  const ativas = list.filter((c) => Number(c.ativo) === 1).length;
  const inativas = list.length - ativas;
  const semGrupo = list.filter((c) => !secaoDe(c)).length;
  const usadas = list.filter((c) => usoDe(c) > 0).length;

  // Filtros locais (em memória) — não chamam o backend; recortam a lista carregada.
  const ff = state.filters.categorias || {};
  const busca = (ff.busca || '').trim().toLowerCase();
  const filtrada = list.filter((c) => {
    if (busca && !(c.nome || '').toLowerCase().includes(busca)) return false;
    if (ff.natureza && ff.natureza !== 'todas' && (c.natureza || '') !== ff.natureza) return false;
    if (ff.comportamento && ff.comportamento !== 'todas' && (c.comportamento || '') !== ff.comportamento) return false;
    if (ff.grupo && ff.grupo !== 'todas') {
      if (ff.grupo === 'sem' ? !!secaoDe(c) : secaoDe(c) !== ff.grupo) return false;
    }
    if (ff.status === 'ativas' && Number(c.ativo) !== 1) return false;
    if (ff.status === 'inativas' && Number(c.ativo) === 1) return false;
    if (ff.uso === 'usadas' && !(usoDe(c) > 0)) return false;
    if (ff.uso === 'sem_uso' && usoDe(c) > 0) return false;
    return true;
  });

  const sel = (campo, valor) => (String(ff[campo] ?? '') === String(valor) ? ' selected' : '');
  if (state.workspace !== 'empresarial') {
    return `
      <section class="page-section">
        ${pageHeader({
          titulo: 'Categorias pessoais',
          subtitulo: 'Categorias simples para receitas e despesas pessoais.',
          actions: `<button class="btn btn-primary" data-action="open-modal-categoria">+ Nova categoria</button>`
        })}

        ${list.length === 0 ? `
          <div class="card empty-state">
            <h3>Sem categorias cadastradas</h3>
            <p>Crie categorias para classificar seus lançamentos pessoais.</p>
            <button class="btn btn-primary" data-action="open-modal-categoria">+ Criar categoria</button>
          </div>
        ` : `
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
            ${statCard(ativas, 'Ativas')}
            ${statCard(usadas, 'Usadas em lançamentos')}
            ${statCard(inativas, 'Inativas')}
          </div>

          <div class="dv-filters" style="margin-bottom:14px;">
            <input class="input input-sm" type="search" placeholder="Buscar categoria..."
                   value="${escapeHtml(ff.busca || '')}" data-action="search-categoria" />
            <select class="input input-sm" data-action="filter-categoria" data-param="natureza">
              <option value="todas"${sel('natureza','todas')}>Receitas e despesas</option>
              <option value="receita"${sel('natureza','receita')}>Receita</option>
              <option value="despesa"${sel('natureza','despesa')}>Despesa</option>
            </select>
            <select class="input input-sm" data-action="filter-categoria" data-param="status">
              <option value="todas"${sel('status','todas')}>Todos status</option>
              <option value="ativas"${sel('status','ativas')}>Ativas</option>
              <option value="inativas"${sel('status','inativas')}>Inativas</option>
            </select>
            <select class="input input-sm" data-action="filter-categoria" data-param="uso">
              <option value="todas"${sel('uso','todas')}>Usadas e não usadas</option>
              <option value="usadas"${sel('uso','usadas')}>Usadas em lançamentos</option>
              <option value="sem_uso"${sel('uso','sem_uso')}>Sem lançamentos</option>
            </select>
          </div>

          <div class="card">
            <table class="data-table">
              ${tableHeader(['Categoria', 'Natureza', 'Lançamentos', 'Status', ''])}
              <tbody>
                ${filtrada.length === 0 ? renderEmptyRow(5, 'Nenhuma categoria no filtro atual.') : filtrada.map((c) => {
                  const uso = usoDe(c);
                  const emUso = uso > 0;
                  const inativa = Number(c.ativo) !== 1;
                  return `
                    <tr${inativa ? ' style="opacity:.55;"' : ''}>
                      <td>
                        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${escapeHtml(c.cor || '#64748b')};margin-right:8px;vertical-align:middle;"></span>
                        ${escapeHtml(c.nome)}
                      </td>
                      <td>${escapeHtml(NATUREZA_LABEL[c.natureza] || '-')}</td>
                      <td>${emUso ? `<span title="Lançamentos vinculados">${uso}</span>` : '<span style="color:var(--t1);">0</span>'}</td>
                      <td>${inativa ? 'Inativa' : 'Ativa'}</td>
                      <td style="text-align:right;white-space:nowrap;">
                        ${emUso
                          ? `<button class="btn btn-ghost btn-sm" data-action="ver-lancamentos-categoria" data-param="${escapeHtml(c.id)}">Ver lançamentos</button>`
                          : ''}
                        <button class="btn btn-ghost btn-sm" data-action="open-modal-categoria-edit" data-param="${escapeHtml(c.id)}">Editar</button>
                        ${inativa
                          ? `<button class="btn btn-ghost btn-sm" data-action="reativar-categoria" data-param="${escapeHtml(c.id)}">Reativar</button>`
                          : `<button class="btn btn-ghost btn-sm" data-action="inativar-categoria" data-param="${escapeHtml(c.id)}">Inativar</button>`}
                        ${emUso
                          ? `<button class="btn btn-ghost btn-sm" disabled style="opacity:.4;cursor:not-allowed;">Excluir</button>`
                          : `<button class="btn btn-ghost btn-sm" data-action="delete-categoria" data-param="${escapeHtml(c.id)}" style="color:var(--red);">Excluir</button>`}
                      </td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      </section>`;
  }
  const grupoOpts = Object.entries(DRE_SECAO_LABEL)
    .map(([v, l]) => `<option value="${v}"${sel('grupo', v)}>${escapeHtml(l)}</option>`).join('');

  return `
    <section class="page-section">
      ${pageHeader({
        titulo: 'Categorias',
        subtitulo: 'Classifique lançamentos e defina como eles aparecem no caixa, DRE e relatórios.',
        actions: `<button class="btn btn-primary" data-action="open-modal-categoria">+ Nova categoria</button>`
      })}

      <p class="hint" style="color:var(--t2);margin:-4px 0 14px;font-size:.9rem;">
        Categorias definem como os lançamentos aparecem nos relatórios — elas não são
        lançamentos nem contas bancárias. ${list.length} categoria(s) ${escopoLabel}.
      </p>

      ${list.length === 0 ? `
        <div class="card empty-state">
          <h3>Sem categorias cadastradas</h3>
          <p>Crie categorias pra classificar lançamentos, orçamentos e o DRE.</p>
          <button class="btn btn-primary" data-action="open-modal-categoria">+ Criar categoria</button>
        </div>
      ` : `
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
          ${statCard(ativas, 'Ativas')}
          ${statCard(usadas, 'Usadas em lançamentos')}
          ${statCard(semGrupo, 'Sem grupo DRE')}
          ${statCard(inativas, 'Inativas')}
        </div>

        <div class="dv-filters" style="margin-bottom:14px;">
          <input class="input input-sm" type="search" placeholder="Buscar categoria…"
                 value="${escapeHtml(ff.busca || '')}" data-action="search-categoria" />
          <select class="input input-sm" data-action="filter-categoria" data-param="natureza">
            <option value="todas"${sel('natureza','todas')}>Toda natureza</option>
            <option value="receita"${sel('natureza','receita')}>Receita</option>
            <option value="despesa"${sel('natureza','despesa')}>Despesa</option>
            <option value="transferencia"${sel('natureza','transferencia')}>Transferência</option>
            <option value="ajuste"${sel('natureza','ajuste')}>Ajuste</option>
          </select>
          <select class="input input-sm" data-action="filter-categoria" data-param="comportamento">
            <option value="todas"${sel('comportamento','todas')}>Todo comportamento</option>
            <option value="fixa"${sel('comportamento','fixa')}>Fixa</option>
            <option value="variavel"${sel('comportamento','variavel')}>Variável</option>
            <option value="nao_aplica"${sel('comportamento','nao_aplica')}>Não se aplica</option>
          </select>
          <select class="input input-sm" data-action="filter-categoria" data-param="grupo">
            <option value="todas"${sel('grupo','todas')}>Todo grupo DRE</option>
            <option value="sem"${sel('grupo','sem')}>Sem grupo</option>
            ${grupoOpts}
          </select>
          <select class="input input-sm" data-action="filter-categoria" data-param="status">
            <option value="todas"${sel('status','todas')}>Todos status</option>
            <option value="ativas"${sel('status','ativas')}>Ativas</option>
            <option value="inativas"${sel('status','inativas')}>Inativas</option>
          </select>
          <select class="input input-sm" data-action="filter-categoria" data-param="uso">
            <option value="todas"${sel('uso','todas')}>Usadas e não usadas</option>
            <option value="usadas"${sel('uso','usadas')}>Usadas em lançamentos</option>
            <option value="sem_uso"${sel('uso','sem_uso')}>Sem lançamentos</option>
          </select>
        </div>

        <div class="card">
          <table class="data-table">
            ${tableHeader(['Categoria', 'Natureza', 'Comportamento', 'Grupo DRE', 'Lançamentos', 'Status', ''])}
            <tbody>
              ${filtrada.length === 0 ? renderEmptyRow(7, 'Nenhuma categoria no filtro atual.') : filtrada.map((c) => {
                const uso = usoDe(c);
                const secao = secaoDe(c);
                const emUso = uso > 0;
                const inativa = Number(c.ativo) !== 1;
                return `
                <tr${inativa ? ' style="opacity:.55;"' : ''}>
                  <td>
                    <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${escapeHtml(c.cor || '#64748b')};margin-right:8px;vertical-align:middle;"></span>
                    ${escapeHtml(c.nome)}
                  </td>
                  <td>${escapeHtml(NATUREZA_LABEL[c.natureza] || '—')}</td>
                  <td>${escapeHtml(COMPORTAMENTO_LABEL[c.comportamento] || '—')}</td>
                  <td>${secao ? escapeHtml(DRE_SECAO_LABEL[secao] || secao) : '<span style="color:var(--red);">sem grupo</span>'}</td>
                  <td>${emUso
                        ? `<span title="Lançamentos vinculados">${uso}</span>`
                        : '<span style="color:var(--t1);">0</span>'}</td>
                  <td>${inativa ? 'Inativa' : 'Ativa'}</td>
                  <td style="text-align:right;white-space:nowrap;">
                    ${emUso
                      ? `<button class="btn btn-ghost btn-sm" data-action="ver-lancamentos-categoria" data-param="${escapeHtml(c.id)}" title="Ver lançamentos vinculados">Ver lançamentos</button>`
                      : ''}
                    <button class="btn btn-ghost btn-sm" data-action="open-modal-categoria-edit" data-param="${escapeHtml(c.id)}" title="Editar categoria">Editar</button>
                    ${inativa
                      ? `<button class="btn btn-ghost btn-sm" data-action="reativar-categoria" data-param="${escapeHtml(c.id)}" title="Reativar">Reativar</button>`
                      : `<button class="btn btn-ghost btn-sm" data-action="inativar-categoria" data-param="${escapeHtml(c.id)}" title="Inativar (preserva o histórico)">Inativar</button>`}
                    ${emUso
                      ? `<button class="btn btn-ghost btn-sm" disabled title="Categoria em uso (${uso} lançamento(s)). Inative em vez de excluir." style="opacity:.4;cursor:not-allowed;">Excluir</button>`
                      : `<button class="btn btn-ghost btn-sm" data-action="delete-categoria" data-param="${escapeHtml(c.id)}" title="Excluir (sem histórico)" style="color:var(--red);">Excluir</button>`}
                  </td>
                </tr>
              `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `}
    </section>`;
}
