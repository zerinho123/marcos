// ============================================================================
// routes/cambio.js — conversão pontual de moedas para a dashboard
// ============================================================================

import { Router } from 'express';
import { wrap } from './_common.js';
import { AppError, ERR } from '../security/errors.js';
import { cambio, isMoedaSuportada, MOEDAS_SUPORTADAS } from '../security/cambio.js';

const VALOR_MAXIMO = 1_000_000_000_000;
const PERIODOS_ACEITOS = [7, 30, 90];

function moeda(value, field) {
  const code = String(value || '').trim().toUpperCase();
  if (!isMoedaSuportada(code)) {
    throw ERR.VALIDATION(`${field} invalida. Valores aceitos: ${MOEDAS_SUPORTADAS.join(', ')}`);
  }
  return code;
}

export function validateCambioParams(raw = {}) {
  const valor = Number(raw.valor);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw ERR.VALIDATION('valor deve ser um numero maior que zero.');
  }
  if (valor > VALOR_MAXIMO) {
    throw ERR.VALIDATION(`valor deve ser menor ou igual a ${VALOR_MAXIMO}.`);
  }
  const dias = raw.dias == null || raw.dias === '' ? 30 : Number(raw.dias);
  if (!PERIODOS_ACEITOS.includes(dias)) {
    throw ERR.VALIDATION(`dias deve ser um dos valores: ${PERIODOS_ACEITOS.join(', ')}.`);
  }
  return {
    valor,
    de: moeda(raw.de, 'de'),
    para: moeda(raw.para, 'para'),
    dias
  };
}

export function buildCambioRouter({ cambioSvc = cambio, now = () => new Date() } = {}) {
  const router = Router();

  router.get('/converter', wrap(async (req, res) => {
    const params = validateCambioParams(req.query);
    const consultedAt = now();
    const result = typeof cambioSvc.getConversionSummary === 'function'
      ? await cambioSvc.getConversionSummary(params.valor, params.de, params.para, {
          days: params.dias,
          endDate: consultedAt.toISOString().slice(0, 10)
        })
      : await cambioSvc.convert(params.valor, params.de, params.para);
    const taxa = Number(result?.taxa);
    const convertido = Number(result?.valor);

    if (!result?.convertido || !Number.isFinite(taxa) || taxa <= 0 || !Number.isFinite(convertido)) {
      throw new AppError(
        'cambio_indisponivel',
        'Cotação indisponível no momento. Tente novamente em instantes.',
        503
      );
    }

    res.json({
      de: params.de,
      para: params.para,
      valor: params.valor,
      valor_convertido: convertido,
      taxa,
      cotacao_data: result.cotacao_data || null,
      consultado_em: consultedAt.toISOString(),
      fonte: params.de === params.para ? 'Conversao direta' : 'BCE via Frankfurter',
      historico_disponivel: Boolean(result.historico_disponivel),
      historico: Array.isArray(result.historico) ? result.historico : [],
      resumo: result.resumo || null,
      atualizacao: {
        automatica: true,
        intervalo_segundos: 900,
        natureza: 'referencia_diaria'
      }
    });
  }));

  return router;
}
