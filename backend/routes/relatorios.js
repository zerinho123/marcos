// ============================================================================
// routes/relatorios.js — Dashboard + DRE + Fluxo de caixa
// ----------------------------------------------------------------------------
// O DRE é data-driven: as linhas de detalhe vêm de `FinDreLinha` (editáveis),
// o realizado de cada linha é a soma de TUDO que foi lançado e cai na linha
// (transações + recebimentos + pagamentos, via categoria→linha), e o projetado
// vem de `FinDreMeta`. Nada lançado é descartado: o que não tem categoria/linha
// cai numa linha visível "A classificar".
// ============================================================================

import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { wrap, parseMonth, parseDate, resolveFinanceEmpresa, resolveFinanceEscopo, dreScope, assertAmbienteEmpresarial } from './_common.js';
import { decRows } from '../security/encryption.js';
import { cambio } from '../security/cambio.js';
import { ensureFinanceDreLinhasSeeded, ensureFinanceDreUserSeeded, DRE_SECOES } from './_dre-linhas-seed.js';
import { ensureFinanceDreFormulasSeeded, computeFormulas, SECTION_ROWS } from './_dre-formula.js';

function addMonths(date, delta) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
}

function monthStart(value) {
  const [y, m] = String(value).slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}

function sqlDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

// Consolida linhas { moeda, valor } para a moeda-base usando um rate map
// { MOEDA: taxa }. Taxa ausente (null) → conta o valor de face (flag incompleto
// no chamador via buildRateMap.incompleto). Default all-BRL: rate 1 → idêntico
// ao comportamento antigo.
function hasCompleteSnapshot(row, moedaBase) {
  const sameBase = String(row?.moeda_base || '').toUpperCase() === String(moedaBase || '').toUpperCase();
  const valueOk = row?.valor_base != null && Number.isFinite(Number(row.valor_base));
  const countsOk = row?.row_count == null || Number(row.snapshot_count || 0) === Number(row.row_count || 0);
  return sameBase && valueOk && countsOk && String(row?.cotacao_status || '') !== 'legado_pendente';
}

function consolidaValor(rows, rateMap, moedaBase = 'BRL') {
  return money(rows.reduce((s, r) => {
    if (hasCompleteSnapshot(r, moedaBase)) return s + Number(r.valor_base || 0);
    const m = String(r.moeda || 'BRL').toUpperCase();
    const taxa = rateMap[m];
    return s + Number(r.valor || 0) * (taxa == null ? 1 : taxa);
  }, 0));
}

// Sanitiza uma célula de CSV contra "formula injection": se o conteúdo começar
// com =, +, -, @ (ou tab/CR), planilhas (Excel/Sheets) interpretam como fórmula.
// Prefixa um apóstrofo para forçar texto e faz o escaping padrão de CSV.
export function csvCell(value) {
  let s = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function ratio(value, base) {
  const n = Number(value || 0);
  const d = Number(base || 0);
  return d ? Number(((n / d) * 100).toFixed(2)) : null;
}

function unit(value, volume) {
  const n = Number(value || 0);
  const d = Number(volume || 0);
  return d ? Number((n / d).toFixed(2)) : null;
}

function deltaPct(real, plano) {
  const p = Number(plano || 0);
  return p ? Number((((Number(real || 0) / p) - 1) * 100).toFixed(2)) : null;
}

function decorateLine(line, ctx) {
  const real = money(line.real);
  const plano = money(line.plano);
  const isStandaloneMetric = line.kind === 'volume' || line.kind === 'unit';
  return {
    ...line,
    real: real.toFixed(2),
    plano: plano.toFixed(2),
    real_unit: isStandaloneMetric ? null : unit(real, ctx.volume),
    real_pct: isStandaloneMetric ? null : ratio(real, ctx.receita),
    delta_pct: deltaPct(real, plano),
    itens: (line.itens || []).map((item) => {
      const itemReal = money(item.real);
      const itemPlano = money(item.plano);
      const itemStandalone = item.kind === 'volume' || item.kind === 'unit';
      return {
        ...item,
        real: itemReal.toFixed(2),
        plano: itemPlano.toFixed(2),
        real_unit: itemStandalone ? null : unit(itemReal, ctx.volume),
        real_pct: itemStandalone ? null : ratio(itemReal, ctx.receita),
        delta_pct: deltaPct(itemReal, itemPlano)
      };
    })
  };
}

export function buildRelatoriosRouter() {
  const router = Router();

  router.get('/dashboard', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    // Dashboard 100% isolado por escopo: cada workspace só agrega o seu próprio.
    const escopo = resolveFinanceEscopo(req);
    const isEmp = escopo === 'empresarial';

    // Período do dashboard: por padrão o mês corrente (comportamento antigo).
    // Se o cliente mandar data_inicio+data_fim (ambos), filtra por intervalo livre
    // (ex.: dia 1 ao 30, ou dia 30 de um mês ao dia 30 do seguinte) via BETWEEN
    // inclusivo — mesmo padrão de /fluxo-de-caixa. Só um dos dois → ignora ambos.
    const hoje = new Date();
    const temIntervalo = !!(req.query.data_inicio && req.query.data_fim);
    const dataInicio = temIntervalo ? parseDate(req.query.data_inicio) : null;
    const dataFim = temIntervalo ? parseDate(req.query.data_fim) : null;
    // Cláusula + params do filtro de data (compartilhada por receita e despesa).
    const periodoSql = temIntervalo
      ? 'AND t.`data` BETWEEN ? AND ?'
      : 'AND YEAR(t.`data`) = ? AND MONTH(t.`data`) = ?';
    const periodoParams = temIntervalo
      ? [dataInicio, dataFim]
      : [hoje.getUTCFullYear(), hoje.getUTCMonth() + 1];

    // Multi-moeda: os saldos/receitas/despesas são somados POR MOEDA da conta e
    // convertidos para a moeda-base da empresa. Default all-BRL (rate 1) preserva
    // exatamente os números antigos.
    const moedaBase = (await queryOne('SELECT `moeda_base` FROM `Empresa` WHERE `id` = ?', [empresaId]))?.moeda_base || 'BRL';
    const saldoRows = await query(
      'SELECT `moeda`, COALESCE(SUM(`saldo`), 0) AS valor FROM `FinContaBancaria` WHERE `empresa_id` = ? AND `escopo` = ? AND `ativo` = 1 GROUP BY `moeda`',
      [empresaId, escopo]
    );
    const recRows = await query(
      `SELECT COALESCE(t.\`moeda\`, cb.\`moeda\`) AS moeda, t.\`moeda_base\`,
              COALESCE(SUM(t.\`valor\`), 0) AS valor, SUM(t.\`valor_base\`) AS valor_base,
              COUNT(*) AS row_count, COUNT(t.\`valor_base\`) AS snapshot_count
         FROM \`FinTransacao\` t
         JOIN \`FinContaBancaria\` cb
           ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
        WHERE t.\`empresa_id\` = ? AND t.\`tipo\` = 'receita'
          AND t.\`ativo\` = 1 AND cb.\`ativo\` = 1 AND cb.\`escopo\` = ?
          ${periodoSql}
        GROUP BY COALESCE(t.\`moeda\`, cb.\`moeda\`), t.\`moeda_base\``,
      [empresaId, escopo, ...periodoParams]
    );
    const despRows = await query(
      `SELECT COALESCE(t.\`moeda\`, cb.\`moeda\`) AS moeda, t.\`moeda_base\`,
              COALESCE(SUM(t.\`valor\`), 0) AS valor, SUM(t.\`valor_base\`) AS valor_base,
              COUNT(*) AS row_count, COUNT(t.\`valor_base\`) AS snapshot_count
         FROM \`FinTransacao\` t
         JOIN \`FinContaBancaria\` cb
           ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
        WHERE t.\`empresa_id\` = ? AND t.\`tipo\` = 'despesa'
          AND t.\`ativo\` = 1 AND cb.\`ativo\` = 1 AND cb.\`escopo\` = ?
          ${periodoSql}
        GROUP BY COALESCE(t.\`moeda\`, cb.\`moeda\`), t.\`moeda_base\``,
      [empresaId, escopo, ...periodoParams]
    );
    const moedasUsadas = [
      ...saldoRows,
      ...recRows.filter((row) => !hasCompleteSnapshot(row, moedaBase)),
      ...despRows.filter((row) => !hasCompleteSnapshot(row, moedaBase))
    ].map((r) => r.moeda);
    const { map: rateMap, incompleto: moedaIncompleta } = await cambio.buildRateMap(moedasUsadas, moedaBase);
    const snapshotIncompleto = [...recRows, ...despRows].some((row) =>
      !hasCompleteSnapshot(row, moedaBase)
      && String(row.moeda || 'BRL').toUpperCase() !== String(moedaBase).toUpperCase()
    );
    const saldoRow = { saldo: consolidaValor(saldoRows, rateMap, moedaBase) };
    const recRow = { valor: consolidaValor(recRows, rateMap, moedaBase) };
    const despRow = { valor: consolidaValor(despRows, rateMap, moedaBase) };
    // Inadimplência (A Receber) só existe no empresarial.
    // decRows: devedor_nome pode estar cifrado em repouso.
    const inadimplencia = decRows(isEmp ? await query(
      `SELECT \`devedor_nome\`, (\`valor\` - \`valor_pago\`) AS valor,
              DATEDIFF(CURDATE(), \`vencimento\`) AS dias_atraso
         FROM \`FinContaReceber\`
        WHERE \`empresa_id\` = ? AND \`escopo\` = 'empresarial'
          AND \`status\` IN ('vencido','pendente','parcial')
          AND \`vencimento\` < CURDATE()
        ORDER BY \`vencimento\` ASC LIMIT 10`,
      [empresaId]
    ) : [], ['devedor_nome']);
    const inadTot = isEmp ? await queryOne(
      `SELECT COALESCE(SUM(\`valor\` - \`valor_pago\`), 0) AS total
         FROM \`FinContaReceber\`
        WHERE \`empresa_id\` = ? AND \`escopo\` = 'empresarial' AND \`vencimento\` < CURDATE()
          AND \`status\` IN ('vencido','pendente','parcial')`,
      [empresaId]
    ) : { total: 0 };
    // Dívidas e investimentos são finanças pessoais (zerados no empresarial).
    const divRow = !isEmp ? await queryOne(
      `SELECT COALESCE(SUM(\`saldo_devedor\`), 0) AS valor
         FROM \`FinDividaPessoal\` WHERE \`empresa_id\` = ? AND \`escopo\` = 'pessoal' AND \`status\` = 'ativa'`,
      [empresaId]
    ) : { valor: 0 };
    const invRow = !isEmp ? await queryOne(
      `SELECT COALESCE(SUM(CASE WHEN a.\`tipo\`='compra' THEN a.\`total\` ELSE -a.\`total\` END), 0) AS valor
         FROM \`FinAporteInvestimento\` a WHERE a.\`empresa_id\` = ?`,
      [empresaId]
    ) : { valor: 0 };

    res.json({
      saldo_total: Number(saldoRow?.saldo || 0),
      moeda_base: moedaBase,
      // true quando alguma moeda não pôde ser convertida (API fora + sem cache):
      // os totais incluem valores de face não convertidos — o front deve avisar.
      moeda_incompleta: moedaIncompleta || snapshotIncompleto,
      periodo: temIntervalo
        ? { tipo: 'custom', inicio: dataInicio, fim: dataFim }
        : { tipo: 'mes', ano: hoje.getUTCFullYear(), mes: hoje.getUTCMonth() + 1 },
      // Nome mantido por compat com o front (mes_atual): agora reflete o período
      // selecionado, seja o mês corrente (default) ou o intervalo custom.
      mes_atual: {
        receitas: Number(recRow?.valor || 0),
        despesas: Number(despRow?.valor || 0)
      },
      inadimplencia: {
        total: Number(inadTot?.total || 0),
        contas: inadimplencia
      },
      dividas_ativas: Number(divRow?.valor || 0),
      investimentos_total: Number(invRow?.valor || 0)
    });
  }));

  router.get('/dre', wrap(async (req, res) => {
    assertAmbienteEmpresarial(req);
    const empresaId = resolveFinanceEmpresa(req);
    const userId = dreScope(req);                       // '' = template; <id> = DRE pessoal
    await ensureFinanceDreLinhasSeeded(empresaId);
    await ensureFinanceDreUserSeeded(empresaId, userId); // no-op se userId === ''
    await ensureFinanceDreFormulasSeeded(empresaId, userId);

    // Linhas-computed (fórmulas) do escopo, em ordem.
    const formulasRaw = await query(
      'SELECT `id`, `chave`, `nome`, `formula`, `formato`, `oculto`, `ordem` FROM `FinDreFormula` WHERE `empresa_id` = ? AND `user_id` = ? AND `ativo` = 1 ORDER BY `ordem`',
      [empresaId, userId]
    );
    const formulas = formulasRaw.map((f) => {
      let terms = [];
      try { terms = JSON.parse(f.formula)?.terms || []; } catch { terms = []; }
      return { id: f.id, chave: f.chave, nome: f.nome, formato: f.formato, oculto: Number(f.oculto), ordem: Number(f.ordem), terms };
    });

    const mes = parseMonth(req.query.mes);
    const currentStart = monthStart(mes);
    const currentEnd = addMonths(currentStart, 1);
    const rollingStart = addMonths(currentStart, -11);

    // Multi-moeda: taxa por moeda das contas empresariais → moeda-base da empresa.
    // Default all-BRL: uma moeda, rate 1 → cálculo idêntico ao anterior.
    const dreMoedaBase = (await queryOne('SELECT `moeda_base` FROM `Empresa` WHERE `id` = ?', [empresaId]))?.moeda_base || 'BRL';
    const dreMoedaRows = await query(
      `SELECT DISTINCT COALESCE(t.\`moeda\`, cb.\`moeda\`) AS \`moeda\`
         FROM \`FinTransacao\` t
         JOIN \`FinContaBancaria\` cb
           ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
        WHERE t.\`empresa_id\` = ? AND t.\`ativo\` = 1
          AND cb.\`ativo\` = 1 AND cb.\`escopo\` = 'empresarial'
          AND t.\`valor_base\` IS NULL AND t.\`data\` >= ? AND t.\`data\` < ?`,
      [empresaId, sqlDate(rollingStart), sqlDate(currentEnd)]
    );
    const { map: dreRateMap, incompleto: dreMoedaIncompleta } = await cambio.buildRateMap(dreMoedaRows.map((r) => r.moeda), dreMoedaBase);
    let dreSnapshotIncompleto = false;

    // Linhas de detalhe ativas + metas do mês corrente (do escopo).
    const linhas = await query(
      'SELECT `id`, `secao`, `nome`, `ordem` FROM `FinDreLinha` WHERE `empresa_id` = ? AND `user_id` = ? AND `ativo` = 1 ORDER BY `secao`, `ordem`, `nome`',
      [empresaId, userId]
    );
    const metaRows = await query(
      'SELECT `linha_id`, `valor` FROM `FinDreMeta` WHERE `empresa_id` = ? AND `user_id` = ? AND `mes` = ?',
      [empresaId, userId, sqlDate(currentStart)]
    );
    const metaByLinha = new Map(metaRows.map((r) => [String(r.linha_id), Number(r.valor || 0)]));

    // Soma o realizado de cada linha juntando tudo que foi lançado no período.
    async function loadRealizado(start, end) {
      const startSql = sqlDate(start);
      const endSql = sqlDate(end);

      // Fonte ÚNICA: o DRE lê só FinTransacao. As baixas de AP/AR já viram
      // lançamentos (origem=conta_a_*), então não somamos valor_pago direto — isso
      // evitava a dupla contagem e a divergência entre Dashboard/DRE/Fluxo.
      // Agrupa também por cb.moeda p/ converter cada subtotal na moeda-base.
      // Default all-BRL: uma moeda só, rate 1 → resultado idêntico ao antigo.
      const [txReceita, txDespesa, ajustes] = await Promise.all([
        query(
           `SELECT m.\`linha_id\` AS linha_id, COALESCE(t.\`moeda\`, cb.\`moeda\`) AS moeda,
                   t.\`moeda_base\`, COALESCE(SUM(t.\`valor\`), 0) AS total,
                   SUM(t.\`valor_base\`) AS valor_base, COUNT(*) AS volume,
                   COUNT(*) AS row_count, COUNT(t.\`valor_base\`) AS snapshot_count
              FROM \`FinTransacao\` t
              JOIN \`FinContaBancaria\` cb
                ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
              LEFT JOIN \`FinDreUserMapa\` m
                ON m.\`categoria_id\` = t.\`categoria_id\` AND m.\`empresa_id\` = t.\`empresa_id\` AND m.\`user_id\` = ?
             WHERE t.\`empresa_id\` = ? AND t.\`tipo\` = 'receita'
               AND t.\`ativo\` = 1 AND cb.\`ativo\` = 1 AND cb.\`escopo\` = 'empresarial'
               AND t.\`data\` >= ? AND t.\`data\` < ?
            GROUP BY m.\`linha_id\`, COALESCE(t.\`moeda\`, cb.\`moeda\`), t.\`moeda_base\``,
          [userId, empresaId, startSql, endSql]
        ),
        query(
           `SELECT m.\`linha_id\` AS linha_id, COALESCE(t.\`moeda\`, cb.\`moeda\`) AS moeda,
                   t.\`moeda_base\`, COALESCE(SUM(t.\`valor\`), 0) AS total,
                   SUM(t.\`valor_base\`) AS valor_base,
                   COUNT(*) AS row_count, COUNT(t.\`valor_base\`) AS snapshot_count
              FROM \`FinTransacao\` t
              JOIN \`FinContaBancaria\` cb
                ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
              LEFT JOIN \`FinDreUserMapa\` m
                ON m.\`categoria_id\` = t.\`categoria_id\` AND m.\`empresa_id\` = t.\`empresa_id\` AND m.\`user_id\` = ?
             WHERE t.\`empresa_id\` = ? AND t.\`tipo\` = 'despesa'
               AND t.\`ativo\` = 1 AND cb.\`ativo\` = 1 AND cb.\`escopo\` = 'empresarial'
               AND t.\`data\` >= ? AND t.\`data\` < ?
            GROUP BY m.\`linha_id\`, COALESCE(t.\`moeda\`, cb.\`moeda\`), t.\`moeda_base\``,
          [userId, empresaId, startSql, endSql]
        ),
        // Ajuste manual do realizado (FinDreMeta.ajuste_real) do escopo, somado na janela.
        query(
          `SELECT \`linha_id\`, COALESCE(SUM(\`ajuste_real\`), 0) AS ajuste
             FROM \`FinDreMeta\`
            WHERE \`empresa_id\` = ? AND \`user_id\` = ? AND \`mes\` >= ? AND \`mes\` < ?
            GROUP BY \`linha_id\``,
          [empresaId, userId, startSql, endSql]
        )
      ]);

      const ajusteByLinha = new Map(
        ajustes.map((r) => [String(r.linha_id), Number(r.ajuste || 0)])
      );
      const byLinha = new Map();
      let receitaAClassificar = 0;
      let despesaAClassificar = 0;
      let receitaTotal = 0;
      let volume = 0;

      // Converte o subtotal de cada (linha, moeda) p/ a moeda-base antes de somar.
      const addReceita = (rows) => {
        for (const r of rows) {
          if (!hasCompleteSnapshot(r, dreMoedaBase) && String(r.moeda || 'BRL').toUpperCase() !== dreMoedaBase) {
            dreSnapshotIncompleto = true;
          }
          const val = consolidaValor([{ ...r, valor: r.total }], dreRateMap, dreMoedaBase);
          receitaTotal += val;
          volume += Number(r.volume || 0);   // volume = contagem, independe de moeda
          if (r.linha_id) byLinha.set(String(r.linha_id), (byLinha.get(String(r.linha_id)) || 0) + val);
          else receitaAClassificar += val;
        }
      };
      const addDespesa = (rows) => {
        for (const r of rows) {
          if (!hasCompleteSnapshot(r, dreMoedaBase) && String(r.moeda || 'BRL').toUpperCase() !== dreMoedaBase) {
            dreSnapshotIncompleto = true;
          }
          const val = consolidaValor([{ ...r, valor: r.total }], dreRateMap, dreMoedaBase);
          if (r.linha_id) byLinha.set(String(r.linha_id), (byLinha.get(String(r.linha_id)) || 0) + val);
          else despesaAClassificar += val;
        }
      };

      addReceita(txReceita);
      addDespesa(txDespesa);

      return { byLinha, ajusteByLinha, receitaAClassificar, despesaAClassificar, receitaTotal, volume };
    }

    function buildModel(period, useMeta) {
      // 1) Linhas de detalhe por seção (base + ajuste manual).
      const bySecao = new Map(DRE_SECOES.map((s) => [s, []]));
      for (const l of linhas) {
        if (!bySecao.has(l.secao)) bySecao.set(l.secao, []);
        const base = period.byLinha.get(String(l.id)) || 0;
        const ajuste = period.ajusteByLinha.get(String(l.id)) || 0;
        bySecao.get(l.secao).push({
          nome: l.nome, linha_id: l.id, secao: l.secao, editable: true,
          real_base: base, ajuste,
          real: base + ajuste,            // realizado efetivo = lançamentos + ajuste manual
          plano: useMeta ? (metaByLinha.get(String(l.id)) || 0) : 0
        });
      }
      const bucketBySecao = {
        receita_bruta: period.receitaAClassificar,
        nao_operacionais: period.despesaAClassificar
      };
      const sectionItems = (secao) => {
        const items = (bySecao.get(secao) || []).slice();
        const bucket = bucketBySecao[secao];
        if (bucket && Number(bucket) !== 0) {
          items.push({ nome: 'A classificar', bucket: true, editable: false, real: bucket, plano: 0 });
        }
        return items;
      };
      const sumOf = (items) => ({
        real: items.reduce((s, i) => s + Number(i.real || 0), 0),
        plano: items.reduce((s, i) => s + Number(i.plano || 0), 0)
      });

      // 2) Subtotais por seção (+ itens p/ render). secVals alimenta as fórmulas.
      const itemsBySecao = new Map();
      const secVals = new Map();
      for (const s of DRE_SECOES) {
        const items = sectionItems(s);
        itemsBySecao.set(s, items);
        secVals.set(s, sumOf(items));
      }
      const receitaBruta = secVals.get('receita_bruta').real;

      // 3) Linhas-computed: avalia as fórmulas (ordem topológica) p/ real e plano.
      const fvals = computeFormulas(formulas, secVals);
      const fval = (chave) => fvals.get(chave) || { real: 0, plano: 0 };

      // 4) Cascata = seções ancoradas + computed (por ordem), pulando ocultas.
      const rows = [];
      for (const sr of SECTION_ROWS) {
        const itens = (itemsBySecao.get(sr.secao) || []).slice();
        if (sr.secao === 'receita_bruta') {
          itens.push({ nome: 'Volume', real: period.volume, plano: 0, kind: 'volume' });
          itens.push({ nome: 'Preço Médio', real: unit(receitaBruta, period.volume) || 0, plano: 0, kind: 'unit' });
        }
        const v = secVals.get(sr.secao) || { real: 0, plano: 0 };
        rows.push({
          key: 'sec:' + sr.secao, tipo: sr.tipo, nome: sr.nome, secao: sr.secao, ordem: sr.ordem,
          real: v.real, plano: v.plano, itens
        });
      }
      for (const f of formulas) {
        if (f.oculto) continue;
        const v = fval(f.chave);
        rows.push({
          key: 'row:' + f.chave, tipo: 'computed', nome: f.nome, chave: f.chave, id: f.id,
          formato: f.formato, ordem: f.ordem, formula: f.terms, editableFormula: true,
          real: v.real, plano: v.plano
        });
      }
      rows.sort((a, b) => (a.ordem - b.ordem) || String(a.key).localeCompare(String(b.key)));

      return { period, receitaBruta, fval, rows };
    }

    const mensal = buildModel(await loadRealizado(currentStart, currentEnd), true);
    const rolling = buildModel(await loadRealizado(rollingStart, currentEnd), false);
    const rollingByKey = new Map(rolling.rows.map((r) => [r.key, r]));
    const ctx = { receita: mensal.receitaBruta, volume: mensal.period.volume };

    const estrutura = mensal.rows.map((row) => {
      const base = decorateLine(row, ctx);
      const total = rollingByKey.get(row.key) || { real: 0 };
      const totalReal = money(total.real);
      const mediaReal = money(totalReal / 12);
      return {
        ...base,
        total12: totalReal.toFixed(2),
        total12_unit: row.kind === 'volume' ? null : unit(totalReal, rolling.period.volume),
        total12_pct: row.kind === 'volume' ? null : ratio(totalReal, rolling.receitaBruta),
        media12: mediaReal.toFixed(2),
        media12_unit: row.kind === 'volume' ? null : unit(mediaReal, rolling.period.volume / 12),
        media12_pct: row.kind === 'volume' ? null : ratio(mediaReal, rolling.receitaBruta / 12)
      };
    });

    res.json({
      mes: mes.slice(0, 7),
      modelo: 'dre-shopping-editavel',
      moeda_base: dreMoedaBase,
      moeda_incompleta: dreMoedaIncompleta || dreSnapshotIncompleto,
      periodo_12m: { inicio: sqlDate(rollingStart).slice(0, 7), fim: mes.slice(0, 7) },
      estrutura,
      resumo: {
        receita_bruta: mensal.receitaBruta.toFixed(2),
        receita_liquida: mensal.fval('receita_liquida').real.toFixed(2),
        margem_bruta: mensal.fval('margem_contrib').real.toFixed(2),
        ebtda: mensal.fval('ebtda').real.toFixed(2),
        lucro_liquido: mensal.fval('lucro_liquido').real.toFixed(2),
        ponto_equilibrio: mensal.fval('ponto_equilibrio').real.toFixed(2),
        volume: mensal.period.volume,
        preco_medio: (unit(mensal.receitaBruta, mensal.period.volume) || 0).toFixed(2),
        margem_pct: ratio(mensal.fval('lucro_liquido').real, mensal.receitaBruta)?.toFixed(2) || '0.00',
        margem_contrib_pct: ratio(mensal.fval('margem_contrib').real, mensal.receitaBruta)?.toFixed(2) || '0.00'
      }
    });
  }));

  router.get('/fluxo-de-caixa', wrap(async (req, res) => {
    const empresaId = resolveFinanceEmpresa(req);
    const data_inicio = parseDate(req.query.data_inicio);
    const data_fim    = parseDate(req.query.data_fim);
    const tipo = req.query.tipo === 'pessoal' ? 'pessoal' : 'empresarial';

    // Fonte ÚNICA: o fluxo lê só FinTransacao, filtrado pelo escopo da CONTA
    // (cb.escopo). As baixas de AP/AR já viram lançamentos (origem=conta_a_*),
    // então entram aqui naturalmente — sem somar valor_pago direto (dupla contagem).
    // decRows: descricao pode estar cifrada em repouso. cb.moeda p/ conversão.
    const movimentacoes = decRows(await query(
      `SELECT t.\`data\`, t.\`descricao\`, COALESCE(t.\`moeda\`, cb.\`moeda\`) AS moeda,
              t.\`moeda_base\`, t.\`taxa_cambio\`, t.\`valor_base\`,
              t.\`cotacao_data\`, t.\`cotacao_fonte\`, t.\`cotacao_status\`,
              CASE WHEN t.\`tipo\`='receita' THEN 'entrada' ELSE 'saida' END AS direcao,
              t.\`valor\`
         FROM \`FinTransacao\` t
         JOIN \`FinContaBancaria\` cb
           ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
        WHERE t.\`empresa_id\` = ? AND t.\`data\` BETWEEN ? AND ?
          AND t.\`ativo\` = 1 AND cb.\`ativo\` = 1 AND cb.\`escopo\` = ?
        ORDER BY t.\`data\` ASC`,
      [empresaId, data_inicio, data_fim, tipo]
    ), ['descricao']);

    // Consolida entradas/saídas na moeda-base da empresa (default all-BRL = idêntico).
    const moedaBase = (await queryOne('SELECT `moeda_base` FROM `Empresa` WHERE `id` = ?', [empresaId]))?.moeda_base || 'BRL';
    const { map: rateMap, incompleto: moedaIncompleta } = await cambio.buildRateMap(
      movimentacoes.filter((movimento) => !hasCompleteSnapshot(movimento, moedaBase)).map((m) => m.moeda),
      moedaBase
    );
    const snapshotIncompleto = movimentacoes.some((movimento) =>
      !hasCompleteSnapshot(movimento, moedaBase)
      && String(movimento.moeda || 'BRL').toUpperCase() !== String(moedaBase).toUpperCase()
    );
    const movimentacoesComBase = movimentacoes.map((movimento) => ({
      ...movimento,
      valor_base: consolidaValor([movimento], rateMap, moedaBase)
    }));
    const entradas = movimentacoesComBase.filter(m => m.direcao === 'entrada').reduce((s, m) => s + Number(m.valor_base || 0), 0);
    const saidas   = movimentacoesComBase.filter(m => m.direcao === 'saida').reduce((s, m) => s + Number(m.valor_base || 0), 0);

    res.json({
      moeda_base: moedaBase,
      moeda_incompleta: moedaIncompleta || snapshotIncompleto,
      periodo: { inicio: data_inicio, fim: data_fim },
      entradas: entradas.toFixed(2),
      saidas: saidas.toFixed(2),
      saldo_periodo: (entradas - saidas).toFixed(2),
      movimentacoes: movimentacoesComBase
    });
  }));

  router.get('/dre/export', wrap(async (req, res) => {
    assertAmbienteEmpresarial(req);
    const empresaId = resolveFinanceEmpresa(req);
    const mes = parseMonth(req.query.mes);

    // Fonte única: exporta a partir de FinTransacao (empresarial), igual ao DRE/Fluxo.
    const despesas = await query(
      `SELECT c.\`nome\` AS categoria, COALESCE(SUM(t.\`valor\`), 0) AS total
         FROM \`FinTransacao\` t
         JOIN \`FinContaBancaria\` cb
           ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
         LEFT JOIN \`FinCategoria\` c ON c.\`id\` = t.\`categoria_id\`
        WHERE t.\`empresa_id\` = ? AND t.\`tipo\` = 'despesa'
          AND t.\`ativo\` = 1 AND cb.\`ativo\` = 1 AND cb.\`escopo\` = 'empresarial'
          AND YEAR(t.\`data\`)  = YEAR(?)
          AND MONTH(t.\`data\`) = MONTH(?)
        GROUP BY c.\`nome\``,
      [empresaId, mes, mes]
    );
    const receita = await queryOne(
      `SELECT COALESCE(SUM(t.\`valor\`), 0) AS total
         FROM \`FinTransacao\` t
         JOIN \`FinContaBancaria\` cb
           ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
        WHERE t.\`empresa_id\` = ? AND t.\`tipo\` = 'receita'
          AND t.\`ativo\` = 1 AND cb.\`ativo\` = 1 AND cb.\`escopo\` = 'empresarial'
          AND YEAR(t.\`data\`)  = YEAR(?)
          AND MONTH(t.\`data\`) = MONTH(?)`,
      [empresaId, mes, mes]
    );

    const lines = [['Categoria', 'Total'].map(csvCell).join(',')];
    lines.push([csvCell('Receita Bruta'), Number(receita?.total || 0).toFixed(2)].join(','));
    for (const d of despesas) {
      lines.push([csvCell(d.categoria || 'Sem categoria'), Number(d.total).toFixed(2)].join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=dre-${mes.slice(0, 7)}.csv`);
    res.send(lines.join('\n'));
  }));

  return router;
}
