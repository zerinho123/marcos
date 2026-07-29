// ============================================================================
// db.js — pool MySQL2 + helpers do Finance Backend Standalone
// ============================================================================

import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { loadEnv } from './security/env.js';

const env = loadEnv();

// Monta as opções de SSL do banco de forma segura-por-configuração:
// - Se houver CA (DB_SSL_CA_PATH ou ?ssl_ca= na URL), valida o certificado de verdade.
// - Senão, respeita DB_SSL_REJECT_UNAUTHORIZED (default false p/ não quebrar hosting
//   com cert self-signed), mas avisa em produção que está sem validação.
function buildSslOptions(parsed) {
  const caPath = parsed.searchParams.get('ssl_ca') || env.DB_SSL_CA_PATH;
  let ca;
  if (caPath) {
    try {
      ca = readFileSync(caPath);
    } catch (e) {
      console.warn(`[db] DB_SSL_CA_PATH definido mas não foi possível ler "${caPath}": ${e?.message || e}`);
    }
  }
  const rejectUnauthorized = ca ? true : env.DB_SSL_REJECT_UNAUTHORIZED;
  if (env.NODE_ENV === 'production' && !rejectUnauthorized) {
    console.warn('[db] TLS do banco SEM validação de certificado (rejectUnauthorized=false). ' +
      'Para corrigir: configure DB_SSL_CA_PATH com a CA do provedor ou DB_SSL_REJECT_UNAUTHORIZED=true.');
  }
  return { rejectUnauthorized, ...(ca ? { ca } : {}) };
}

function parseDatabaseConfig() {
  const rawUrl = env.DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('DATABASE_URL ausente.');

  const parsed = new URL(rawUrl);
  const connectionLimit = Number.parseInt(parsed.searchParams.get('connection_limit') || '10', 10);
  const connectTimeoutSeconds = Number.parseInt(parsed.searchParams.get('connect_timeout') || '20', 10);
  const sslMode = parsed.searchParams.get('ssl-mode')?.toUpperCase();
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);

  let sslOpt = {};
  if (sslMode === 'REQUIRED') {
    sslOpt = { ssl: buildSslOptions(parsed) };
  } else if (sslMode !== 'DISABLED' && env.NODE_ENV === 'production' && !isLocalhost) {
    sslOpt = { ssl: buildSslOptions(parsed) };
  }

  return {
    host: parsed.hostname,
    port: Number.parseInt(parsed.port || '3306', 10),
    user: decodeURIComponent(parsed.username || ''),
    password: decodeURIComponent(parsed.password || ''),
    database: parsed.pathname.replace(/^\//, ''),
    waitForConnections: true,
    connectionLimit,
    queueLimit: 0,
    connectTimeout: connectTimeoutSeconds * 1000,
    enableKeepAlive: true,
    ...sslOpt
  };
}

export const pool = mysql.createPool(parseDatabaseConfig());

export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

export function getConnection() {
  return pool.getConnection();
}

// ────────────────────────────────────────────────────────────────────────────
// Insert/Update com whitelist das tabelas Finance
// ────────────────────────────────────────────────────────────────────────────

const ALLOWED_TABLES = new Set([
  'FinanceUser',
  'FinCategoria', 'FinContaBancaria', 'FinTransacao',
  'FinOrcamento', 'FinMeta',
  'FinContaPagar', 'FinContaReceber',
  'FinDividaPessoal', 'FinDividaEvento',
  'FinInvestimento', 'FinAporteInvestimento', 'FinInvestimentoCotacao',
  'FinDrePlanoReceita',
  'FinPrecificacaoConfig', 'FinPrecificacaoCategoria', 'FinPrecificacaoFuncao',
  'FinPrecificacaoItem', 'FinPrecificacaoVersao', 'FinPrecificacaoComponente', 'FinPrecificacaoFaixa',
  'FinanceRefreshToken', 'FinanceEmbedToken', 'FinanceWebhookToken',
  'Empresa', 'FinanceUserEmpresa'
]);

const columnCache = new Map();

// Invalida o cache de colunas de uma tabela. Necessário após um ALTER em runtime
// (ex.: schema-evolution adicionando coluna no boot) para que o executeInsert/
// executeUpdate enxergue a coluna nova em vez de continuar com o set antigo.
export function invalidateColumnsCache(table) {
  if (table) columnCache.delete(table);
  else columnCache.clear();
}

async function getColumns(table) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Tabela nao permitida: ${table}`);
  if (columnCache.has(table)) return columnCache.get(table);
  const rows = await query(`SHOW COLUMNS FROM \`${table}\``);
  const set = new Set(rows.map((r) => r.Field));
  columnCache.set(table, set);
  return set;
}

async function filterData(table, data) {
  const cols = await getColumns(table);
  return Object.fromEntries(
    Object.entries(data).filter(([k, v]) => v !== undefined && cols.has(k))
  );
}

export async function executeInsert(table, data) {
  const filtered = await filterData(table, data);
  const entries = Object.entries(filtered);
  if (!entries.length) throw new Error(`INSERT em ${table} sem campos validos.`);
  const cols = entries.map(([k]) => `\`${k}\``).join(', ');
  const placeholders = entries.map(() => '?').join(', ');
  const values = entries.map(([, v]) => v);
  await query(`INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders})`, values);
}

export async function executeUpdate(table, data, whereClause, whereValues = []) {
  const filtered = await filterData(table, data);
  const entries = Object.entries(filtered);
  if (!entries.length) return 0;
  const setSql = entries.map(([k]) => `\`${k}\` = ?`).join(', ');
  const values = [...entries.map(([, v]) => v), ...whereValues];
  const [result] = await pool.execute(
    `UPDATE \`${table}\` SET ${setSql} WHERE ${whereClause}`,
    values
  );
  return result.affectedRows ?? 0;
}
