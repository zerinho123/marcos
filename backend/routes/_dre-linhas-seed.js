// ============================================================================
// routes/_dre-linhas-seed.js — linhas de detalhe padrão do DRE (data-driven)
// ----------------------------------------------------------------------------
// O DRE deixou de ter as linhas de detalhe fixas no código: elas viram registros
// em `FinDreLinha` (editáveis pelo admin). Este seed reproduz a estrutura da
// planilha `DRE-Shopping` na primeira vez que a empresa abre o DRE e faz o
// auto-mapeamento das categorias existentes para as linhas (por nome/alias),
// garantindo que tudo que já foi lançado continue caindo na linha certa.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';

export function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Seções que carregam linhas de detalhe (mesma lista de DRE_SECOES das categorias).
export const DRE_SECOES = [
  'receita_bruta', 'deducoes', 'cmv', 'servicos_terceiros',
  'comerciais', 'operacionais_diretas', 'administrativas',
  'nao_operacionais', 'juros_emprestimos', 'ir'
];

// Estrutura-base por seção (nome exibido + aliases p/ auto-map de categorias).
export const DRE_LINHA_SEED = {
  receita_bruta: [
    { nome: 'Receita à Vista', aliases: ['receita a vista', 'vendas a vista', 'mensalidades'] },
    { nome: 'Receita à Prazo', aliases: ['receita a prazo', 'vendas a prazo', 'planos anuais'] },
    { nome: 'Serviços', aliases: ['servicos pontuais', 'servicos', 'servico'] }
  ],
  deducoes: [
    { nome: 'Impostos', aliases: ['impostos', 'simples', 'icms', 'darf', 'pis', 'cofins', 'csll', 'irpj', 'cprb', 'iptu', 'alvara'] },
    { nome: 'Comissão', aliases: ['comissao'] },
    { nome: 'Premiações', aliases: ['premiacoes', 'bonificacao'] },
    { nome: 'Devoluções', aliases: ['devolucoes'] }
  ],
  cmv: [
    { nome: 'Embalagens', aliases: ['embalagens'] },
    { nome: 'Óculos de Grau / Sol', aliases: ['oculos de grau / sol', 'oculos de grau', 'oculos de sol'] },
    { nome: 'Relógios', aliases: ['relogios'] },
    { nome: 'Jóias e Semi Jóias', aliases: ['joias e semi joias', 'joias e semijoias'] },
    { nome: 'Lentes', aliases: ['lentes'] },
    { nome: 'Compra de mercadoria', aliases: ['compra de mercadoria'] }
  ],
  servicos_terceiros: [
    { nome: 'Ourives', aliases: ['ourives'] },
    { nome: 'Gravações', aliases: ['gravacoes'] },
    { nome: 'Conserto de Ótica', aliases: ['conserto de otica'] },
    { nome: 'Serviço de terceiros', aliases: ['servico de terceiros'] }
  ],
  operacionais_diretas: [
    { nome: 'Mão-de-obra Operacional', aliases: ['mao-de-obra operacional', 'salarios - operacional'] },
    { nome: 'Vale Transporte', aliases: ['vale transporte'] },
    { nome: 'Unimed Funcionário', aliases: ['unimed funcionario'] },
    { nome: 'Lanches', aliases: ['lanches'] },
    { nome: 'Aluguel - Sala', aliases: ['aluguel - sala', 'aluguel sala'] },
    { nome: 'Condomínio', aliases: ['condominio'] },
    { nome: 'Energia', aliases: ['energia'] },
    { nome: 'Água', aliases: ['agua'] },
    { nome: 'Sistema Administrativo', aliases: ['sistema administrativo'] },
    { nome: 'Cursos/Treinamentos/Eventos', aliases: ['cursos/treinamentos/eventos', 'cursos/treinamentos', 'cursos'] },
    { nome: 'Sindicato', aliases: ['sindicato'] },
    { nome: 'Manutenção de Máquinas e Equip.', aliases: ['manutencao de maquinas e equip.', 'manutencao'] },
    { nome: 'Segurança e Vigilância', aliases: ['seguranca e vigilancia'] },
    { nome: 'Estacionamento', aliases: ['estacionamento'] },
    { nome: 'FGTS', aliases: ['fgts'] },
    { nome: 'INSS/GPS', aliases: ['inss/gps', 'inss'] },
    { nome: '13 Salário', aliases: ['13 salario', '13o salario'] },
    { nome: 'Combustível', aliases: ['combustivel'] }
  ],
  administrativas: [
    { nome: 'Mão-de-obra Administrativa', aliases: ['mao-de-obra administrativa'] },
    { nome: 'Pró-Labore', aliases: ['pro-labore', 'pro labore'] },
    { nome: 'Internet, Telefone, VOIP, Celular', aliases: ['internet,telefone fixo, voip, celular', 'internet', 'telefone', 'voip', 'celular'] },
    { nome: 'Material de Expediente', aliases: ['material de expediente escritorio', 'material de escritorio'] },
    { nome: 'Assessoria Administrativa', aliases: ['assessoria administrativa'] },
    { nome: 'Assessoria Contábil', aliases: ['assessoria contabil'] },
    { nome: 'Assessoria Jurídica', aliases: ['assessoria juridica'] },
    { nome: 'Conselho de Ótica', aliases: ['conselho de otica'] },
    { nome: 'Cartão Convênios', aliases: ['cartao convenios'] },
    { nome: 'Associação CDL', aliases: ['associacao cdl'] },
    { nome: 'Correios', aliases: ['correios'] },
    { nome: 'Revistas e Jornais', aliases: ['revistas e jornais'] },
    { nome: 'Despesas Administrativas Diversas', aliases: ['despesas administrativas diversas'] },
    { nome: 'Despesas Financeiras', aliases: ['despesas financeiras'] },
    { nome: 'Manutenção de Bens Imóveis', aliases: ['manutencao de bens imoveis'] },
    { nome: 'Copa e Cozinha', aliases: ['copa e cozinha'] },
    { nome: 'Férias', aliases: ['ferias'] },
    { nome: 'IPTU', aliases: ['iptu'] },
    { nome: 'Alimentação', aliases: ['alimentacao'] }
  ],
  comerciais: [
    { nome: 'Marketing', aliases: ['marketing'] },
    { nome: 'PDV', aliases: ['pdv'] },
    { nome: 'Patrocínio e Doações', aliases: ['patrocinio e doacoes', 'doacoes'] },
    { nome: 'Publicidade e Propaganda', aliases: ['publicidade e propaganda'] },
    { nome: 'Erros e Perdas', aliases: ['erros e perdas'] }
  ],
  nao_operacionais: [
    { nome: 'Despesas Não Operacionais', aliases: ['despesas nao operacionais', 'despesa nao operacional'] }
  ],
  juros_emprestimos: [
    { nome: 'Juros de descontos Operações', aliases: ['juros de descontos operacoes', 'juros de descontos'] },
    { nome: 'Empréstimo e financiamentos', aliases: ['emprestimo e financiamentos', 'emprestimos e financiamentos'] },
    { nome: 'Parcelamento de ICMS', aliases: ['parcelamento de icms'] },
    { nome: 'Parcelamento SIMPLES', aliases: ['parcelamento simples', 'parcelamento de imposto'] },
    { nome: 'Parcelamento de INSS', aliases: ['parcelamento de inss'] },
    { nome: 'Empréstimos Particulares', aliases: ['emprestimos particulares'] },
    { nome: 'Taxas Financeiras', aliases: ['taxas financeiras'] }
  ],
  ir: [
    { nome: 'IR', aliases: ['ir', 'imposto de renda'] }
  ]
};

/** Constrói o array plano de linhas a inserir, com ordem sequencial por seção. */
function buildSeedRows(empresaId) {
  const rows = [];
  for (const secao of DRE_SECOES) {
    const linhas = DRE_LINHA_SEED[secao] || [];
    linhas.forEach((l, idx) => {
      rows.push({
        id: randomUUID(),
        empresa_id: empresaId,
        secao,
        nome: l.nome,
        ordem: idx,
        aliases: new Set([normalizeName(l.nome), ...(l.aliases || []).map(normalizeName)])
      });
    });
  }
  return rows;
}

/**
 * Semeia FinDreLinha + auto-mapeia categorias se a empresa ainda não tem linhas.
 * Idempotente: roda no GET /dre e no GET /dre/estrutura.
 */
export async function ensureFinanceDreLinhasSeeded(empresaId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Linhas template (user_id = '') — só semeia se a empresa ainda não tem.
    const [countRows] = await conn.execute(
      "SELECT COUNT(*) AS c FROM `FinDreLinha` WHERE `empresa_id` = ? AND `user_id` = ''",
      [empresaId]
    );
    if (Number(countRows[0]?.c || 0) === 0) {
      const seed = buildSeedRows(empresaId);
      for (const r of seed) {
        await conn.execute(
          'INSERT INTO `FinDreLinha` (`id`, `empresa_id`, `secao`, `nome`, `ordem`, `ativo`) VALUES (?, ?, ?, ?, ?, 1)',
          [r.id, r.empresa_id, r.secao, r.nome, r.ordem]
        );
      }

      // Auto-map: cada categoria com dre_secao vai para uma linha da mesma seção.
      const [cats] = await conn.execute(
        'SELECT `id`, `nome`, `dre_secao` FROM `FinCategoria` WHERE `empresa_id` = ? AND `dre_secao` IS NOT NULL',
        [empresaId]
      );
      const bySecao = new Map();
      for (const r of seed) {
        if (!bySecao.has(r.secao)) bySecao.set(r.secao, []);
        bySecao.get(r.secao).push(r);
      }
      const nextOrdem = new Map([...bySecao.entries()].map(([s, arr]) => [s, arr.length]));

      for (const cat of cats) {
        const secao = cat.dre_secao;
        if (!DRE_SECOES.includes(secao)) continue;
        const candidates = bySecao.get(secao) || [];
        const catNorm = normalizeName(cat.nome);
        let alvo = candidates.find((l) => l.aliases.has(catNorm));
        if (!alvo) {
          // Sem linha equivalente: cria uma com o nome da categoria e mapeia.
          const ordem = nextOrdem.get(secao) || 0;
          alvo = {
            id: randomUUID(), empresa_id: empresaId, secao,
            nome: cat.nome, ordem, aliases: new Set([catNorm])
          };
          await conn.execute(
            'INSERT INTO `FinDreLinha` (`id`, `empresa_id`, `secao`, `nome`, `ordem`, `ativo`) VALUES (?, ?, ?, ?, ?, 1)',
            [alvo.id, empresaId, secao, alvo.nome, ordem]
          );
          if (!bySecao.has(secao)) bySecao.set(secao, []);
          bySecao.get(secao).push(alvo);
          nextOrdem.set(secao, ordem + 1);
        }
        await conn.execute(
          'UPDATE `FinCategoria` SET `dre_linha_id` = ? WHERE `id` = ? AND `empresa_id` = ?',
          [alvo.id, cat.id, empresaId]
        );
      }
    }

    // 2) Mapa template em FinDreUserMapa (migração lazy de FinCategoria.dre_linha_id).
    //    Guardado: só popula se o template ainda não tem mapa — NÃO re-adiciona o que
    //    o admin tiver apagado depois. Roda também p/ empresas legadas (já com linhas).
    const [mapaRows] = await conn.execute(
      "SELECT COUNT(*) AS c FROM `FinDreUserMapa` WHERE `empresa_id` = ? AND `user_id` = ''",
      [empresaId]
    );
    if (Number(mapaRows[0]?.c || 0) === 0) {
      await conn.execute(
        "INSERT IGNORE INTO `FinDreUserMapa` (`empresa_id`, `user_id`, `categoria_id`, `linha_id`) " +
        "SELECT `empresa_id`, '', `id`, `dre_linha_id` FROM `FinCategoria` " +
        "WHERE `empresa_id` = ? AND `dre_linha_id` IS NOT NULL",
        [empresaId]
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

/**
 * Garante o DRE pessoal de um admin (user_id = userId), clonando o template da
 * empresa (linhas + mapa + metas) na 1ª vez. Idempotente. userId '' = template
 * (já coberto por ensureFinanceDreLinhasSeeded), retorna sem clonar.
 */
export async function ensureFinanceDreUserSeeded(empresaId, userId) {
  if (!userId) return;                         // '' = template
  await ensureFinanceDreLinhasSeeded(empresaId); // garante o template a clonar

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [has] = await conn.execute(
      'SELECT COUNT(*) AS c FROM `FinDreLinha` WHERE `empresa_id` = ? AND `user_id` = ?',
      [empresaId, userId]
    );
    if (Number(has[0]?.c || 0) > 0) { await conn.commit(); return; }

    // Linhas template → pessoais (mapa oldId→newId).
    const [tpl] = await conn.execute(
      "SELECT `id`, `secao`, `nome`, `ordem`, `ativo` FROM `FinDreLinha` WHERE `empresa_id` = ? AND `user_id` = ''",
      [empresaId]
    );
    const idMap = new Map();
    for (const l of tpl) {
      const newId = randomUUID();
      idMap.set(String(l.id), newId);
      await conn.execute(
        'INSERT INTO `FinDreLinha` (`id`, `empresa_id`, `user_id`, `secao`, `nome`, `ordem`, `ativo`) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [newId, empresaId, userId, l.secao, l.nome, l.ordem, l.ativo]
      );
    }

    // Mapa template → pessoal (traduz linha_id).
    const [tplMapa] = await conn.execute(
      "SELECT `categoria_id`, `linha_id` FROM `FinDreUserMapa` WHERE `empresa_id` = ? AND `user_id` = ''",
      [empresaId]
    );
    for (const m of tplMapa) {
      const novo = idMap.get(String(m.linha_id));
      if (!novo) continue;
      await conn.execute(
        'INSERT IGNORE INTO `FinDreUserMapa` (`empresa_id`, `user_id`, `categoria_id`, `linha_id`) VALUES (?, ?, ?, ?)',
        [empresaId, userId, m.categoria_id, novo]
      );
    }

    // Metas template (projetado + ajuste) → pessoais (traduz linha_id).
    const [tplMeta] = await conn.execute(
      "SELECT `linha_id`, `mes`, `valor`, `ajuste_real` FROM `FinDreMeta` WHERE `empresa_id` = ? AND `user_id` = ''",
      [empresaId]
    );
    for (const mt of tplMeta) {
      const novo = idMap.get(String(mt.linha_id));
      if (!novo) continue;
      await conn.execute(
        'INSERT IGNORE INTO `FinDreMeta` (`empresa_id`, `user_id`, `linha_id`, `mes`, `valor`, `ajuste_real`) VALUES (?, ?, ?, ?, ?, ?)',
        [empresaId, userId, novo, mt.mes, mt.valor, mt.ajuste_real]
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
