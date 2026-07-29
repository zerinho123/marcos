// ============================================================================
// views/modal-view.js - render dos modais (formulários)
// ============================================================================

import { state, escapeHtml, todayInputValue, categoriasDoWorkspace, contasDoWorkspace, MOEDAS, moedaAtiva, formatCurrency } from '../finance-core.js?v=20260727-finance-v87';
import { icon } from '../lib/vendor/lucide.min.js?v=20260727-finance-v87';

// showWorkspace=false só pra modais sem noção de ambiente (ex.: gestão de
// usuário Finance, que não é escopada por Pessoal/Empresarial). Em todo o
// resto o badge aparece sempre, no mesmo lugar, com a mesma cor por ambiente
// (ciano=empresarial, amarelo=pessoal) — antes só "Nova conta" indicava isso,
// e de um jeito diferente da "Nova categoria" (que só mudava o título); o
// modal mais usado (lançamento) não indicava nada.
function shell(titulo, bodyHtml, { showWorkspace = true } = {}) {
  const isEmp = state.workspace === 'empresarial';
  const badge = showWorkspace
    ? `<p class="modal-workspace-badge modal-workspace-badge-${isEmp ? 'empresarial' : 'pessoal'}">
         <span aria-hidden="true">${isEmp ? '▦' : '◐'}</span> ${isEmp ? 'Empresarial' : 'Pessoal'}
       </p>`
    : '';
  return `
    <div id="modal-backdrop" class="modal-backdrop">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="finance-modal-title" tabindex="-1">
        <header class="modal-header">
          <h2 class="modal-title" id="finance-modal-title">${escapeHtml(titulo)}</h2>
          <button type="button" class="btn-icon" data-action="close-modal" aria-label="Fechar">${icon('x', { size: 16 })}</button>
        </header>
        ${badge}
        <div class="modal-error-slot" role="alert" aria-live="assertive"></div>
        ${bodyHtml}
      </div>
    </div>`;
}

// Texto-guia "Entra como: Despesa - Variável - CMV" a partir da classificação da
// categoria. Usa a seção efetiva do DRE (mapa) com fallback na coluna legada.
// (As tabelas CAT_* ficam logo abaixo - resolvidas em tempo de render.)
function catHint(cat) {
  if (!cat) return '';
  const lbl = (pairs, v) => (pairs.find(([k]) => k === v) || [])[1];
  const sec = cat.dre_secao_efetiva || cat.dre_secao;
  const parts = [
    lbl(CAT_NATUREZAS, cat.natureza),
    lbl(CAT_COMPORTAMENTOS, cat.comportamento),
    lbl(CAT_DRE_SECOES, sec)
  ].filter(Boolean);
  return parts.length ? `Entra como: ${parts.join(' - ')}` : '';
}

function renderTransacao(modal) {
  const f = modal.form;
  const editing = !!modal.editingId;
  // #9 Sugere categorias da MESMA natureza do lançamento: despesa?categorias de
  // despesa, receita?de receita. Categoria sem natureza definida (legado) continua
  // aparecendo pra não esconder opção de quem ainda não classificou.
  const categorias = categoriasDoWorkspace().filter((c) => !c.natureza || c.natureza === f.tipo);
  const contas     = contasDoWorkspace();
  // Na edição não trocamos o tipo (evita virar um lançamento novo); mostramos o
  // tipo travado. Na criação, o segmento despesa/receita continua disponível.
  const tipoControl = editing
    ? `<p class="muted" style="margin:0 0 4px;font-size:12px;">Tipo: <strong>${f.tipo === 'receita' ? 'Receita' : 'Despesa'}</strong></p>`
    : `<div class="seg">
        <button type="button" class="seg-btn ${f.tipo === 'despesa' ? 'active' : ''}" data-action="open-modal-transacao" data-param="despesa">? Despesa</button>
        <button type="button" class="seg-btn ${f.tipo === 'receita' ? 'active' : ''}" data-action="open-modal-transacao" data-param="receita">? Receita</button>
      </div>`;
  return shell(editing ? 'Editar lançamento' : 'Novo lançamento', `
    <form class="modal-body" novalidate data-form="transacao">
      ${tipoControl}
      <input type="hidden" name="tipo" value="${escapeHtml(f.tipo)}" />
      <label class="field">
        <span class="field-label">Título</span>
        <input class="input" name="titulo" placeholder="Ex: Almoco com cliente" value="${escapeHtml(f.titulo || '')}" />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Valor <span class="req">*</span></span>
          <input class="input" name="valor" inputmode="decimal" placeholder="0,00" value="${escapeHtml(f.valor || '')}" required />
        </label>
        <label class="field">
          <span class="field-label">Data <span class="req">*</span></span>
          <input class="input" name="data" type="date" value="${escapeHtml(f.data || '')}" required />
          <div style="display:flex;gap:6px;margin-top:6px;">
            <button type="button" class="chip" data-action="lancamento-data-rapida" data-param="hoje">Hoje</button>
            <button type="button" class="chip" data-action="lancamento-data-rapida" data-param="ontem">Ontem</button>
          </div>
        </label>
      </div>
      <label class="field">
        <span class="field-label">Categoria <span class="req">*</span></span>
        <select class="input" name="categoria_id" data-action="cat-hint" required>
          <option value="">Selecionar</option>
          ${categorias.map((c) => `<option value="${escapeHtml(c.id)}" data-hint="${escapeHtml(catHint(c))}" ${f.categoria_id === c.id ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}
        </select>
        <p class="hint" id="cat-hint" style="color:var(--t1);margin:6px 0 0;font-size:.8rem;min-height:1em;">${escapeHtml(catHint(categorias.find((c) => String(c.id) === String(f.categoria_id))))}</p>
      </label>
      <label class="field">
        <span class="field-label">Conta bancária <span class="req">*</span></span>
        <select class="input" name="conta_bancaria_id" required>
          <option value="">Selecionar</option>
          ${contas.map((c) => `<option value="${escapeHtml(c.id)}" ${String(f.conta_bancaria_id || '') === String(c.id) ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}
        </select>
      </label>
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        ${editing ? '' : `<button type="submit" class="btn btn-ghost" data-and-new="1">Salvar e novo</button>`}
        <button type="submit" class="btn btn-primary">${editing ? 'Salvar alterações' : 'Salvar lançamento'}</button>
      </footer>
    </form>
  `);
}

function renderConta(modal) {
  const f = modal.form;
  const editing = !!modal.editingId;
  const hasHistory = editing && Number(f.lancamentos_count || 0) > 0;
  const escopo = f.escopo === 'empresarial' ? 'empresarial' : 'pessoal';
  return shell(editing ? 'Editar conta bancária' : 'Nova conta bancária', `
    <form class="modal-body" novalidate data-form="conta">
      <input type="hidden" name="escopo" value="${escapeHtml(escopo)}" />
      <label class="field">
        <span class="field-label">Nome</span>
        <input class="input" name="nome" placeholder="Ex: Itaú Conta Corrente" value="${escapeHtml(f.nome || '')}" required />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Tipo</span>
          <select class="input" name="tipo">
            <option value="corrente" ${f.tipo === 'corrente' ? 'selected' : ''}>Corrente</option>
            <option value="poupanca" ${f.tipo === 'poupanca' ? 'selected' : ''}>Poupança</option>
            <option value="carteira" ${f.tipo === 'carteira' ? 'selected' : ''}>Carteira / Dinheiro</option>
            <option value="investimento" ${f.tipo === 'investimento' ? 'selected' : ''}>Investimento</option>
            <option value="outro" ${f.tipo === 'outro' ? 'selected' : ''}>Outro</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">Moeda</span>
          ${hasHistory ? `<input type="hidden" name="moeda" value="${escapeHtml(f.moeda || moedaAtiva())}" />` : ''}
          <select class="input" name="moeda" ${hasHistory ? 'disabled' : ''}>
            ${MOEDAS.map((m) => `<option value="${m.code}" ${(f.moeda || moedaAtiva()) === m.code ? 'selected' : ''}>${escapeHtml(m.code)} · ${escapeHtml(m.nome)}</option>`).join('')}
          </select>
          ${hasHistory ? '<span class="field-hint">A moeda fica bloqueada depois do primeiro lançamento.</span>' : ''}
        </label>
      </div>
      <div class="field-row">
        ${editing
          ? `<div class="field">
               <span class="field-label">Saldo atual</span>
               <strong>${escapeHtml(formatCurrency(Number(f.saldo || 0), f.moeda || moedaAtiva()))}</strong>
               <span class="field-hint">Para corrigir o saldo, registre uma receita ou despesa de ajuste. Assim o histórico permanece auditável.</span>
             </div>`
          : `<label class="field">
               <span class="field-label">Saldo inicial</span>
               <input class="input" name="saldo_inicial" inputmode="decimal" value="${escapeHtml(f.saldo_inicial || '0')}" />
             </label>`}
      </div>
      <label class="field">
        <span class="field-label">Cor</span>
        <input class="input" name="cor" type="color" value="${escapeHtml(f.cor || '#22d3ee')}" />
      </label>
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Salvar' : 'Criar conta'}</button>
      </footer>
    </form>
  `);
}

// Opções de classificação da categoria - espelham os enums do backend
// (routes/categorias.js): natureza, comportamento e seção do DRE (grupo).
const CAT_NATUREZAS = [
  ['receita', 'Receita'], ['despesa', 'Despesa'],
  ['transferencia', 'Transferência'], ['ajuste', 'Ajuste']
];
const CAT_COMPORTAMENTOS = [
  ['fixa', 'Fixa'], ['variavel', 'Variável'], ['nao_aplica', 'Não se aplica']
];
const CAT_DRE_SECOES = [
  ['receita_bruta', 'Receita bruta'], ['deducoes', 'Deduções'],
  ['cmv', 'CMV'], ['servicos_terceiros', 'Serviços de terceiros'],
  ['comerciais', 'Despesas comerciais'], ['operacionais_diretas', 'Operacionais diretas'],
  ['administrativas', 'Administrativas'], ['nao_operacionais', 'Não operacionais'],
  ['juros_emprestimos', 'Juros/empréstimos'], ['ir', 'Impostos (IR)']
];
const optList = (pairs, sel) => pairs
  .map(([v, l]) => `<option value="${v}" ${String(sel || '') === v ? 'selected' : ''}>${l}</option>`)
  .join('');

function renderCategoria(modal) {
  const f = modal.form;
  const editando = !!modal.editingId;
  const pessoal = state.workspace !== 'empresarial';
  if (pessoal) {
    return shell(editando ? 'Editar categoria pessoal' : 'Nova categoria pessoal', `
      <form class="modal-body" novalidate data-form="categoria">
        <label class="field">
          <span class="field-label">Nome <span class="req">*</span></span>
          <input class="input" name="nome" placeholder="Ex: Mercado" value="${escapeHtml(f.nome || '')}" required />
        </label>

        <label class="field">
          <span class="field-label">Natureza</span>
          <select class="input" name="natureza">
            <option value="despesa" ${String(f.natureza || 'despesa') === 'despesa' ? 'selected' : ''}>Despesa</option>
            <option value="receita" ${String(f.natureza || '') === 'receita' ? 'selected' : ''}>Receita</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">Cor</span>
          <input class="input" name="cor" type="color" value="${escapeHtml(f.cor || '#64748b')}" />
        </label>

        <footer class="modal-footer">
          <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
          <button type="submit" class="btn btn-primary">${editando ? 'Salvar' : 'Criar categoria'}</button>
        </footer>
      </form>
    `);
  }
  return shell(editando ? 'Editar categoria' : 'Nova categoria', `
    <form class="modal-body" novalidate data-form="categoria">
      <p class="hint" style="color:var(--t1);margin:0 0 12px;font-size:.85rem;">
        A classificação define como o lançamento aparece no caixa, no DRE e na precificação.
      </p>

      <label class="field">
        <span class="field-label">Nome <span class="req">*</span></span>
        <input class="input" name="nome" placeholder="Ex: Comissão" value="${escapeHtml(f.nome || '')}" required />
      </label>

      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label class="field" style="flex:1;min-width:140px;">
          <span class="field-label">Natureza</span>
          <select class="input" name="natureza">
            <option value="">-</option>
            ${optList(CAT_NATUREZAS, f.natureza)}
          </select>
        </label>
        <label class="field" style="flex:1;min-width:140px;">
          <span class="field-label">Comportamento</span>
          <select class="input" name="comportamento">
            <option value="">-</option>
            ${optList(CAT_COMPORTAMENTOS, f.comportamento)}
          </select>
        </label>
      </div>

      <label class="field">
        <span class="field-label">Grupo no DRE</span>
        <select class="input" name="dre_secao">
          <option value="">Sem grupo</option>
          ${optList(CAT_DRE_SECOES, f.dre_secao)}
        </select>
      </label>

      <div style="display:flex;gap:16px;flex-wrap:wrap;margin:4px 0 4px;">
        <label class="field-check" style="display:flex;align-items:center;gap:7px;">
          <input type="checkbox" name="usar_no_dre" ${f.usar_no_dre === false ? '' : 'checked'} />
          <span>Entra no DRE</span>
        </label>
        <label class="field-check" style="display:flex;align-items:center;gap:7px;">
          <input type="checkbox" name="usar_na_precificacao" ${f.usar_na_precificacao ? 'checked' : ''} />
          <span>Usar na precificação</span>
        </label>
      </div>

      <label class="field">
        <span class="field-label">Cor</span>
        <input class="input" name="cor" type="color" value="${escapeHtml(f.cor || '#64748b')}" />
      </label>

      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${editando ? 'Salvar' : 'Criar categoria'}</button>
      </footer>
    </form>
  `);
}

function renderReceber(modal) {
  const f = modal.form;
  const editing = !!modal.editingId;
  const contas = contasDoWorkspace('empresarial');
  const categorias = categoriasDoWorkspace('empresarial');
  return shell(editing ? 'Editar conta a receber' : 'Nova conta a receber', `
    <form class="modal-body" novalidate data-form="receber">
      <label class="field">
        <span class="field-label">Cliente</span>
        <input class="input" name="devedor_nome" placeholder="Nome do cliente" value="${escapeHtml(f.devedor_nome || '')}" required />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Valor</span>
          <input class="input" name="valor" inputmode="decimal" value="${escapeHtml(f.valor || '')}" required />
        </label>
        <label class="field">
          <span class="field-label">Vencimento</span>
          <input class="input" name="vencimento" type="date" value="${escapeHtml(f.vencimento || '')}" required />
        </label>
      </div>
      <label class="field">
        <span class="field-label">Categoria</span>
        <select class="input" name="categoria_id">
          <option value="">Selecionar</option>
          ${categorias.map((c) => `<option value="${escapeHtml(c.id)}" ${String(f.categoria_id || '') === String(c.id) ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field-label">Descrição</span>
        <input class="input" name="descricao" placeholder="Opcional" value="${escapeHtml(f.descricao || '')}" />
      </label>
      <label class="field">
        <span class="field-label">Conta vinculada</span>
        <select class="input" name="conta_bancaria_id" required>
          <option value="">Selecionar conta</option>
          ${contas.map((c) => `<option value="${escapeHtml(c.id)}" ${String(f.conta_bancaria_id || '') === String(c.id) ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}
        </select>
      </label>
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Salvar alterações' : 'Criar'}</button>
      </footer>
    </form>
  `);
}

function renderPagar(modal) {
  const f = modal.form;
  const editing = !!modal.editingId;
  const categorias = categoriasDoWorkspace('empresarial');
  const contas = contasDoWorkspace('empresarial');
  return shell(editing ? 'Editar conta a pagar' : 'Nova conta a pagar', `
    <form class="modal-body" novalidate data-form="pagar">
      <label class="field">
        <span class="field-label">Credor</span>
        <input class="input" name="credor" placeholder="Nome do fornecedor" value="${escapeHtml(f.credor || '')}" required />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Valor</span>
          <input class="input" name="valor" inputmode="decimal" value="${escapeHtml(f.valor || '')}" required />
        </label>
        <label class="field">
          <span class="field-label">Vencimento</span>
          <input class="input" name="vencimento" type="date" value="${escapeHtml(f.vencimento || '')}" required />
        </label>
      </div>
      <label class="field">
        <span class="field-label">Categoria</span>
        <select class="input" name="categoria_id" required>
          <option value="">Selecionar</option>
          ${categorias.map((c) => `<option value="${escapeHtml(c.id)}" ${String(f.categoria_id || '') === String(c.id) ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field-label">Descrição</span>
        <input class="input" name="descricao" placeholder="Opcional" value="${escapeHtml(f.descricao || '')}" />
      </label>
      <label class="field">
        <span class="field-label">Conta vinculada</span>
        <select class="input" name="conta_bancaria_id" required>
          <option value="">Selecionar conta</option>
          ${contas.map((c) => `<option value="${escapeHtml(c.id)}" ${String(f.conta_bancaria_id || '') === String(c.id) ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}
        </select>
      </label>
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Salvar alterações' : 'Criar'}</button>
      </footer>
    </form>
  `);
}

function renderDivida(modal) {
  const f = modal.form;
  const editing = !!modal.editingId;
  const valorOriginal = f.valor_original || f.saldo_devedor || '';
  return shell(editing ? 'Editar dívida' : 'Nova dívida', `
    <form class="modal-body" novalidate data-form="divida">
      <label class="field">
        <span class="field-label">Credor</span>
        <input class="input" name="credor" placeholder="Ex: Cartão Inter" value="${escapeHtml(f.credor || '')}" required />
      </label>
      <label class="field">
        <span class="field-label">Tipo</span>
        <select class="input" name="tipo">
          <option value="cartao_credito" ${f.tipo === 'cartao_credito' ? 'selected' : ''}>Cartão</option>
          <option value="emprestimo" ${f.tipo === 'emprestimo' ? 'selected' : ''}>Empréstimo</option>
          <option value="financiamento" ${f.tipo === 'financiamento' ? 'selected' : ''}>Financiamento</option>
          <option value="cheque_especial" ${f.tipo === 'cheque_especial' ? 'selected' : ''}>Cheque especial</option>
          <option value="outro" ${f.tipo === 'outro' ? 'selected' : ''}>Outro</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">Valor original</span>
        <input class="input" name="valor_original" inputmode="decimal" value="${escapeHtml(valorOriginal)}" required />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Saldo devedor</span>
          <input class="input" name="saldo_devedor" inputmode="decimal" value="${escapeHtml(f.saldo_devedor || '')}" required />
        </label>
        <label class="field">
          <span class="field-label">Taxa de juros (% a.m.)</span>
          <input class="input" name="taxa_juros" type="number" step="0.01" min="0" value="${escapeHtml(f.taxa_juros || '')}" />
        </label>
      </div>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Início</span>
          <input class="input" name="data_inicio" type="date" value="${escapeHtml(f.data_inicio || todayInputValue())}" required />
        </label>
        <label class="field">
          <span class="field-label">Vencimento</span>
          <input class="input" name="data_vencimento" type="date" value="${escapeHtml(f.data_vencimento || '')}" />
        </label>
      </div>
      <label class="field">
        <span class="field-label">Descrição</span>
        <input class="input" name="descricao" placeholder="Opcional" value="${escapeHtml(f.descricao || '')}" />
      </label>
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Salvar alterações' : 'Cadastrar'}</button>
      </footer>
    </form>
  `);
}

function renderMeta(modal) {
  const f = modal.form;
  const editing = Boolean(modal.editingId);
  return shell(editing ? 'Editar meta' : 'Nova meta', `
    <form class="modal-body" novalidate data-form="meta">
      <label class="field">
        <span class="field-label">Título</span>
        <input class="input" name="titulo" placeholder="Ex: Viagem Japão" value="${escapeHtml(f.titulo || '')}" required />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Valor alvo</span>
          <input class="input" name="valor_alvo" inputmode="decimal" value="${escapeHtml(f.valor_alvo || '')}" required />
        </label>
        <label class="field">
          <span class="field-label">Prazo</span>
          <input class="input" name="prazo" type="date" value="${escapeHtml(f.prazo || '')}" />
        </label>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Salvar alterações' : 'Criar meta'}</button>
      </footer>
    </form>
  `);
}

function renderMetaAporte(modal) {
  const f = modal.form;
  return shell('Registrar aporte', `
    <form class="modal-body" novalidate data-form="meta-aporte">
      <p class="muted" style="margin-bottom:12px;">Meta: <strong>${escapeHtml(f.meta_nome || '')}</strong></p>
      <label class="field">
        <span class="field-label">Valor do aporte</span>
        <input class="input" name="valor" inputmode="decimal" value="${escapeHtml(f.valor || '')}" required autofocus />
      </label>
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Registrar</button>
      </footer>
    </form>
  `);
}

function currentMonthInput() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function defaultPeriod(monthValue) {
  const [year, month] = String(monthValue || currentMonthInput()).slice(0, 7).split('-').map(Number);
  const last = new Date(year, month, 0).getDate();
  return {
    inicio: `${year}-${String(month).padStart(2, '0')}-01`,
    fim: `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  };
}

function renderOrcamento(modal) {
  const f = modal.form || {};
  const editing = !!modal.editingId;
  const categorias = categoriasDoWorkspace()
    .filter((c) => c.ativo !== 0)
    .filter((c) => !c.natureza || c.natureza === 'despesa');
  const selected = String(f.categoria_id || '');
  const mes = String(f.mes || currentMonthInput()).slice(0, 7);
  const period = defaultPeriod(mes);
  const inicio = String(f.data_inicio || period.inicio).slice(0, 10);
  const fim = String(f.data_fim || period.fim).slice(0, 10);
  return shell(editing ? 'Editar orçamento' : 'Novo orçamento', `
    <form class="modal-body" novalidate data-form="orcamento">
      <input type="hidden" name="mes" value="${escapeHtml(mes)}" />
      ${editing ? `<input type="hidden" name="categoria_id" value="${escapeHtml(selected)}" />` : ''}
      <p class="muted" style="margin:0 0 4px;font-size:12px;">Mês: <strong>${escapeHtml(mes)}</strong></p>
      <label class="field">
        <span class="field-label">Categoria de despesa <span class="req">*</span></span>
        <select class="input" name="categoria_id" ${editing ? 'disabled' : 'required'}>
          <option value="">Selecionar</option>
          ${categorias.map((c) => `<option value="${escapeHtml(c.id)}" ${String(c.id) === selected ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field-label">Limite mensal <span class="req">*</span></span>
        <input class="input" name="limite" inputmode="decimal" placeholder="0,00" value="${escapeHtml(f.limite || '')}" required autofocus />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Começa em <span class="req">*</span></span>
          <input class="input" name="data_inicio" type="date" value="${escapeHtml(inicio)}" required />
        </label>
        <label class="field">
          <span class="field-label">Reseta em <span class="req">*</span></span>
          <input class="input" name="data_fim" type="date" value="${escapeHtml(fim)}" required />
        </label>
      </div>
      ${categorias.length ? '' : '<p class="muted" style="margin:0;font-size:12px;">Crie uma categoria de despesa antes de cadastrar orçamento.</p>'}
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Salvar' : 'Criar orçamento'}</button>
      </footer>
    </form>
  `);
}

function renderFinanceUser(modal) {
  const f = modal.form;
  const editing = !!modal.editingId;
  return shell(editing ? 'Editar usuário' : 'Novo usuário Finance', `
    <form class="modal-body" novalidate data-form="finance-user">
      <label class="field">
        <span class="field-label">Usuário</span>
        <input class="input" name="username" required value="${escapeHtml(f.username || '')}" ${editing ? 'readonly' : ''} />
      </label>
      <label class="field">
        <span class="field-label">Nome</span>
        <input class="input" name="nome" required value="${escapeHtml(f.nome || '')}" />
      </label>
      <label class="field">
        <span class="field-label">Função</span>
        <select class="input" name="role">
          <option value="usuario" ${f.role === 'usuario' ? 'selected' : ''}>Usuário</option>
          <option value="admin" ${f.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">${editing ? 'Nova senha (deixe vazio pra manter)' : 'Senha'}</span>
        <input class="input" name="password" type="password" autocomplete="new-password" ${editing ? '' : 'required'} />
      </label>
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </footer>
    </form>
  `, { showWorkspace: false });
}

function renderReceberBaixa(modal) {
  const f = modal.form;
  const contas = contasDoWorkspace('empresarial');
  return shell('Registrar recebimento', `
    <form class="modal-body" novalidate data-form="receber-baixa">
      <p class="muted" style="margin:0;font-size:12px;">Cliente: <strong>${escapeHtml(f.titulo || '-')}</strong></p>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Valor recebido</span>
          <input class="input" name="valor" inputmode="decimal" value="${escapeHtml(f.valor || '')}" required autofocus />
        </label>
        <label class="field">
          <span class="field-label">Data</span>
          <input class="input" name="data" type="date" value="${escapeHtml(f.data || '')}" required />
        </label>
      </div>
      <label class="field">
        <span class="field-label">Conta de entrada</span>
        <select class="input" name="conta_bancaria_id" required>
          <option value="">Selecionar conta</option>
          ${contas.map((c) => `<option value="${escapeHtml(c.id)}" ${String(f.conta_bancaria_id || '') === String(c.id) ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}
        </select>
      </label>
      ${f.restanteLabel ? `<p class="muted" style="margin:0;font-size:11px;">Saldo em aberto: ${escapeHtml(f.restanteLabel)}</p>` : ''}
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Confirmar recebimento</button>
      </footer>
    </form>
  `);
}

function renderPagarBaixa(modal) {
  const f = modal.form;
  const contas = contasDoWorkspace('empresarial');
  return shell('Registrar pagamento', `
    <form class="modal-body" novalidate data-form="pagar-baixa">
      <p class="muted" style="margin:0;font-size:12px;">Credor: <strong>${escapeHtml(f.titulo || '-')}</strong></p>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Valor pago</span>
          <input class="input" name="valor" inputmode="decimal" value="${escapeHtml(f.valor || '')}" required autofocus />
        </label>
        <label class="field">
          <span class="field-label">Data</span>
          <input class="input" name="data" type="date" value="${escapeHtml(f.data || '')}" required />
        </label>
      </div>
      <label class="field">
        <span class="field-label">Conta de saída</span>
        <select class="input" name="conta_bancaria_id" required>
          <option value="">Selecionar conta</option>
          ${contas.map((c) => `<option value="${escapeHtml(c.id)}" ${String(f.conta_bancaria_id || '') === String(c.id) ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}
        </select>
      </label>
      ${f.restanteLabel ? `<p class="muted" style="margin:0;font-size:11px;">Saldo em aberto: ${escapeHtml(f.restanteLabel)}</p>` : ''}
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Confirmar pagamento</button>
      </footer>
    </form>
  `);
}

// Diálogo interno (confirm/prompt) - substitui window.confirm/alert/prompt.
// Camada própria por cima do app; só os botões dialog-ok/dialog-cancel resolvem
// (sem fechar no backdrop, pra não descartar uma ação perigosa por engano).
export function renderDialog(d) {
  if (!d) return '';
  const danger = d.variant === 'danger';
  const corpo = d.kind === 'prompt'
    ? `<label class="field" style="margin-top:12px;">
         ${d.label ? `<span class="field-label">${escapeHtml(d.label)}</span>` : ''}
         <input class="input" id="dialog-input" value="${escapeHtml(d.value || '')}" placeholder="${escapeHtml(d.placeholder || '')}" autofocus />
       </label>`
    : (d.description ? `<p class="muted" style="margin:8px 0 0;font-size:13px;line-height:1.45;">${escapeHtml(d.description)}</p>` : '');
  return `
    <div id="dialog-backdrop" class="modal-backdrop dialog-backdrop">
      <div class="modal-card dialog-card" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1">
        <h2 class="modal-title" id="dialog-title">${escapeHtml(d.title || '')}</h2>
        ${corpo}
        <footer class="modal-footer" style="margin-top:18px;">
          <button type="button" class="btn btn-ghost" data-action="dialog-cancel">${escapeHtml(d.cancelLabel || 'Cancelar')}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="dialog-ok">${escapeHtml(d.confirmLabel || 'Confirmar')}</button>
        </footer>
      </div>
    </div>`;
}

// Configurações da conta (self-service). Hoje: moeda padrão pessoal — a moeda
// em que a dashboard consolida os valores e que vem pré-selecionada em contas
// novas. Sem badge de workspace: é uma preferência do usuário, não do ambiente.
function renderSettings(modal) {
  const f = modal.form || {};
  const atual = String(f.moeda || 'BRL').toUpperCase();
  return shell('Configurações', `
    <form class="modal-body" novalidate data-form="settings-moeda">
      <label class="field">
        <span class="field-label">Moeda padrão</span>
        <select class="input" name="moeda" autofocus>
          ${MOEDAS.map((m) => `<option value="${m.code}" ${atual === m.code ? 'selected' : ''}>${escapeHtml(m.code)} · ${escapeHtml(m.simbolo)} · ${escapeHtml(m.nome)}</option>`).join('')}
        </select>
      </label>
      <p class="muted" style="margin:6px 2px 0;font-size:12px;line-height:1.45;">
        Sua dashboard passa a mostrar todos os valores convertidos para esta moeda,
        e ela vem pré-selecionada ao criar novas contas. As contas existentes
        mantêm a moeda própria.
      </p>
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </footer>
    </form>
  `, { showWorkspace: false });
}

export function renderModal(modal) {
  if (!modal) return '';
  switch (modal.type) {
    case 'settings':     return renderSettings(modal);
    case 'transacao':    return renderTransacao(modal);
    case 'conta':        return renderConta(modal);
    case 'categoria':    return renderCategoria(modal);
    case 'receber':      return renderReceber(modal);
    case 'receber-baixa':return renderReceberBaixa(modal);
    case 'pagar':        return renderPagar(modal);
    case 'pagar-baixa':  return renderPagarBaixa(modal);
    case 'divida':       return renderDivida(modal);
    case 'meta':         return renderMeta(modal);
    case 'meta-aporte':  return renderMetaAporte(modal);
    case 'orcamento':    return renderOrcamento(modal);
    case 'finance-user': return renderFinanceUser(modal);
    default: return '';
  }
}
