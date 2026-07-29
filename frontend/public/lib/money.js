// lib/money.js — wrapper fino sobre currency.js vendorizado (D3/D11 do SDD).
// Corrige o bug de float em dinheiro (0.1 + 0.2 !== 0.3) sem trocar assinatura
// de reducer — só a aritmética interna. Opera em UMA moeda (não converte; a
// conversão multi-moeda é do backend, ver saldo_base / dashboard.saldo_total).
import currency from './vendor/currency.min.js?v=20260727-finance-v87';

const c = (v) => currency(Number(v) || 0, { precision: 2 });

// Soma encadeando currency.add() (soma em centavos inteiros) — evita reintroduzir
// erro de ponto flutuante na própria redução, não só na conversão inicial.
export function soma(lista, sel = (x) => x) {
  return (lista || []).reduce((acc, item) => acc.add(Number(sel(item)) || 0), c(0)).value;
}

export function mul(valor, taxa) {
  return c(valor).multiply(Number(taxa) || 0).value;
}

export function sub(a, b) {
  return c(a).subtract(Number(b) || 0).value;
}
