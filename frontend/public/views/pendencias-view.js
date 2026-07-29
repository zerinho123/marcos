// ============================================================================
// views/pendencias-view.js - Pendências de classificação
// ----------------------------------------------------------------------------
// Centraliza registros incompletos para correção sem esconder dados do usuário.
// No workspace pessoal não há dependência de DRE.
// ============================================================================

import { state, escapeHtml, formatCurrency, formatDateBR } from '../finance-core.js?v=20260727-finance-v87';
import { pageHeader } from './shared.js?v=20260727-finance-v87';

function statCard(valor, rotulo, alerta) {
  const cor = valor > 0 && alerta ? 'var(--red)' : 'var(--t0)';
  return `<div class="card" style="flex:1;min-width:150px;">
    <div style="font-size:1.6rem;font-weight:700;color:${cor};">${valor}</div>
    <div style="color:var(--t2);font-size:.85rem;">${escapeHtml(rotulo)}</div>
  </div>`;
}

function ignorados() {
  return state.filters.pendIgnore || (state.filters.pendIgnore = {});
}

const chaveIgn = (tipo, id) => `${tipo}:${id}`;
const TEST_DATA_TERMS = ['bug qa', 'marselo careca', 'qa178', 'bla bla bla', 'blá blá blá'];

function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function hasTestTerm(...parts) {
  const text = norm(parts.join(' '));
  return TEST_DATA_TERMS.some((term) => text.includes(norm(term)));
}

function candidate(tipo, id, rotulo, sub, fields = []) {
  if (!id || !hasTestTerm(rotulo, sub, ...fields)) return null;
  return {
    tipo,
    id: String(id),
    rotulo: String(rotulo || '(sem nome)'),
    sub: String(sub || ''),
    key: `${tipo}:${id}`
  };
}

export function testDataCandidates() {
  const out = [];
  const push = (item) => { if (item) out.push(item); };

  for (const c of (state.data.contas || [])) {
    push(candidate('conta', c.id, c.nome, `Conta bancária - ${formatCurrency(c.saldo || 0, c.moeda)}`, [c.tipo, c.escopo]));
  }
  for (const c of (state.data.categorias || [])) {
    push(candidate('categoria', c.id, c.nome, 'Categoria', [c.natureza, c.comportamento, c.dre_secao, c.dre_secao_efetiva]));
  }
  for (const t of (state.data.transacoes || [])) {
    push(candidate('transacao', t.id, t.descricao || t.categoria_nome || t.conta_nome, `Lançamento - ${formatDateBR(t.data)} - ${formatCurrency(t.valor, t.moeda)}`, [t.categoria_nome, t.conta_nome, t.tipo]));
  }
  for (const c of (state.data.contasPagar || [])) {
    push(candidate('pagar', c.id, c.credor || c.descricao, `A pagar - ${formatDateBR(c.vencimento)} - ${formatCurrency(c.valor, c.moeda)}`, [c.categoria_nome, c.conta_nome]));
  }
  for (const c of (state.data.contasReceber || [])) {
    push(candidate('receber', c.id, c.devedor_nome || c.descricao, `A receber - ${formatDateBR(c.vencimento)} - ${formatCurrency(c.valor, c.moeda)}`, [c.devedor_email, c.categoria_nome, c.conta_nome]));
  }
  for (const d of (state.data.dividas || [])) {
    push(candidate('divida', d.id, d.credor, `Dívida - ${formatCurrency(d.saldo_devedor || 0)}`, [d.tipo, d.status]));
  }
  for (const m of (state.data.metas || [])) {
    push(candidate('meta', m.id, m.nome || m.titulo, `Meta - ${formatCurrency(m.valor_alvo || 0)}`, [m.prazo]));
  }
  for (const o of (state.data.orcamentos || [])) {
    push(candidate('orcamento', o.id, o.descricao || o.categoria_nome || o.categoria_id, `Orçamento - ${formatCurrency(o.limite || 0)}`, [o.mes, o.categoria_nome]));
  }

  return out;
}

function secao(titulo, descricao, itens) {
  if (!itens.length) return '';
  return `
    <div class="card" style="margin-bottom:16px;">
      <h3 style="margin:0 0 2px;">${escapeHtml(titulo)} <span style="color:var(--red);">(${itens.length})</span></h3>
      <p style="color:var(--t1);font-size:.85rem;margin:0 0 12px;">${escapeHtml(descricao)}</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${itens.join('')}
      </div>
    </div>`;
}

function linha(rotulo, sub, acaoBtn, tipo, id) {
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid var(--b1);border-radius:8px;">
      <div style="min-width:0;">
        <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${rotulo}</div>
        ${sub ? `<div style="color:var(--t1);font-size:.8rem;">${sub}</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;white-space:nowrap;">
        ${acaoBtn}
        <button class="btn btn-ghost btn-sm" data-action="pendencia-ignorar" data-param="${escapeHtml(tipo)}:${escapeHtml(id)}" title="Ignorar nesta sessão">Ignorar</button>
      </div>
    </div>`;
}

function limpezaLinha(item) {
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid var(--b1);border-radius:8px;">
      <div style="min-width:0;">
        <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.rotulo)}</div>
        <div style="color:var(--t1);font-size:.8rem;">${escapeHtml(item.sub)} - ${escapeHtml(item.tipo)}</div>
      </div>
      <button class="btn btn-danger btn-sm" data-action="cleanup-test-data-one" data-param="${escapeHtml(item.key)}">Remover</button>
    </div>`;
}

function secaoLimpeza(itens) {
  if (!itens.length) return '';
  return `
    <div class="card" style="margin-bottom:16px;border-color:rgba(248,113,113,.35);">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px;">
        <div>
          <h3 style="margin:0 0 2px;">Limpeza de dados de teste <span style="color:var(--red);">(${itens.length})</span></h3>
          <p style="color:var(--t1);font-size:.85rem;margin:0;">Revise a lista antes de remover registros visíveis com termos de QA.</p>
        </div>
        <button class="btn btn-danger btn-sm" data-action="cleanup-test-data-all">Remover todos</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${itens.map(limpezaLinha).join('')}
      </div>
    </div>`;
}

export function renderPendenciasView() {
  const ign = ignorados();
  const visivel = (tipo, id) => !ign[chaveIgn(tipo, id)];
  const isEmpresarial = state.workspace === 'empresarial';

  const transacoes = state.data.transacoes || [];
  const categorias = state.data.categorias || [];
  const catById = new Map(categorias.map((c) => [String(c.id), c]));
  const secaoDe = (c) => c?.dre_secao_efetiva ?? c?.dre_secao ?? null;

  const lancSemCat = transacoes
    .filter((t) => !t.categoria_id && visivel('tx', t.id))
    .map((t) => linha(
      escapeHtml(t.descricao || '(sem descrição)'),
      `${formatDateBR(t.data)} - ${formatCurrency(t.valor, t.moeda)} - ${escapeHtml(t.conta_nome || '-')}`,
      `<button class="btn btn-primary btn-sm" data-action="open-modal-transacao-edit" data-param="${escapeHtml(t.id)}">Classificar</button>`,
      'tx', t.id
    ));

  const lancCatInativa = transacoes
    .filter((t) => {
      if (!t.categoria_id || !visivel('txinat', t.id)) return false;
      const c = catById.get(String(t.categoria_id));
      return c && Number(c.ativo) === 0;
    })
    .map((t) => linha(
      escapeHtml(t.descricao || '(sem descrição)'),
      `${formatDateBR(t.data)} - ${formatCurrency(t.valor, t.moeda)} - categoria inativa: ${escapeHtml(t.categoria_nome || '-')}`,
      `<button class="btn btn-primary btn-sm" data-action="open-modal-transacao-edit" data-param="${escapeHtml(t.id)}">Reclassificar</button>`,
      'txinat', t.id
    ));

  const catsSemGrupo = isEmpresarial ? categorias
    .filter((c) => {
      const tipo = c.tipo || 'pessoal';
      const noEscopo = tipo === 'empresarial' || tipo === 'ambos';
      return noEscopo && Number(c.ativo) === 1 && !secaoDe(c) && visivel('cat', c.id);
    })
    .map((c) => linha(
      escapeHtml(c.nome),
      'Sem grupo no DRE - não entra na cascata do relatório.',
      `<button class="btn btn-primary btn-sm" data-action="open-modal-categoria-edit" data-param="${escapeHtml(c.id)}">Editar categoria</button>`,
      'cat', c.id
    )) : [];

  const apSemCat = (state.data.contasPagar || [])
    .filter((c) => !c.categoria_id && visivel('ap', c.id))
    .map((c) => linha(
      escapeHtml(c.credor || '(sem credor)'),
      `Vence ${formatDateBR(c.vencimento)} - ${formatCurrency(c.valor, c.moeda)}`,
      `<button class="btn btn-primary btn-sm" data-action="open-modal-pagar-edit" data-param="${escapeHtml(c.id)}">Classificar</button>`,
      'ap', c.id
    ));

  const arSemCat = (state.data.contasReceber || [])
    .filter((c) => !c.categoria_id && visivel('ar', c.id))
    .map((c) => linha(
      escapeHtml(c.devedor_nome || '(sem cliente)'),
      `Vence ${formatDateBR(c.vencimento)} - ${formatCurrency(c.valor, c.moeda)}`,
      `<button class="btn btn-primary btn-sm" data-action="open-modal-receber-edit" data-param="${escapeHtml(c.id)}">Classificar</button>`,
      'ar', c.id
    ));

  const total = lancSemCat.length + lancCatInativa.length + catsSemGrupo.length + apSemCat.length + arSemCat.length;
  const limpeza = testDataCandidates();

  return `
    <section class="page-section">
      ${pageHeader({
        titulo: 'Pendências de classificação',
        subtitulo: isEmpresarial
          ? 'Registros que precisam de categoria ou grupo para entrarem corretamente nos relatórios.'
          : 'Registros pessoais que precisam de categoria para entrarem corretamente no painel.'
      })}

      ${secaoLimpeza(limpeza)}

      ${total === 0 ? `
        <div class="card empty-state">
          <h3>Tudo classificado</h3>
          <p>Nenhuma pendência neste workspace. Lançamentos, categorias e contas estão completos.</p>
        </div>
      ` : `
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
          ${statCard(lancSemCat.length, 'Lançamentos sem categoria', true)}
          ${statCard(lancCatInativa.length, 'Categoria inativa', true)}
          ${isEmpresarial ? statCard(catsSemGrupo.length, 'Categorias sem grupo DRE', true) : ''}
          ${statCard(apSemCat.length + arSemCat.length, 'A pagar/receber sem categoria', true)}
        </div>

        ${secao('Lançamentos sem categoria', isEmpresarial ? 'Classifique para entrarem no DRE, no fluxo e em Despesas Variáveis.' : 'Classifique para entrarem no painel pessoal e nos totais por categoria.', lancSemCat)}
        ${secao('Lançamentos com categoria inativa', 'A categoria foi inativada - reclassifique para um grupo ativo.', lancCatInativa)}
        ${isEmpresarial ? secao('Categorias sem grupo no DRE', 'Defina o grupo para a categoria aparecer na cascata do DRE.', catsSemGrupo) : ''}
        ${secao('Contas a pagar sem categoria', 'Toda conta a pagar precisa de categoria antes de ser paga.', apSemCat)}
        ${secao('Contas a receber sem categoria', 'Toda conta a receber precisa de categoria antes de ser recebida.', arSemCat)}
      `}
    </section>`;
}
