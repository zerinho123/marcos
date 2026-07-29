import Decimal from 'decimal.js';
import { queryOne as dbQueryOne } from '../db.js';
import { cambio as defaultCambio } from '../security/cambio.js';
import { AppError } from '../security/errors.js';

export async function resolveMoedaBase(empresaId, queryOneFn = dbQueryOne) {
  const row = await queryOneFn(
    'SELECT `moeda_base` FROM `Empresa` WHERE `id` = ?',
    [empresaId]
  );
  return String(row?.moeda_base || 'BRL').toUpperCase();
}

export function convertAmountWithMap(amount, moeda, moedaBase, rateMap) {
  const code = String(moeda || moedaBase || 'BRL').toUpperCase();
  const rate = rateMap?.[code];
  return new Decimal(Number(amount) || 0)
    .times(rate == null ? 1 : Number(rate))
    .toDecimalPlaces(2)
    .toNumber();
}

function hasSnapshotForBase(row, base, fields) {
  if (String(row?.moeda_base || '').toUpperCase() !== base) return false;
  if (String(row?.cotacao_status || '') === 'legado_pendente') return false;
  return fields.every((field) => row?.[`${field}_base`] != null && Number.isFinite(Number(row[`${field}_base`])));
}

export async function createTransactionCurrencySnapshot(conn, {
  empresaId,
  conta,
  valor,
  data,
  cambioSvc = defaultCambio
}) {
  const moeda = String(conta?.moeda || 'BRL').toUpperCase();
  const [baseRows] = await conn.execute(
    'SELECT `moeda_base` FROM `Empresa` WHERE `id` = ? LIMIT 1',
    [empresaId]
  );
  const moedaBase = String(baseRows[0]?.moeda_base || 'BRL').toUpperCase();
  const quoteDate = String(data || '').slice(0, 10);
  let detail;

  if (moeda === moedaBase) {
    detail = { taxa: 1, data: quoteDate, fonte: 'Conversao direta', status: 'mesma_moeda' };
  } else if (typeof cambioSvc.getRateDetail === 'function') {
    detail = await cambioSvc.getRateDetail(moeda, moedaBase, quoteDate);
  } else {
    const taxa = await cambioSvc.getRate(moeda, moedaBase, quoteDate);
    detail = taxa == null ? null : {
      taxa,
      data: quoteDate,
      fonte: 'BCE via Frankfurter',
      status: 'oficial'
    };
  }

  const taxa = Number(detail?.taxa);
  if (!Number.isFinite(taxa) || taxa <= 0) {
    throw new AppError(
      'cambio_historico_indisponivel',
      `Cotacao historica indisponivel para ${moeda}/${moedaBase} em ${quoteDate}.`,
      503
    );
  }

  return {
    moeda,
    moeda_base: moedaBase,
    taxa_cambio: taxa,
    valor_base: new Decimal(valor).times(taxa).toDecimalPlaces(2).toNumber(),
    cotacao_data: String(detail?.data || quoteDate).slice(0, 10),
    cotacao_fonte: String(detail?.fonte || 'BCE via Frankfurter').slice(0, 64),
    cotacao_status: String(detail?.status || 'oficial').slice(0, 24)
  };
}

export async function enrichRowsWithBase(rows, {
  moedaBase = 'BRL',
  cambioSvc = defaultCambio,
  fields = ['valor']
} = {}) {
  const base = String(moedaBase || 'BRL').toUpperCase();
  const normalized = (rows || []).map((row) => ({
    ...row,
    moeda: String(row?.moeda || base).toUpperCase()
  }));
  const dynamicRows = normalized.filter((row) => !hasSnapshotForBase(row, base, fields));
  const snapshotIncompleto = dynamicRows.some((row) =>
    String(row?.cotacao_status || '') === 'legado_pendente'
    && row.moeda !== base
  );
  const { map, incompleto } = dynamicRows.length
    ? await cambioSvc.buildRateMap(dynamicRows.map((row) => row.moeda), base)
    : { map: {}, incompleto: false };
  const convertedRows = normalized.map((row) => {
    const converted = { ...row };
    const useSnapshot = hasSnapshotForBase(row, base, fields);
    for (const field of fields) {
      if (!useSnapshot) {
        converted[`${field}_base`] = convertAmountWithMap(row[field], row.moeda, base, map);
      }
    }
    if (fields.includes('valor') && fields.includes('valor_pago')) {
      converted.saldo_base = Math.max(0, Number(converted.valor_base) - Number(converted.valor_pago_base));
    }
    return converted;
  });
  return { rows: convertedRows, moeda_base: base, moeda_incompleta: incompleto || snapshotIncompleto };
}
