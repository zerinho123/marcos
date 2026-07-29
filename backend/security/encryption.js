// ============================================================================
// security/encryption.js — utilitarios criptograficos
//
// Criptografia em repouso (hardening 2026-07-07): campos sensíveis viram
// "enc:v1:" + base64(iv12 | authTag16 | ciphertext) com AES-256-GCM.
// Lazy migration: valor sem prefixo é plaintext legado e passa direto no
// decrypt; linhas novas/atualizadas saem cifradas. Sem chave configurada
// (FINANCE_ENC_KEY_CURRENT ausente) a criptografia fica DESLIGADA.
// ============================================================================

import {
  timingSafeEqual, createHash, randomBytes,
  createCipheriv, createDecipheriv
} from 'node:crypto';
import { loadEnv } from './env.js';
import { logger } from './logger.js';

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

// ────────────────────────────────────────────────────────────────────────────
// Criptografia de campo (AES-256-GCM)
// ────────────────────────────────────────────────────────────────────────────

export const ENC_PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
export const DECRYPT_FAIL_PLACEHOLDER = '[dado indisponivel]';

// Chaves lidas lazy e cacheadas — _resetEncryptionKeys() existe só para os
// testes de rotação (loadEnv é cacheado por processo, mas process.env muda).
let keysCache = null;
function getKeys() {
  if (keysCache) return keysCache;
  const env = loadEnv();
  keysCache = {
    current: env.FINANCE_ENC_KEY_CURRENT ? Buffer.from(env.FINANCE_ENC_KEY_CURRENT, 'hex') : null,
    previous: env.FINANCE_ENC_KEY_PREVIOUS ? Buffer.from(env.FINANCE_ENC_KEY_PREVIOUS, 'hex') : null
  };
  return keysCache;
}
export function _resetEncryptionKeys() { keysCache = null; }
// Só para testes (loadEnv é cacheado por processo e impede rotação via env):
export function _setEncryptionKeysForTest(currentHex, previousHex = '') {
  keysCache = {
    current: currentHex ? Buffer.from(currentHex, 'hex') : null,
    previous: previousHex ? Buffer.from(previousHex, 'hex') : null
  };
}

export function isEncryptionEnabled() {
  return Boolean(getKeys().current);
}

// Cifra um campo. Regras:
//   - null/undefined/'' → retorna como veio (colunas NULL continuam NULL);
//   - já prefixado → retorna como veio (IDEMPOTENTE — os PUTs fazem COALESCE
//     com o valor já cifrado vindo do banco; sem este guard = dupla cifra);
//   - sem chave configurada → plaintext (modo desligado).
export function encryptField(value) {
  if (value == null || value === '') return value;
  const str = String(value);
  if (str.startsWith(ENC_PREFIX)) return str;
  const { current } = getKeys();
  if (!current) return str;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', current, iv);
  const ct = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

function tryDecrypt(payload, key) {
  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = payload.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Decifra um campo. Sem prefixo = plaintext legado (lazy migration) → passa
// direto. Tenta CURRENT e depois PREVIOUS (rotação, espelha o fluxo do JWT).
// Falha total NÃO lança: devolve placeholder pra não derrubar listagens.
export function decryptField(value) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
  const { current, previous } = getKeys();
  const payload = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
  for (const key of [current, previous]) {
    if (!key) continue;
    try { return tryDecrypt(payload, key); } catch { /* tenta próxima */ }
  }
  logger.error({ msg: 'decryptField falhou (chave ausente/errada?)', len: value.length });
  return DECRYPT_FAIL_PLACEHOLDER;
}

// Ergonomia para as rotas de SQL inline (diffs mínimos):
export function encMany(obj, fields) {
  if (!obj) return obj;
  const out = { ...obj };
  for (const f of fields) out[f] = encryptField(out[f]);
  return out;
}

export function decOne(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) out[f] = decryptField(out[f]);
  return out;
}

export function decRows(rows, fields) {
  return Array.isArray(rows) ? rows.map((r) => decOne(r, fields)) : rows;
}

export function safeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
