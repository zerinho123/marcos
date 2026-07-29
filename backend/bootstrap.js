// ============================================================================
// bootstrap.js — carrega .env, instala error handlers, grava log em arquivo
// ============================================================================
// Tudo que acontece no boot vai para boot.log NA MESMA PASTA do server.js.
// Assim, mesmo sem acesso a logs de runtime, dá pra ler via File Manager.
// ============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH  = join(__dirname, 'boot.log');
const ENV_PATH  = join(__dirname, '.env');

// ─── Log helper (escreve em arquivo + stdout) ────────────────────────────────
function flog(level, msg, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}` +
               (extra ? '\n' + extra : '') + '\n';
  try { appendFileSync(LOG_PATH, line); } catch {}
  if (level === 'ERROR' || level === 'FATAL') console.error(line);
  else console.log(line);
}

// Limpa log anterior ao subir
try { writeFileSync(LOG_PATH, ''); } catch {}

flog('INFO', '═══════════════════════════════════════════');
flog('INFO', 'CF Finance — boot iniciando');
flog('INFO', '═══════════════════════════════════════════');
flog('INFO', `Node:       ${process.version}`);
flog('INFO', `Platform:   ${process.platform}`);
flog('INFO', `cwd:        ${process.cwd()}`);
flog('INFO', `__dirname:  ${__dirname}`);

// ─── Handlers globais ────────────────────────────────────────────────────────
process.on('uncaughtException', (e) => {
  flog('FATAL', 'uncaughtException', e?.stack || String(e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  flog('FATAL', 'unhandledRejection', e?.stack || String(e));
  process.exit(1);
});

// ─── Carrega .env ────────────────────────────────────────────────────────────
flog('INFO', `Procurando .env em: ${ENV_PATH}`);

if (existsSync(ENV_PATH)) {
  try {
    const content = readFileSync(ENV_PATH, 'utf8');
    let loaded = 0;
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // .env é a fonte da verdade (sobrescreve), exceto PORT/HOST que a
      // plataforma (Hostinger/Passenger) controla.
      if (key && (['PORT', 'HOST'].includes(key) ? !(key in process.env) : true)) {
        process.env[key] = val;
        loaded++;
      }
    }
    flog('INFO', `.env carregado — ${loaded} vars novas adicionadas`);
  } catch (e) {
    flog('ERROR', 'Erro ao parsear .env', e?.stack || String(e));
  }
} else {
  flog('WARN', '.env NAO encontrado — usando somente vars do ambiente');
}

// ─── Lista vars do ambiente (mascarando segredos) ────────────────────────────
const RELEVANT = [
  'NODE_ENV','HOST','PORT','DATABASE_URL',
  'JWT_SECRET_CURRENT','COOKIE_SECRET','CSRF_SECRET',
  'COOKIE_DOMAIN','COOKIE_SAMESITE','CORS_ORIGIN','JWT_ISSUER','JWT_AUDIENCE'
];
const SECRETS = new Set(['DATABASE_URL','JWT_SECRET_CURRENT','COOKIE_SECRET','CSRF_SECRET']);

flog('INFO', 'Estado das variaveis (segredos mascarados):');
for (const k of RELEVANT) {
  const v = process.env[k];
  if (v == null) {
    flog('INFO', `  ${k} = <ausente>`);
  } else if (SECRETS.has(k)) {
    flog('INFO', `  ${k} = ***${v.length} chars***`);
  } else {
    flog('INFO', `  ${k} = ${v}`);
  }
}

// ─── Validacao critica ───────────────────────────────────────────────────────
const CRITICAS = ['DATABASE_URL','JWT_SECRET_CURRENT','COOKIE_SECRET','CSRF_SECRET','COOKIE_DOMAIN'];
const faltando = CRITICAS.filter((k) => !process.env[k]);

if (faltando.length) {
  flog('FATAL', `Variaveis criticas faltando: ${faltando.join(', ')}`);
  flog('FATAL', `Configure no .env (mesmo diretorio do server.js) ou no painel da Hostinger.`);
  process.exit(1);
}

// ─── Tamanhos minimos ────────────────────────────────────────────────────────
const MIN_32 = ['JWT_SECRET_CURRENT','COOKIE_SECRET','CSRF_SECRET'];
const curtos = MIN_32.filter((k) => (process.env[k] || '').length < 32);
if (curtos.length) {
  flog('FATAL', `Segredos abaixo de 32 chars: ${curtos.join(', ')}`);
  process.exit(1);
}

flog('INFO', 'Validacao OK — passando controle pro server.js');
