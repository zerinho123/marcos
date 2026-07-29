// ============================================================================
// routes/_dre-formula.js — DRE Fase 2: linhas de total com fórmula editável
// ----------------------------------------------------------------------------
// A fórmula é uma LISTA ESTRUTURADA DE TERMOS validada — nunca um texto a
// parsear. Por construção é imune a injeção: o avaliador só opera sobre tokens
// já validados (op da whitelist + ref conhecida ou número finito). SEM eval/Function.
//
//   formula = { terms: [ {op:'+|-|*|/', ref:'sec:<secao>'|'row:<chave>'} | {op, value:Number} ] }
//
// Avaliação: precedência padrão (* / antes de + -), esquerda→direita; ÷0 → 0.
// Grouping via linhas-helper ocultas (custos_fixos, mc_ratio) — sem parênteses.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { ERR } from '../security/errors.js';
import { DRE_SECOES } from './_dre-linhas-seed.js';

export const FORMULA_OPS = ['+', '-', '*', '/'];

// Avalia a lista de termos. `resolve(ref)` devolve o valor numérico de uma ref.
export function evalFormula(terms, resolve) {
  if (!Array.isArray(terms) || terms.length === 0) return 0;
  const valOf = (t) => (t.ref != null ? Number(resolve(t.ref) || 0) : Number(t.value || 0));

  // operandos + operadores (op do 1º termo = sinal: '-' nega)
  const nums = [(terms[0].op === '-' ? -1 : 1) * valOf(terms[0])];
  const ops = [];
  for (let i = 1; i < terms.length; i++) { ops.push(terms[i].op); nums.push(valOf(terms[i])); }

  // passo 1: * e / (precedência maior, esquerda→direita; ÷0 → 0)
  const nums2 = [nums[0]];
  const ops2 = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const n = nums[i + 1];
    if (op === '*') {
      nums2[nums2.length - 1] *= n;
    } else if (op === '/') {
      const d = nums2[nums2.length - 1];
      nums2[nums2.length - 1] = n === 0 ? 0 : d / n;
    } else {
      ops2.push(op);
      nums2.push(n);
    }
  }

  // passo 2: + e -
  let acc = nums2[0];
  for (let i = 0; i < ops2.length; i++) {
    acc = ops2[i] === '-' ? acc - nums2[i + 1] : acc + nums2[i + 1];
  }
  return Number.isFinite(acc) ? acc : 0;
}

// Valida/normaliza os termos contra a whitelist de ops e o conjunto de refs.
// sectionKeys/rowKeys = Set de chaves de seção e de linhas-computed conhecidas.
export function validateFormula(terms, { sectionKeys, rowKeys }) {
  if (!Array.isArray(terms) || terms.length === 0) throw ERR.VALIDATION('Formula vazia.');
  if (terms.length > 50) throw ERR.VALIDATION('Formula longa demais (max 50 termos).');
  return terms.map((t, i) => {
    if (!t || typeof t !== 'object') throw ERR.VALIDATION('Termo invalido.');
    const op = i === 0 ? (t.op === '-' ? '-' : '+') : t.op;
    if (!FORMULA_OPS.includes(op)) throw ERR.VALIDATION('Operador invalido: ' + op);
    const hasRef = t.ref != null && t.ref !== '';
    const hasVal = t.value != null && t.value !== '';
    if (hasRef === hasVal) throw ERR.VALIDATION('Cada termo precisa de uma referencia OU um numero.');
    if (hasRef) {
      const ref = String(t.ref);
      const m = /^(sec|row):(.+)$/.exec(ref);
      if (!m) throw ERR.VALIDATION('Referencia invalida: ' + ref);
      const ok = m[1] === 'sec' ? sectionKeys.has(m[2]) : rowKeys.has(m[2]);
      if (!ok) throw ERR.VALIDATION('Referencia desconhecida: ' + ref);
      return { op, ref };
    }
    const n = Number(t.value);
    if (!Number.isFinite(n)) throw ERR.VALIDATION('Valor numerico invalido.');
    return { op, value: n };
  });
}

// Ordena as linhas-computed em ordem topológica (dependência via ref row:*).
// Lança se houver ciclo. `rows` = [{ chave, terms }].
export function topoOrderFormulas(rows) {
  const byChave = new Map(rows.map((r) => [r.chave, r]));
  const order = [];
  const state = new Map(); // chave -> 0 visitando, 1 pronto
  const visit = (chave, trail) => {
    if (state.get(chave) === 1) return;
    if (state.get(chave) === 0) throw ERR.VALIDATION('Ciclo nas formulas: ' + [...trail, chave].join(' → '));
    const row = byChave.get(chave);
    if (!row) return; // ref a row inexistente: ignorada na ordenação (vira 0 no eval)
    state.set(chave, 0);
    for (const t of row.terms || []) {
      if (t.ref && t.ref.startsWith('row:')) visit(t.ref.slice(4), [...trail, chave]);
    }
    state.set(chave, 1);
    order.push(chave);
  };
  for (const r of rows) visit(r.chave, []);
  return order;
}

// Computa o valor (real e plano) de cada linha-computed dado os subtotais de seção.
// secVals: Map secaoKey -> { real, plano }. Retorna Map chave -> { real, plano }.
export function computeFormulas(rows, secVals) {
  const order = topoOrderFormulas(rows);
  const byChave = new Map(rows.map((r) => [r.chave, r]));
  const out = new Map();
  const resolveFor = (col) => (ref) => {
    if (ref.startsWith('sec:')) return secVals.get(ref.slice(4))?.[col] || 0;
    if (ref.startsWith('row:')) return out.get(ref.slice(4))?.[col] || 0;
    return 0;
  };
  for (const chave of order) {
    const row = byChave.get(chave);
    if (!row) continue;
    out.set(chave, {
      real: evalFormula(row.terms, resolveFor('real')),
      plano: evalFormula(row.terms, resolveFor('plano'))
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Seções exibidas (ancoradas) — subtotais das linhas de detalhe por seção.
// `ordem` define a posição na cascata; as computed se intercalam por ordem.
// ----------------------------------------------------------------------------
export const SECTION_ROWS = [
  { secao: 'receita_bruta',        nome: 'RECEITA BRUTA',                    ordem: 100, tipo: 'receita' },
  { secao: 'deducoes',             nome: 'DEDUÇÕES DA RECEITA BRUTA',         ordem: 200, tipo: 'section' },
  { secao: 'ir',                   nome: 'IR',                               ordem: 210, tipo: 'section' },
  { secao: 'cmv',                  nome: 'CMV',                              ordem: 400, tipo: 'section' },
  { secao: 'servicos_terceiros',   nome: 'SERVIÇOS DE TERCEIROS',            ordem: 410, tipo: 'section' },
  { secao: 'operacionais_diretas', nome: 'DESPESAS OPERACIONAIS DIRETAS',     ordem: 600, tipo: 'section' },
  { secao: 'administrativas',      nome: 'DESPESAS ADMINISTRATIVAS',         ordem: 800, tipo: 'section' },
  { secao: 'comerciais',           nome: 'DESPESAS COMERCIAIS',              ordem: 810, tipo: 'section' },
  { secao: 'nao_operacionais',     nome: 'DESPESAS NÃO OPERACIONAIS',        ordem: 820, tipo: 'section' },
  { secao: 'juros_emprestimos',    nome: 'JUROS; EMPRÉSTIMOS; PARCELAMENTO',  ordem: 1000, tipo: 'section' }
];

// Linhas-computed padrão: reproduzem EXATAMENTE o buildModel antigo (regressão).
export const DRE_FORMULA_SEED = [
  { chave: 'receita_liquida', nome: 'RECEITA LÍQUIDA', ordem: 300, oculto: 0, formato: 'currency',
    terms: [{ op: '+', ref: 'sec:receita_bruta' }, { op: '-', ref: 'sec:deducoes' }, { op: '-', ref: 'sec:ir' }] },
  { chave: 'despesas_variaveis', nome: 'DESPESAS VARIÁVEIS', ordem: 420, oculto: 0, formato: 'currency',
    terms: [{ op: '+', ref: 'sec:cmv' }, { op: '+', ref: 'sec:servicos_terceiros' }] },
  { chave: 'margem_contrib', nome: 'MARGEM DE CONTRIBUIÇÃO', ordem: 500, oculto: 0, formato: 'currency',
    terms: [{ op: '+', ref: 'row:receita_liquida' }, { op: '-', ref: 'row:despesas_variaveis' }] },
  { chave: 'resultado_op', nome: 'RESULTADO OPERACIONAL', ordem: 700, oculto: 0, formato: 'currency',
    terms: [{ op: '+', ref: 'row:margem_contrib' }, { op: '-', ref: 'sec:operacionais_diretas' }] },
  { chave: 'ebtda', nome: 'EBTDA', ordem: 900, oculto: 0, formato: 'currency',
    terms: [{ op: '+', ref: 'row:resultado_op' }, { op: '-', ref: 'sec:administrativas' }, { op: '-', ref: 'sec:comerciais' }, { op: '-', ref: 'sec:nao_operacionais' }] },
  { chave: 'lair', nome: 'LUCRO ANTES DE IR', ordem: 1100, oculto: 0, formato: 'currency',
    terms: [{ op: '+', ref: 'row:ebtda' }, { op: '-', ref: 'sec:juros_emprestimos' }] },
  { chave: 'lucro_liquido', nome: 'LUCRO LÍQUIDO', ordem: 1200, oculto: 0, formato: 'currency',
    terms: [{ op: '+', ref: 'row:lair' }] },
  // Helpers ocultos (grouping p/ o ponto de equilíbrio).
  { chave: 'custos_fixos', nome: 'Custos fixos (auxiliar)', ordem: 1250, oculto: 1, formato: 'currency',
    terms: [{ op: '+', ref: 'sec:operacionais_diretas' }, { op: '+', ref: 'sec:administrativas' }, { op: '+', ref: 'sec:comerciais' }, { op: '+', ref: 'sec:nao_operacionais' }, { op: '+', ref: 'sec:juros_emprestimos' }] },
  { chave: 'mc_ratio', nome: 'Margem ÷ receita (auxiliar)', ordem: 1260, oculto: 1, formato: 'percent',
    terms: [{ op: '+', ref: 'row:margem_contrib' }, { op: '/', ref: 'sec:receita_bruta' }] },
  { chave: 'ponto_equilibrio', nome: 'PONTO DE EQUILÍBRIO', ordem: 1300, oculto: 0, formato: 'currency',
    terms: [{ op: '+', ref: 'row:custos_fixos' }, { op: '/', ref: 'row:mc_ratio' }] }
];

export const SECTION_KEYS = new Set(DRE_SECOES);

/**
 * Semeia as linhas-computed padrão no escopo (empresa + user_id) se ausente.
 * Idempotente (guard por contagem) e transacional. userId '' = template.
 */
export async function ensureFinanceDreFormulasSeeded(empresaId, userId = '') {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [cnt] = await conn.execute(
      'SELECT COUNT(*) AS c FROM `FinDreFormula` WHERE `empresa_id` = ? AND `user_id` = ?',
      [empresaId, userId]
    );
    if (Number(cnt[0]?.c || 0) === 0) {
      for (const f of DRE_FORMULA_SEED) {
        await conn.execute(
          `INSERT INTO \`FinDreFormula\`
             (\`id\`, \`empresa_id\`, \`user_id\`, \`chave\`, \`nome\`, \`formula\`, \`formato\`, \`oculto\`, \`ordem\`, \`ativo\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [randomUUID(), empresaId, userId, f.chave, f.nome, JSON.stringify({ terms: f.terms }), f.formato, f.oculto, f.ordem]
        );
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
