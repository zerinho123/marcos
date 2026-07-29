import Decimal from 'decimal.js';

Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });

export class PricingValidationError extends Error {
  constructor(message, field = '') {
    super(message);
    this.name = 'PricingValidationError';
    this.field = field;
  }
}

const PRODUCT_COMPONENTS = new Set(['insumo', 'embalagem', 'frete', 'adicional']);
const SERVICE_COMPONENTS = new Set(['mao_obra', 'material', 'terceiro', 'adicional']);
const RATEIO_TYPES = new Set(['percentual', 'fixo']);

function dec(value, field, { min = null, max = null } = {}) {
  let parsed;
  try {
    parsed = new Decimal(value ?? 0);
  } catch {
    throw new PricingValidationError(`${field} deve ser numerico.`, field);
  }
  if (!parsed.isFinite()) throw new PricingValidationError(`${field} deve ser numerico.`, field);
  if (min !== null && parsed.lt(min)) throw new PricingValidationError(`${field} deve ser maior ou igual a ${min}.`, field);
  if (max !== null && parsed.gt(max)) throw new PricingValidationError(`${field} deve ser menor ou igual a ${max}.`, field);
  return parsed;
}

function out(value, places = 6) {
  return new Decimal(value).toDecimalPlaces(places).toNumber();
}

function validateComponents(tipoItem, components) {
  if (!Array.isArray(components) || components.length === 0) {
    throw new PricingValidationError('Informe ao menos um componente de custo.', 'componentes');
  }
  const allowed = tipoItem === 'produto' ? PRODUCT_COMPONENTS : SERVICE_COMPONENTS;
  return components.map((component, index) => {
    const prefix = `componentes[${index}]`;
    const tipo = String(component?.tipo || '').trim();
    const nome = String(component?.nome || '').trim();
    if (!allowed.has(tipo)) throw new PricingValidationError(`Tipo de componente invalido em ${prefix}.`, `${prefix}.tipo`);
    if (!nome) throw new PricingValidationError(`Nome obrigatorio em ${prefix}.`, `${prefix}.nome`);
    const quantidade = dec(component.quantidade, `${prefix}.quantidade`, { min: 0 });
    const custoUnitario = dec(component.custo_unitario, `${prefix}.custo_unitario`, { min: 0 });
    if (quantidade.eq(0)) throw new PricingValidationError(`Quantidade deve ser maior que zero em ${prefix}.`, `${prefix}.quantidade`);
    const perdaPct = tipoItem === 'produto'
      ? dec(component.perda_pct ?? 0, `${prefix}.perda_pct`, { min: 0, max: 100 })
      : new Decimal(0);
    const total = quantidade.mul(custoUnitario).mul(new Decimal(1).plus(perdaPct.div(100)));
    return {
      ...component,
      tipo,
      nome,
      unidade: String(component.unidade || (tipo === 'mao_obra' ? 'hora' : 'unidade')).trim(),
      quantidade: out(quantidade),
      custo_unitario: out(custoUnitario),
      perda_pct: out(perdaPct, 4),
      custo_total: out(total)
    };
  });
}

function validateRanges(ranges, defaultMargin) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new PricingValidationError('Informe ao menos uma faixa de volume.', 'faixas');
  }
  let expectedMin = 1;
  return ranges.map((range, index) => {
    const prefix = `faixas[${index}]`;
    const min = Number.parseInt(range?.quantidade_min, 10);
    const max = range?.quantidade_max === null || range?.quantidade_max === '' || range?.quantidade_max === undefined
      ? null
      : Number.parseInt(range.quantidade_max, 10);
    if (!Number.isInteger(min) || min !== expectedMin) {
      throw new PricingValidationError(`A faixa ${index + 1} deve iniciar em ${expectedMin}.`, `${prefix}.quantidade_min`);
    }
    if (index < ranges.length - 1 && (!Number.isInteger(max) || max < min)) {
      throw new PricingValidationError(`A faixa ${index + 1} precisa de limite maximo valido.`, `${prefix}.quantidade_max`);
    }
    if (index === ranges.length - 1 && max !== null) {
      throw new PricingValidationError('A ultima faixa nao pode ter limite maximo.', `${prefix}.quantidade_max`);
    }
    const ajuste = dec(range.custo_ajuste_pct ?? 0, `${prefix}.custo_ajuste_pct`);
    if (ajuste.lte(-100)) {
      throw new PricingValidationError('O ajuste de custo deve ser maior que -100%.', `${prefix}.custo_ajuste_pct`);
    }
    const margem = dec(range.margem_alvo_pct ?? defaultMargin, `${prefix}.margem_alvo_pct`, { min: 0, max: 100 });
    expectedMin = max === null ? expectedMin : max + 1;
    return {
      quantidade_min: min,
      quantidade_max: max,
      custo_ajuste_pct: out(ajuste, 4),
      margem_alvo_pct: out(margem, 4)
    };
  });
}

export function calculatePricing(input = {}) {
  const tipoItem = String(input.tipo_item || input.tipo || '').trim();
  if (!['produto', 'servico'].includes(tipoItem)) {
    throw new PricingValidationError('tipo_item deve ser produto ou servico.', 'tipo_item');
  }

  const components = validateComponents(tipoItem, input.componentes);
  const impostos = dec(input.impostos_pct ?? 0, 'impostos_pct', { min: 0, max: 100 });
  const comissao = dec(input.comissao_pct ?? 0, 'comissao_pct', { min: 0, max: 100 });
  const despesas = dec(input.despesas_variaveis_pct ?? 0, 'despesas_variaveis_pct', { min: 0, max: 100 });
  const margemPadrao = dec(input.margem_padrao_pct ?? 0, 'margem_padrao_pct', { min: 0, max: 100 });
  const encargos = impostos.plus(comissao).plus(despesas);
  if (encargos.gte(100)) throw new PricingValidationError('A soma dos encargos deve ser menor que 100%.', 'encargos');

  const rateioTipo = String(input.rateio_tipo || 'percentual').trim();
  if (!RATEIO_TYPES.has(rateioTipo)) throw new PricingValidationError('rateio_tipo invalido.', 'rateio_tipo');
  const rateioValor = dec(input.rateio_valor ?? 0, 'rateio_valor', { min: 0 });
  const ranges = validateRanges(input.faixas, margemPadrao);
  const direct = components.reduce((sum, component) => sum.plus(component.custo_total), new Decimal(0));

  const calculatedRanges = ranges.map((range) => {
    const adjustedDirect = direct.mul(new Decimal(1).plus(new Decimal(range.custo_ajuste_pct).div(100)));
    const overhead = rateioTipo === 'percentual'
      ? adjustedDirect.mul(rateioValor.div(100))
      : rateioValor;
    const base = adjustedDirect.plus(overhead);
    const minDenominator = new Decimal(1).minus(encargos.div(100));
    const targetDenominator = new Decimal(1).minus(encargos.plus(range.margem_alvo_pct).div(100));
    if (targetDenominator.lte(0)) {
      throw new PricingValidationError(
        `Encargos e margem da faixa iniciada em ${range.quantidade_min} devem somar menos que 100%.`,
        'faixas'
      );
    }
    const minimum = base.div(minDenominator);
    const suggested = base.div(targetDenominator);
    const realizedMargin = suggested.eq(0)
      ? new Decimal(0)
      : suggested.mul(minDenominator).minus(base).div(suggested).mul(100);
    return {
      ...range,
      custo_direto_ajustado: out(adjustedDirect),
      rateio: out(overhead),
      custo_base: out(base),
      preco_minimo: out(minimum, 2),
      preco_sugerido: out(suggested, 2),
      margem_resultante_pct: out(realizedMargin, 4)
    };
  });

  return {
    tipo_item: tipoItem,
    componentes: components,
    impostos_pct: out(impostos, 4),
    comissao_pct: out(comissao, 4),
    despesas_variaveis_pct: out(despesas, 4),
    encargos_pct: out(encargos, 4),
    margem_padrao_pct: out(margemPadrao, 4),
    rateio_tipo: rateioTipo,
    rateio_valor: out(rateioValor, 6),
    custo_direto: out(direct),
    faixas: calculatedRanges
  };
}
