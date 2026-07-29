// ============================================================================
// security/auth.js — hashing de senha (bcrypt)
// ============================================================================

import bcrypt from 'bcryptjs';
import { loadEnv } from './env.js';

const env = loadEnv();

export function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, env.BCRYPT_COST);
}

export async function verifyPassword(plain, stored) {
  if (!isBcryptHash(stored)) {
    return { ok: false, needsRehash: false, reason: 'unsupported_hash' };
  }
  const ok = await bcrypt.compare(plain, stored);
  if (!ok) return { ok: false, needsRehash: false };
  const cost = Number.parseInt(stored.slice(4, 6), 10);
  const needsRehash = Number.isFinite(cost) && cost < env.BCRYPT_COST;
  return { ok: true, needsRehash };
}
