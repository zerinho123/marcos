// ============================================================================
// views/despesa-classificacao.js - fonte única de classificação de despesa
// ----------------------------------------------------------------------------
// Regra única: uma despesa é variável quando a seção efetiva da categoria no DRE
// é `cmv` ou `servicos_terceiros`. A seção efetiva vem do backend em
// `categoria.dre_secao_efetiva`; `dre_secao` é fallback legado.
// ============================================================================

export const VARIAVEL_SECOES = new Set(['cmv', 'servicos_terceiros']);

const VARIAVEL_KEYWORDS = /mercadoria|insumo|mat[eé]ria|frete|comiss|embalag|terceir|cmv|fornecedor|produ[çc][aã]o|revenda|estoque/i;

export function secaoEfetiva(cat) {
  if (!cat) return null;
  return cat.dre_secao_efetiva || cat.dre_secao || null;
}

export function classeFromCategoria(cat) {
  if (!cat) return 'fixa';
  const secao = secaoEfetiva(cat);
  if (secao) return VARIAVEL_SECOES.has(secao) ? 'variavel' : 'fixa';
  return VARIAVEL_KEYWORDS.test(cat.nome || '') ? 'variavel' : 'fixa';
}

export function isVariavel(cat) {
  return classeFromCategoria(cat) === 'variavel';
}
