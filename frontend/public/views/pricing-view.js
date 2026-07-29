import { state, escapeHtml, formatCurrency, moedaAtiva } from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader, tableHeader, renderEmptyRow } from './shared.js?v=20260727-finance-v87';

const UNITS = ['unidade', 'kit', 'kg', 'litro', 'hora', 'diaria', 'projeto', 'mensalidade'];
const PRODUCT_COMPONENTS = [['insumo', 'Insumo'], ['embalagem', 'Embalagem'], ['frete', 'Frete'], ['adicional', 'Adicional']];
const SERVICE_COMPONENTS = [['mao_obra', 'Mão de obra'], ['material', 'Material'], ['terceiro', 'Terceiro'], ['adicional', 'Adicional']];

function value(value) { return escapeHtml(value ?? ''); }
function selected(current, option) { return String(current ?? '') === String(option) ? 'selected' : ''; }
function checked(flag) { return flag ? 'checked' : ''; }
function dateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString('pt-BR');
}

function field(label, path, current, options = {}) {
  const type = options.type || 'text';
  const step = options.step ? `step="${options.step}"` : '';
  const min = options.min !== undefined ? `min="${options.min}"` : '';
  const disabled = options.disabled ? 'disabled' : '';
  return `<label class="field ${options.className || ''}">
    <span class="field-label">${escapeHtml(label)}</span>
    <input class="input" type="${type}" value="${value(current)}" data-action="pricing-field" data-param="${escapeHtml(path)}" ${step} ${min} ${disabled}>
    ${options.hint ? `<span class="field-hint">${escapeHtml(options.hint)}</span>` : ''}
  </label>`;
}

function selectField(label, path, current, entries, options = {}) {
  return `<label class="field ${options.className || ''}">
    <span class="field-label">${escapeHtml(label)}</span>
    <select class="input" data-action="pricing-field" data-param="${escapeHtml(path)}" ${options.disabled ? 'disabled' : ''}>
      ${options.empty ? `<option value="">${escapeHtml(options.empty)}</option>` : ''}
      ${entries.map(([id, name]) => `<option value="${value(id)}" ${selected(current, id)}>${escapeHtml(name)}</option>`).join('')}
    </select>
  </label>`;
}

function statusBadge(version) {
  if (!version) return '<span class="badge badge-neutral">Sem preço</span>';
  if (version.status === 'rascunho') return '<span class="badge badge-warning">Rascunho</span>';
  if (version.status === 'cancelada') return '<span class="badge badge-neutral">Cancelada</span>';
  if (new Date(version.vigencia_inicio).getTime() > Date.now()) return '<span class="badge badge-info">Agendada</span>';
  return '<span class="badge badge-success">Publicada</span>';
}

function renderCatalog() {
  const pricing = state.pricing;
  const search = pricing.search.trim().toLocaleLowerCase('pt-BR');
  const items = pricing.items.filter((item) => {
    if (pricing.typeFilter && item.tipo !== pricing.typeFilter) return false;
    if (!search) return true;
    return [item.nome, item.codigo, item.categoria_nome].some((part) => String(part || '').toLocaleLowerCase('pt-BR').includes(search));
  });
  const admin = state.currentUser?.role === 'admin';
  return `
    ${pageHeader({
      titulo: 'Precificação',
      subtitulo: 'Catálogo oficial de produtos e serviços',
      actions: `${admin ? '<button class="btn btn-ghost" data-action="pricing-management-toggle">Configurações</button><button class="btn btn-primary" data-action="pricing-new">+ Novo item</button>' : ''}`
    })}
    <div class="pricing-toolbar card">
      <label class="field pricing-search"><span class="field-label">Buscar</span><input class="input" value="${value(pricing.search)}" data-action="pricing-search" placeholder="Nome, código ou categoria"></label>
      ${selectField('Tipo', 'filter', pricing.typeFilter, [['', 'Todos'], ['produto', 'Produtos'], ['servico', 'Serviços']])
        .replace('data-action="pricing-field" data-param="filter"', 'data-action="pricing-filter-type"')}
      <button class="btn btn-ghost" data-action="pricing-refresh">Atualizar</button>
    </div>
    ${pricing.management && admin ? renderManagement() : ''}
    <div class="card pricing-table-card">
      <table class="data-table pricing-table">
        ${tableHeader(['Item', 'Tipo', 'Categoria', 'Preço inicial', 'Situação', 'Próxima vigência', ''])}
        <tbody>
          ${items.length ? items.map((item) => `<tr>
            <td data-label="Item"><strong>${escapeHtml(item.nome)}</strong><small class="pricing-subline">${escapeHtml(item.codigo || item.unidade || '')}</small></td>
            <td data-label="Tipo">${item.tipo === 'servico' ? 'Serviço' : 'Produto'}</td>
            <td data-label="Categoria">${escapeHtml(item.categoria_nome || '-')}</td>
            <td data-label="Preço inicial">${item.preco_vigente == null ? '-' : formatCurrency(item.preco_vigente)}</td>
            <td data-label="Situação">${item.rascunho_id ? '<span class="badge badge-warning">Rascunho</span>' : item.versao_vigente_id ? '<span class="badge badge-success">Vigente</span>' : '<span class="badge badge-neutral">Sem preço</span>'}</td>
            <td data-label="Próxima vigência">${dateTime(item.proxima_vigencia)}</td>
            <td class="pricing-actions"><button class="btn btn-ghost btn-sm" data-action="pricing-select" data-param="${value(item.id)}">Abrir</button></td>
          </tr>`).join('') : renderEmptyRow(7, 'Nenhum item encontrado.')}
        </tbody>
      </table>
    </div>`;
}

function renderManagement() {
  const pricing = state.pricing;
  const config = pricing.config || {};
  return `<section class="pricing-management" aria-label="Configurações de precificação">
    <div class="card">
      <div class="pricing-section-title"><div><h3>Padrões da empresa</h3><p>Aplicados a novos rascunhos. Versões publicadas não são recalculadas.</p></div><button class="btn btn-primary btn-sm" data-action="pricing-save-config">Salvar</button></div>
      <div class="pricing-grid-3">
        ${field('Impostos (%)', 'config.impostos_pct', config.impostos_pct, { type: 'number', step: '0.0001', min: 0 })}
        ${field('Comissão (%)', 'config.comissao_pct', config.comissao_pct, { type: 'number', step: '0.0001', min: 0 })}
        ${field('Despesas variáveis (%)', 'config.despesas_variaveis_pct', config.despesas_variaveis_pct, { type: 'number', step: '0.0001', min: 0 })}
        ${field('Margem padrão (%)', 'config.margem_padrao_pct', config.margem_padrao_pct, { type: 'number', step: '0.0001', min: 0 })}
        ${selectField('Rateio', 'config.rateio_tipo', config.rateio_tipo, [['percentual', 'Percentual do custo direto'], ['fixo', 'Valor fixo por unidade']])}
        ${field(config.rateio_tipo === 'fixo' ? `Rateio (${moedaAtiva()})` : 'Rateio (%)', 'config.rateio_valor', config.rateio_valor, { type: 'number', step: '0.0001', min: 0 })}
      </div>
    </div>
    <div class="pricing-management-grid">
      <div class="card">
        <div class="pricing-section-title"><div><h3>Categorias comerciais</h3><p>Separadas das categorias financeiras.</p></div></div>
        <div class="pricing-inline-create"><input id="pricing-category-name" class="input" placeholder="Nova categoria"><button class="btn btn-primary btn-sm" data-action="pricing-add-category">Adicionar</button></div>
        <ul class="list-clean pricing-config-list">${pricing.categories.map((category) => `<li><span>${escapeHtml(category.nome)}</span><button class="btn btn-ghost btn-sm" data-action="pricing-toggle-category" data-param="${value(category.id)}">${category.ativo ? 'Desativar' : 'Ativar'}</button></li>`).join('') || '<li class="muted">Nenhuma categoria.</li>'}</ul>
      </div>
      <div class="card">
        <div class="pricing-section-title"><div><h3>Funções e custo-hora</h3><p>Usadas nos componentes de mão de obra.</p></div></div>
        <div class="pricing-inline-create pricing-function-create"><input id="pricing-function-name" class="input" placeholder="Função"><input id="pricing-function-cost" class="input" type="number" min="0" step="0.01" placeholder="${moedaAtiva()}/hora"><button class="btn btn-primary btn-sm" data-action="pricing-add-function">Adicionar</button></div>
        <ul class="list-clean pricing-config-list">${pricing.functions.map((fn) => `<li><span>${escapeHtml(fn.nome)} <small>${formatCurrency(fn.custo_hora)}/h</small></span><button class="btn btn-ghost btn-sm" data-action="pricing-toggle-function" data-param="${value(fn.id)}">${fn.ativo ? 'Desativar' : 'Ativar'}</button></li>`).join('') || '<li class="muted">Nenhuma função.</li>'}</ul>
      </div>
    </div>
  </section>`;
}

function currentVersion(item) {
  return (item.versoes || []).filter((v) => v.status === 'publicada' && new Date(v.vigencia_inicio).getTime() <= Date.now())
    .sort((a, b) => new Date(b.vigencia_inicio) - new Date(a.vigencia_inicio))[0] || null;
}

function renderDetail(item) {
  const admin = state.currentUser?.role === 'admin';
  const current = currentVersion(item);
  const draft = (item.versoes || []).find((v) => v.status === 'rascunho');
  return `
    ${pageHeader({ titulo: item.nome, subtitulo: `${item.tipo === 'servico' ? 'Serviço' : 'Produto'} · ${item.unidade}`, actions: `
      <button class="btn btn-ghost" data-action="pricing-back">Voltar</button>
      ${current ? '<button class="btn btn-ghost" data-action="pricing-open-simulator">Simular</button>' : ''}
      ${admin ? `<button class="btn btn-primary" data-action="pricing-edit">${draft ? 'Continuar rascunho' : 'Novo rascunho'}</button>` : ''}` })}
    <div class="pricing-summary-grid">
      <div class="card"><span class="kpi-label">Preço inicial vigente</span><strong class="pricing-big-number">${current?.faixas?.[0] ? formatCurrency(current.faixas[0].preco_sugerido) : '-'}</strong><small>${current ? `Versão ${current.numero} · ${dateTime(current.vigencia_inicio)}` : 'Nenhuma versão vigente'}</small></div>
      <div class="card"><span class="kpi-label">Custo direto</span><strong class="pricing-big-number">${current ? formatCurrency(current.custo_direto) : '-'}</strong><small>${current?.componentes?.length || 0} componente(s)</small></div>
      <div class="card"><span class="kpi-label">Categoria</span><strong class="pricing-big-number pricing-text-number">${escapeHtml(item.categoria_nome || 'Sem categoria')}</strong><small>${escapeHtml(item.codigo || 'Sem código')}</small></div>
    </div>
    ${current ? renderResult(current) : '<div class="card empty-state"><h3>Sem preço publicado</h3><p>Um administrador precisa criar e publicar o primeiro rascunho.</p></div>'}
    <div class="card pricing-history">
      <h3>Histórico de versões</h3>
      <div class="pricing-history-list">${(item.versoes || []).map((version) => `<article>
        <div><strong>Versão ${version.numero}</strong> ${statusBadge(version)}<small>Criada por ${escapeHtml(version.created_by_nome || version.created_by || '-')} · ${dateTime(version.createdAt)}</small></div>
        <div><span>${version.vigencia_inicio ? `Vigência: ${dateTime(version.vigencia_inicio)}` : 'Sem vigência'}</span>${admin && version.status === 'publicada' && new Date(version.vigencia_inicio).getTime() > Date.now() ? `<button class="btn btn-ghost btn-sm" data-action="pricing-cancel-version" data-param="${value(version.id)}">Cancelar agendamento</button>` : ''}</div>
      </article>`).join('') || '<p class="muted">Nenhuma versão.</p>'}</div>
    </div>`;
}

function renderResult(result) {
  if (!result?.faixas?.length) return '<div class="card empty-state"><h3>Cálculo pendente</h3><p>Preencha os custos e execute a simulação.</p></div>';
  return `<div class="card pricing-result">
    <div class="pricing-section-title"><div><h3>Preços por volume</h3><p>Preço mínimo cobre custos e encargos. Preço sugerido inclui a margem-alvo.</p></div></div>
    <div class="pricing-result-grid">${result.faixas.map((range) => `<article>
      <span class="badge badge-info">${range.quantidade_max == null ? `${range.quantidade_min}+` : `${range.quantidade_min}–${range.quantidade_max}`} ${escapeHtml(state.pricing.editor?.item?.unidade || state.pricing.selected?.unidade || 'un.')}</span>
      <div><small>Custo base</small><strong>${formatCurrency(range.custo_base)}</strong></div>
      <div><small>Preço mínimo</small><strong>${formatCurrency(range.preco_minimo)}</strong></div>
      <div class="pricing-highlight"><small>Preço sugerido</small><strong>${formatCurrency(range.preco_sugerido)}</strong></div>
      <div><small>Margem</small><strong>${Number(range.margem_resultante_pct).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%</strong></div>
    </article>`).join('')}</div>
  </div>`;
}

function renderComponents(editor) {
  const components = editor.version.componentes || [];
  const types = editor.item.tipo === 'servico' ? SERVICE_COMPONENTS : PRODUCT_COMPONENTS;
  return `<div class="pricing-step">
    <div class="pricing-section-title"><div><h3>Composição de custos</h3><p>Valores ficam congelados na versão publicada.</p></div><button class="btn btn-primary btn-sm" data-action="pricing-add-component">+ Componente</button></div>
    <div class="pricing-component-list">${components.map((component, index) => `<article class="card pricing-component">
      ${selectField('Tipo', `componentes.${index}.tipo`, component.tipo, types)}
      ${component.tipo === 'mao_obra' ? selectField('Função', `componentes.${index}.funcao_id`, component.funcao_id, state.pricing.functions.filter((fn) => fn.ativo || fn.id === component.funcao_id).map((fn) => [fn.id, `${fn.nome} · ${formatCurrency(fn.custo_hora)}/h`]), { empty: 'Selecione' }) : field('Nome', `componentes.${index}.nome`, component.nome)}
      ${field(component.tipo === 'mao_obra' ? 'Horas' : 'Quantidade', `componentes.${index}.quantidade`, component.quantidade, { type: 'number', step: '0.000001', min: 0 })}
      ${field(component.tipo === 'mao_obra' ? 'Custo-hora' : 'Custo unitário', `componentes.${index}.custo_unitario`, component.custo_unitario, { type: 'number', step: '0.000001', min: 0, disabled: component.tipo === 'mao_obra' })}
      ${editor.item.tipo === 'produto' ? field('Perda (%)', `componentes.${index}.perda_pct`, component.perda_pct || 0, { type: 'number', step: '0.0001', min: 0 }) : ''}
      <button class="btn-icon pricing-remove" data-action="pricing-remove-component" data-param="${index}" title="Remover componente" aria-label="Remover componente">x</button>
    </article>`).join('') || '<div class="empty-state"><h3>Sem componentes</h3><p>Adicione ao menos um custo direto.</p></div>'}</div>
  </div>`;
}

function renderRanges(editor) {
  const ranges = editor.version.faixas || [];
  return `<div class="pricing-step">
    <div class="pricing-section-title"><div><h3>Faixas de volume</h3><p>A primeira inicia em 1 e a última não possui limite máximo.</p></div><button class="btn btn-primary btn-sm" data-action="pricing-add-range">+ Faixa</button></div>
    <div class="pricing-range-list">${ranges.map((range, index) => `<article class="card pricing-range">
      <span class="pricing-range-index">${index + 1}</span>
      ${field('Quantidade mínima', `faixas.${index}.quantidade_min`, range.quantidade_min, { type: 'number', step: 1, min: 1, disabled: index === 0 })}
      ${field('Quantidade máxima', `faixas.${index}.quantidade_max`, range.quantidade_max ?? '', { type: 'number', step: 1, min: 1, disabled: index === ranges.length - 1, hint: index === ranges.length - 1 ? 'Sem limite' : '' })}
      ${field('Ajuste de custo (%)', `faixas.${index}.custo_ajuste_pct`, range.custo_ajuste_pct || 0, { type: 'number', step: '0.0001' })}
      ${field('Margem-alvo (%)', `faixas.${index}.margem_alvo_pct`, range.margem_alvo_pct, { type: 'number', step: '0.0001', min: 0 })}
      ${ranges.length > 1 ? `<button class="btn-icon pricing-remove" data-action="pricing-remove-range" data-param="${index}" title="Remover faixa" aria-label="Remover faixa">x</button>` : ''}
    </article>`).join('')}</div>
  </div>`;
}

function renderEditor(editor) {
  const version = editor.version;
  const tabs = [['dados', '1. Dados'], ['custos', '2. Custos'], ['parametros', '3. Encargos'], ['faixas', '4. Faixas'], ['resultado', '5. Resultado']];
  let body = '';
  if (state.pricing.tab === 'dados') body = `<div class="pricing-step pricing-grid-2">
    ${field('Nome', 'item.nome', editor.item.nome)}
    ${field('Código', 'item.codigo', editor.item.codigo || '')}
    ${selectField('Tipo', 'item.tipo', editor.item.tipo, [['produto', 'Produto'], ['servico', 'Serviço']], { disabled: Boolean(editor.item.id) })}
    ${selectField('Categoria', 'item.categoria_id', editor.item.categoria_id, state.pricing.categories.filter((c) => c.ativo || c.id === editor.item.categoria_id).map((c) => [c.id, c.nome]), { empty: 'Sem categoria' })}
    ${selectField('Unidade', 'item.unidade', UNITS.includes(editor.item.unidade) ? editor.item.unidade : 'personalizada', [...UNITS.map((unit) => [unit, unit]), ['personalizada', 'Personalizada']])}
    ${editor.item.unidade === 'personalizada' || !UNITS.includes(editor.item.unidade) ? field('Unidade personalizada', 'item.unidade_personalizada', editor.item.unidade_personalizada || (!UNITS.includes(editor.item.unidade) ? editor.item.unidade : '')) : ''}
    <label class="field pricing-span-2"><span class="field-label">Descrição</span><textarea class="input" rows="4" data-action="pricing-field" data-param="item.descricao">${value(editor.item.descricao)}</textarea></label>
  </div>`;
  if (state.pricing.tab === 'custos') body = renderComponents(editor);
  if (state.pricing.tab === 'parametros') body = `<div class="pricing-step pricing-grid-3">
    ${field('Impostos (%)', 'version.impostos_pct', version.impostos_pct, { type: 'number', step: '0.0001', min: 0 })}
    ${field('Comissão (%)', 'version.comissao_pct', version.comissao_pct, { type: 'number', step: '0.0001', min: 0 })}
    ${field('Despesas variáveis (%)', 'version.despesas_variaveis_pct', version.despesas_variaveis_pct, { type: 'number', step: '0.0001', min: 0 })}
    ${field('Margem padrão (%)', 'version.margem_padrao_pct', version.margem_padrao_pct, { type: 'number', step: '0.0001', min: 0 })}
    ${selectField('Tipo de rateio', 'version.rateio_tipo', version.rateio_tipo, [['percentual', 'Percentual do custo direto'], ['fixo', 'Valor fixo por unidade']])}
    ${field(version.rateio_tipo === 'fixo' ? `Rateio (${moedaAtiva()})` : 'Rateio (%)', 'version.rateio_valor', version.rateio_valor, { type: 'number', step: '0.0001', min: 0 })}
    <div class="card pricing-dre-reference pricing-span-3"><strong>Referência gerencial</strong><span>Consulte o DRE para definir o rateio. O histórico financeiro não altera este cálculo automaticamente.</span><button class="btn btn-ghost btn-sm" data-action="change-view" data-param="dre">Abrir DRE</button></div>
  </div>`;
  if (state.pricing.tab === 'faixas') body = renderRanges(editor);
  if (state.pricing.tab === 'resultado') body = `${renderResult(state.pricing.result)}<div class="pricing-result-action"><button class="btn btn-primary" data-action="pricing-simulate">Recalcular simulação</button></div>`;

  return `
    ${pageHeader({ titulo: editor.simulationOnly ? `Simular · ${editor.item.nome}` : editor.item.id ? `Rascunho · ${editor.item.nome}` : 'Novo item', subtitulo: editor.simulationOnly ? 'A simulação não será armazenada' : `Versão ${version.numero || 'nova'}`, actions: '<button class="btn btn-ghost" data-action="pricing-back">Fechar</button>' })}
    <nav class="pricing-steps" aria-label="Etapas da precificação">${tabs.map(([id, label]) => `<button class="${state.pricing.tab === id ? 'active' : ''}" data-action="pricing-tab" data-param="${id}">${label}</button>`).join('')}</nav>
    <div class="card pricing-editor">${body}</div>
    <div class="pricing-editor-footer">
      <span class="muted">${state.pricing.dirty ? 'Alterações não salvas' : editor.simulationOnly ? 'Simulação temporária' : 'Rascunho salvo'}</span>
      <div class="pricing-publish-controls">
        ${!editor.simulationOnly ? `<label><span>Vigência opcional</span><input class="input input-sm" type="datetime-local" value="${value(editor.effectiveAt || '')}" data-action="pricing-field" data-param="effectiveAt"></label>` : ''}
        <button class="btn btn-ghost" data-action="pricing-simulate">Simular</button>
        ${!editor.simulationOnly ? '<button class="btn btn-primary" data-action="pricing-save-draft">Salvar rascunho</button><button class="btn btn-primary" data-action="pricing-publish">Publicar</button>' : ''}
      </div>
    </div>`;
}

export function renderPricingView() {
  const pricing = state.pricing;
  if (pricing.loading) return '<section class="page-section"><div class="card empty-state"><span class="loading"></span><h3>Carregando precificação</h3></div></section>';
  if (pricing.error) return `<section class="page-section">${pageHeader({ titulo: 'Precificação', subtitulo: 'Catálogo oficial' })}<div class="card empty-state"><h3>Não foi possível carregar</h3><p>${escapeHtml(pricing.error)}</p><button class="btn btn-primary" data-action="pricing-refresh">Tentar novamente</button></div></section>`;
  if (!pricing.loaded) return `<section class="page-section">${pageHeader({ titulo: 'Precificação', subtitulo: 'Catálogo oficial' })}<div class="card empty-state"><h3>Dados ainda não carregados</h3><button class="btn btn-primary" data-action="pricing-refresh">Carregar</button></div></section>`;
  return `<section class="page-section pricing-page">${pricing.editor ? renderEditor(pricing.editor) : pricing.selected ? renderDetail(pricing.selected) : renderCatalog()}</section>`;
}
