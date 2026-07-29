// ============================================================================
// routes/_dre-seed.js — categorias essenciais do workspace empresarial
// ----------------------------------------------------------------------------
// Seed completo: cada categoria nasce classificada (natureza, comportamento,
// seção do DRE, flags de uso no DRE/precificação) e com `escopo` explícito —
// a coluna tem DEFAULT 'pessoal', então omitir o escopo deixava o seed
// invisível no workspace empresarial (GET /categorias filtra por escopo).
//
// Classificação por seção (regras do produto):
//   receita_bruta        → natureza receita, sem comportamento (não é custo)
//   deducoes             → natureza receita (redutora), variável, entra na precificação
//   cmv/servicos_terceiros → despesa variável, entra na precificação
//   demais seções        → despesa fixa, só DRE
// ============================================================================

import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';

// [nome, dre_secao]
const EMPRESARIAL_SEED_BASE = [
  ['Mensalidades',                 'receita_bruta'],
  ['Planos Anuais',                'receita_bruta'],
  ['Servicos Pontuais',            'receita_bruta'],
  ['Simples',                      'deducoes'],
  ['ICMS',                         'deducoes'],
  ['Comissao',                     'deducoes'],
  ['Bonificacao',                  'deducoes'],
  ['Devolucoes',                   'deducoes'],
  ['Embalagens',                   'cmv'],
  ['Compra de mercadoria',         'cmv'],
  ['Servico de terceiros',         'servicos_terceiros'],
  ['Marketing',                    'comerciais'],
  ['Doacoes',                      'comerciais'],
  ['Erros e Perdas',               'comerciais'],
  ['Publicidade e Propaganda',     'comerciais'],
  ['Salarios - Operacional',       'operacionais_diretas'],
  ['Vale Transporte',              'operacionais_diretas'],
  ['Aluguel - Sala',               'operacionais_diretas'],
  ['Condominio',                   'operacionais_diretas'],
  ['Energia',                      'operacionais_diretas'],
  ['Agua',                         'operacionais_diretas'],
  ['FGTS',                         'operacionais_diretas'],
  ['INSS/GPS',                     'operacionais_diretas'],
  ['13 salario',                   'operacionais_diretas'],
  ['Cursos/Treinamentos',          'operacionais_diretas'],
  ['Manutencao',                   'operacionais_diretas'],
  ['Combustivel',                  'operacionais_diretas'],
  ['Pro-Labore',                   'administrativas'],
  ['Ferias',                       'administrativas'],
  ['Internet',                     'administrativas'],
  ['Telefone',                     'administrativas'],
  ['Assessoria contabil',          'administrativas'],
  ['Assessoria Juridica',          'administrativas'],
  ['Material de Escritorio',       'administrativas'],
  ['IPTU',                         'administrativas'],
  ['Alimentacao',                  'administrativas'],
  ['Despesas Nao Operacionais',    'nao_operacionais'],
  ['Emprestimos e Financiamentos', 'juros_emprestimos'],
  ['Parcelamento de ICMS',         'juros_emprestimos'],
  ['Parcelamento de Imposto',      'juros_emprestimos'],
  ['Parcelamento de INSS',         'juros_emprestimos'],
  ['Taxas Financeiras',            'juros_emprestimos'],
  ['Juros de Descontos',           'juros_emprestimos'],
  ['IR',                           'ir']
];

// Classificação derivada da seção — mesma semântica do backfill de
// schema-evolution.js (deduções são redutoras de receita → natureza 'receita')
// e do classificador do front (`isVariavel` = cmv/servicos_terceiros).
export function classifyBySecao(secao) {
  if (secao === 'receita_bruta') {
    return { natureza: 'receita', comportamento: 'nao_aplica', usar_na_precificacao: 0 };
  }
  if (secao === 'deducoes') {
    return { natureza: 'receita', comportamento: 'variavel', usar_na_precificacao: 1 };
  }
  if (secao === 'cmv' || secao === 'servicos_terceiros') {
    return { natureza: 'despesa', comportamento: 'variavel', usar_na_precificacao: 1 };
  }
  return { natureza: 'despesa', comportamento: 'fixa', usar_na_precificacao: 0 };
}

export const DRE_SEED = EMPRESARIAL_SEED_BASE.map(([nome, secao]) => ({
  nome,
  dre_secao: secao,
  tipo: 'empresarial',
  escopo: 'empresarial',
  usar_no_dre: 1,
  ...classifyBySecao(secao)
}));

export async function seedFinanceCategorias(empresaId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const c of DRE_SEED) {
      await conn.execute(
        `INSERT INTO \`FinCategoria\`
           (\`id\`, \`empresa_id\`, \`nome\`, \`tipo\`, \`escopo\`,
            \`natureza\`, \`comportamento\`, \`usar_no_dre\`, \`usar_na_precificacao\`, \`dre_secao\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE \`updatedAt\` = NOW(3)`,
        [randomUUID(), empresaId, c.nome, c.tipo, c.escopo,
         c.natureza, c.comportamento, c.usar_no_dre, c.usar_na_precificacao, c.dre_secao]
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// Semeia as categorias essenciais empresariais quando a empresa ainda não tem
// NENHUMA categoria nesse escopo. Categorias pessoais vivem em
// FinCategoriaPessoal (seed próprio em categorias.js) — não contam aqui.
export async function ensureFinanceCategoriasSeeded(empresaId, queryOne) {
  const row = await queryOne(
    "SELECT COUNT(*) AS c FROM `FinCategoria` WHERE `empresa_id` = ? AND `escopo` = 'empresarial'",
    [empresaId]
  );
  if ((row?.c || 0) === 0) {
    await seedFinanceCategorias(empresaId);
  }
}
