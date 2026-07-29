// ============================================================================
// security/cambio.js — cotações de câmbio (multi-moeda)
// ----------------------------------------------------------------------------
// Fonte: Frankfurter v1 (open-source, dados do BCE, sem API key). A taxa é
// "1 unidade da moeda ORIGEM vale X da moeda DESTINO". Cache em FinCambioCache
// por (par, data): evita bater na API a cada consolidação e permite recompor
// relatórios de datas passadas de forma estável.
//
// Resiliência: se a API estiver fora, cai no último valor em cache do par. Se
// não houver nada em cache e as moedas forem diferentes, `getRate` devolve null
// e o chamador decide (a consolidação trata null como "não converter" + flag).
//
// Só ECB/frankfurter-supported: nada de moeda que a API não cota (ex.: ARS).
// ============================================================================

import Decimal from 'decimal.js';
import { query as dbQuery, queryOne as dbQueryOne } from '../db.js';

// Moedas suportadas (ISO 4217) — todas cotadas pelo frankfurter/BCE.
export const MOEDAS_SUPORTADAS = ['BRL', 'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'MXN'];

export function isMoedaSuportada(code) {
  return MOEDAS_SUPORTADAS.includes(String(code || '').toUpperCase());
}

function par(from, to) {
  return `${from}${to}`;
}

function taxaValida(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isoDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function shiftDate(date, days) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function round(value, places = 6) {
  return new Decimal(value).toDecimalPlaces(places).toNumber();
}

// yyyy-mm-dd de hoje (UTC) — chave de cache "cotação do dia".
function hojeUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Constrói o serviço. Injeção opcional (query/queryOne/fetch) p/ teste sem
// banco nem rede real.
export function buildCambioService({
  queryFn = dbQuery,
  queryOneFn = dbQueryOne,
  fetchFn = globalThis.fetch,
  nowFn = () => new Date()
} = {}) {
  const historyMemo = new Map();
  const HISTORY_TTL_MS = 15 * 60 * 1000;

  // Lê a taxa em cache para o par numa data específica.
  async function fromCacheExact(p, data) {
    const row = await queryOneFn(
      'SELECT `taxa` FROM `FinCambioCache` WHERE `par` = ? AND `data` = ?',
      [p, data]
    );
    return taxaValida(row?.taxa);
  }

  // Último valor em cache do par (fallback quando a API falha).
  async function fromCacheLatest(p) {
    const row = await queryOneFn(
      'SELECT `taxa`, DATE_FORMAT(`data`, \'%Y-%m-%d\') AS `data` FROM `FinCambioCache` WHERE `par` = ? ORDER BY `data` DESC LIMIT 1',
      [p]
    );
    const taxa = taxaValida(row?.taxa);
    return taxa == null ? null : { taxa, data: isoDate(row?.data) };
  }

  async function fromCacheRange(p, start, end) {
    const rows = await queryFn(
      `SELECT DATE_FORMAT(\`data\`, '%Y-%m-%d') AS \`data\`, \`taxa\`
       FROM \`FinCambioCache\`
       WHERE \`par\` = ? AND \`data\` BETWEEN ? AND ?
       ORDER BY \`data\` ASC`,
      [p, start, end]
    );
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      data: isoDate(row?.data),
      taxa: taxaValida(row?.taxa)
    })).filter((point) => point.data && point.taxa != null);
  }

  async function saveCache(p, data, taxa) {
    await queryFn(
      `INSERT INTO \`FinCambioCache\` (\`par\`, \`data\`, \`taxa\`)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE \`taxa\` = VALUES(\`taxa\`), \`updatedAt\` = NOW(3)`,
      [p, data, taxa]
    );
  }

  // Busca a cotação na API. `data` opcional (YYYY-MM-DD) → cotação histórica;
  // ausente → 'latest'. Devolve Number ou null (falha/indisponível).
  async function fetchRate(from, to, data) {
    const path = data ? data : 'latest';
    const url = `https://api.frankfurter.dev/v1/${path}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
    try {
      const resp = await fetchFn(url);
      if (!resp?.ok) return null;
      const json = await resp.json();
      const taxa = taxaValida(json?.rates?.[to]);
      if (taxa == null) return null;
      return { taxa, data: isoDate(json?.date) || isoDate(data) || hojeUTC() };
    } catch {
      return null;
    }
  }

  async function fetchHistory(from, to, start, end) {
    const url = `https://api.frankfurter.dev/v1/${start}..${end}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
    try {
      const resp = await fetchFn(url);
      if (!resp?.ok) return [];
      const json = await resp.json();
      return Object.entries(json?.rates || {}).map(([data, rates]) => ({
        data: isoDate(data),
        taxa: taxaValida(rates?.[to])
      })).filter((point) => point.data && point.taxa != null).sort((a, b) => a.data.localeCompare(b.data));
    } catch {
      return [];
    }
  }

  // Taxa (1 `from` em `to`) na data pedida (default hoje). Ordem:
  //  1) mesma moeda → 1
  //  2) cache exato (par, data)
  //  3) API frankfurter (grava no cache)
  //  4) último cache do par (fallback offline)
  //  5) null (indisponível — chamador decide)
  async function getRateDetail(from, to, data = null) {
    const f = String(from || '').toUpperCase();
    const t = String(to || '').toUpperCase();
    if (!f || !t) return null;
    if (f === t) {
      return {
        taxa: 1,
        data: isoDate(data) || hojeUTC(),
        fonte: 'Conversao direta',
        status: 'mesma_moeda'
      };
    }
    const dataKey = data || hojeUTC();
    const p = par(f, t);

    const cached = await fromCacheExact(p, dataKey);
    if (cached != null) {
      return { taxa: cached, data: dataKey, fonte: 'BCE via Frankfurter', status: 'cache_exato' };
    }

    const fetched = await fetchRate(f, t, data);
    if (fetched != null) {
      await saveCache(p, fetched.data || dataKey, fetched.taxa).catch(() => {});
      return { taxa: fetched.taxa, data: fetched.data || dataKey, fonte: 'BCE via Frankfurter', status: 'oficial' };
    }

    const fallback = await fromCacheLatest(p);
    return fallback == null ? null : {
      taxa: fallback.taxa,
      data: fallback.data,
      fonte: 'BCE via Frankfurter',
      status: 'cache_anterior'
    };
  }

  async function getRate(from, to, data = null) {
    return (await getRateDetail(from, to, data))?.taxa ?? null;
  }

  // Converte `amount` de `from` p/ `to` na data pedida. Usa decimal.js p/ evitar
  // erro de arredondamento ao multiplicar pela taxa. Devolve:
  //   { valor: Number (2 casas), taxa, convertido: bool }
  // Se a taxa for indisponível e as moedas diferirem, `convertido=false` e o
  // valor volta SEM conversão (o chamador sinaliza consolidação incompleta).
  async function convert(amount, from, to, data = null) {
    const f = String(from || '').toUpperCase();
    const t = String(to || '').toUpperCase();
    const amt = new Decimal(Number(amount) || 0);
    if (f === t) return { valor: amt.toDecimalPlaces(2).toNumber(), taxa: 1, convertido: true };
    const taxa = await getRate(f, t, data);
    if (taxa == null) return { valor: amt.toDecimalPlaces(2).toNumber(), taxa: null, convertido: false };
    return { valor: amt.times(taxa).toDecimalPlaces(2).toNumber(), taxa, convertido: true };
  }

  async function getHistory(from, to, days = 30, endDate = null) {
    const f = String(from || '').toUpperCase();
    const t = String(to || '').toUpperCase();
    const safeDays = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
    const end = isoDate(endDate) || nowFn().toISOString().slice(0, 10);
    const start = shiftDate(end, -(safeDays - 1));

    if (f === t) {
      return start === end
        ? [{ data: end, taxa: 1 }]
        : [{ data: start, taxa: 1 }, { data: end, taxa: 1 }];
    }

    const memoKey = `${par(f, t)}|${safeDays}|${end}`;
    const memo = historyMemo.get(memoKey);
    if (memo && memo.expiresAt > nowFn().getTime()) return memo.points.map((point) => ({ ...point }));

    const fetched = await fetchHistory(f, t, start, end);
    if (fetched.length) {
      await Promise.all(fetched.map((point) => saveCache(par(f, t), point.data, point.taxa).catch(() => {})));
      historyMemo.set(memoKey, { expiresAt: nowFn().getTime() + HISTORY_TTL_MS, points: fetched });
      return fetched;
    }

    return await fromCacheRange(par(f, t), start, end);
  }

  async function getConversionSummary(amount, from, to, { days = 30, endDate = null } = {}) {
    const f = String(from || '').toUpperCase();
    const t = String(to || '').toUpperCase();
    const amt = new Decimal(Number(amount) || 0);
    const history = await getHistory(f, t, days, endDate);
    let taxa = history.at(-1)?.taxa ?? null;
    let cotacaoData = history.at(-1)?.data ?? null;

    if (taxa == null) {
      const current = await convert(amount, f, t);
      if (!current.convertido || current.taxa == null) return { ...current, historico: [], historico_disponivel: false, cotacao_data: null };
      taxa = current.taxa;
      cotacaoData = isoDate(endDate);
    }

    const converted = amt.times(taxa).toDecimalPlaces(2).toNumber();
    const historico = history.map((point) => ({
      data: point.data,
      taxa: point.taxa,
      valor_convertido: amt.times(point.taxa).toDecimalPlaces(2).toNumber()
    }));

    if (historico.length < 2) {
      return {
        valor: converted,
        taxa,
        convertido: true,
        cotacao_data: cotacaoData,
        historico,
        historico_disponivel: false,
        resumo: null
      };
    }

    const first = new Decimal(historico[0].taxa);
    const last = new Decimal(historico.at(-1).taxa);
    const rates = historico.map((point) => new Decimal(point.taxa));
    const min = Decimal.min(...rates);
    const max = Decimal.max(...rates);
    const average = rates.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(rates.length);
    const variation = last.minus(first).div(first).times(100);
    const amplitude = max.minus(min).div(min).times(100);
    const impact = amt.times(last.minus(first));
    const variationNumber = round(variation, 4);

    return {
      valor: converted,
      taxa,
      convertido: true,
      cotacao_data: cotacaoData,
      historico,
      historico_disponivel: true,
      resumo: {
        periodo_dias: Number(days),
        variacao_pct: variationNumber,
        menor_taxa: round(min, 8),
        maior_taxa: round(max, 8),
        taxa_media: round(average, 8),
        amplitude_pct: round(amplitude, 4),
        impacto_valor: impact.toDecimalPlaces(2).toNumber(),
        tendencia: Math.abs(variationNumber) < 0.1 ? 'estavel' : variationNumber > 0 ? 'alta' : 'baixa'
      }
    };
  }

  // Monta um mapa { moeda: taxa } de todas as `moedas` p/ a `base`, numa data.
  // Usado pela consolidação p/ converter subtotais por moeda de uma vez.
  // moedas iguais à base viram 1; taxa indisponível vira null (flag no retorno).
  async function buildRateMap(moedas, base, data = null) {
    const b = String(base || 'BRL').toUpperCase();
    const uniq = [...new Set((moedas || []).map((m) => String(m || '').toUpperCase()).filter(Boolean))];
    const map = {};
    let incompleto = false;
    for (const m of uniq) {
      if (m === b) { map[m] = 1; continue; }
      const taxa = await getRate(m, b, data);
      map[m] = taxa;
      if (taxa == null) incompleto = true;
    }
    return { map, incompleto };
  }

  return { getRate, getRateDetail, convert, getHistory, getConversionSummary, buildRateMap };
}

// Instância default (db real + fetch real).
export const cambio = buildCambioService();
