// ============================================================================
// schema-evolution.js — ajustes idempotentes de schema em produção
// ============================================================================

import { randomUUID } from 'node:crypto';
import { pool, invalidateColumnsCache } from './db.js';
import { ENC_PREFIX, encryptField, isEncryptionEnabled } from './security/encryption.js';

// DDL (CREATE/ALTER) e as leituras de metadados rodam pelo PROTOCOLO TEXTO
// (pool.query), não pelo prepared (pool.execute) — vários MySQL recusam
// CREATE TABLE/ALTER no protocolo de prepared statement ("not supported in the
// prepared statement protocol yet"), o que derrubava o boot (Passenger 503).
async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

async function columnExists(table, column) {
  const row = await queryOne(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  return !!row;
}

async function indexExists(table, indexName) {
  const row = await queryOne(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [indexName]);
  return !!row;
}

async function constraintExists(table, constraintName) {
  const db = await queryOne('SELECT DATABASE() AS db');
  const row = await queryOne(
    `SELECT CONSTRAINT_NAME
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ?
      LIMIT 1`,
    [db?.db, table, constraintName]
  );
  return !!row;
}

async function ensureAccountLink(table, afterColumn, indexName, constraintName) {
  if (!(await columnExists(table, 'conta_bancaria_id'))) {
    await query(
      `ALTER TABLE \`${table}\`
         ADD COLUMN \`conta_bancaria_id\` VARCHAR(191) NULL AFTER \`${afterColumn}\``
    );
  }
  if (!(await indexExists(table, indexName))) {
    await query(`ALTER TABLE \`${table}\` ADD KEY \`${indexName}\` (\`conta_bancaria_id\`)`);
  }
  if (!(await constraintExists(table, constraintName))) {
    await query(
      `ALTER TABLE \`${table}\`
         ADD CONSTRAINT \`${constraintName}\`
         FOREIGN KEY (\`conta_bancaria_id\`) REFERENCES \`FinContaBancaria\`(\`id\`)
         ON DELETE SET NULL ON UPDATE CASCADE`
    );
  }
}

export async function ensureFinanceAccountLinks() {
  await ensureAccountLink(
    'FinContaPagar',
    'categoria_id',
    'FinContaPagar_conta_idx',
    'FinContaPagar_conta_fk'
  );
  await ensureAccountLink(
    'FinContaReceber',
    'categoria_id',
    'FinContaReceber_conta_idx',
    'FinContaReceber_conta_fk'
  );
}

export async function ensureFinanceTransactionSoftDelete() {
  if (!(await columnExists('FinTransacao', 'ativo'))) {
    await query(
      'ALTER TABLE `FinTransacao` ADD COLUMN `ativo` TINYINT(1) NOT NULL DEFAULT 1 AFTER `conta_bancaria_id`'
    );
  }
  if (!(await indexExists('FinTransacao', 'FinTransacao_empresa_ativo_data_idx'))) {
    await query(
      'ALTER TABLE `FinTransacao` ADD KEY `FinTransacao_empresa_ativo_data_idx` (`empresa_id`, `ativo`, `data`)'
    );
  }

  await query(
    `UPDATE \`FinTransacao\` t
       LEFT JOIN \`FinContaBancaria\` cb
         ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
        SET t.\`ativo\` = 0, t.\`updatedAt\` = NOW(3)
      WHERE t.\`ativo\` = 1 AND (cb.\`id\` IS NULL OR cb.\`ativo\` = 0)`
  );
}

// ============================================================================
// Lockout de conta — contador de falhas de login consecutivas.
// O campo `locked_until` já existe no schema; faltava o contador que dispara o
// bloqueio. Idempotente: só adiciona a coluna se ainda não existir.
// ============================================================================
export async function ensureFinanceUserLockout() {
  if (!(await columnExists('FinanceUser', 'failed_login_attempts'))) {
    await query(
      'ALTER TABLE `FinanceUser` ADD COLUMN `failed_login_attempts` INT NOT NULL DEFAULT 0 AFTER `locked_until`'
    );
    // Garante que o cache de colunas do db.js (usado por executeUpdate) reflita a
    // coluna recém-criada, mesmo que algum login já tenha populado o cache antes.
    invalidateColumnsCache('FinanceUser');
  }
}

export async function ensureFinanceUserSecurityLifecycle() {
  if (!(await columnExists('FinanceUser', 'session_version'))) {
    await query('ALTER TABLE `FinanceUser` ADD COLUMN `session_version` INT NOT NULL DEFAULT 0');
    invalidateColumnsCache('FinanceUser');
  }
  if (!(await columnExists('FinanceUser', 'deleted_at'))) {
    await query('ALTER TABLE `FinanceUser` ADD COLUMN `deleted_at` DATETIME(3) NULL');
    invalidateColumnsCache('FinanceUser');
  }
  if (!(await indexExists('FinanceUser', 'FinanceUser_deleted_at_idx'))) {
    await query('ALTER TABLE `FinanceUser` ADD KEY `FinanceUser_deleted_at_idx` (`deleted_at`)');
  }
}

export async function ensureFinanceUserAccessLevel() {
  if (!(await columnExists('FinanceUser', 'access_level'))) {
    await query(
      "ALTER TABLE `FinanceUser` ADD COLUMN `access_level` VARCHAR(20) NOT NULL DEFAULT 'operacao' AFTER `workspaces`"
    );
    invalidateColumnsCache('FinanceUser');
  }
}

// ============================================================================
// Aprovação de cadastro — fluxo de auto-registro com moderação por admin.
// `status`: 'aprovado' (default, cobre usuários existentes e os criados pelo
// painel admin) | 'pendente' (auto-registro aguardando aprovação) |
// 'rejeitado'. `aprovado_por`/`aprovado_em` = trilha de auditoria da decisão.
// Idempotente.
// ============================================================================
export async function ensureFinanceUserAprovacao() {
  if (!(await columnExists('FinanceUser', 'status'))) {
    await query(
      "ALTER TABLE `FinanceUser` ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'aprovado' AFTER `role`"
    );
    invalidateColumnsCache('FinanceUser');
  }
  if (!(await columnExists('FinanceUser', 'aprovado_por'))) {
    await query(
      'ALTER TABLE `FinanceUser` ADD COLUMN `aprovado_por` VARCHAR(191) NULL AFTER `status`'
    );
    invalidateColumnsCache('FinanceUser');
  }
  if (!(await columnExists('FinanceUser', 'aprovado_em'))) {
    await query(
      'ALTER TABLE `FinanceUser` ADD COLUMN `aprovado_em` DATETIME(3) NULL AFTER `aprovado_por`'
    );
    invalidateColumnsCache('FinanceUser');
  }
  if (!(await indexExists('FinanceUser', 'FinanceUser_status_idx'))) {
    await query('ALTER TABLE `FinanceUser` ADD KEY `FinanceUser_status_idx` (`status`)');
  }
}

// ============================================================================
// E-mail do usuário (semi-obrigatório). Coluna nullable: validada quando vier
// preenchida, mas o cadastro não exige. Idempotente.
// ============================================================================
export async function ensureFinanceUserEmail() {
  if (!(await columnExists('FinanceUser', 'email'))) {
    await query(
      'ALTER TABLE `FinanceUser` ADD COLUMN `email` VARCHAR(191) NULL AFTER `nome`'
    );
    invalidateColumnsCache('FinanceUser');
  }
}

// ============================================================================
// Dados da solicitação de cadastro + situação de pagamento (verificação manual
// pelo admin). O auto-registro público coleta telefone/documento/empresa/plano;
// o admin confere o pagamento por fora (extrato) e marca `pagamento_status`
// (`pendente` default | `pago` | `isento`). `pagamento_por`/`pagamento_em` =
// trilha de auditoria de quem marcou e quando. Tudo aditivo/idempotente.
// ============================================================================
export async function ensureFinanceUserCadastroDados() {
  const addColumn = async (name, ddl) => {
    if (!(await columnExists('FinanceUser', name))) {
      await query(`ALTER TABLE \`FinanceUser\` ${ddl}`);
      invalidateColumnsCache('FinanceUser');
    }
  };
  await addColumn('telefone',           'ADD COLUMN `telefone` VARCHAR(32) NULL AFTER `email`');
  await addColumn('documento',          'ADD COLUMN `documento` VARCHAR(32) NULL AFTER `telefone`');
  await addColumn('empresa_solicitada', 'ADD COLUMN `empresa_solicitada` VARCHAR(191) NULL AFTER `documento`');
  await addColumn('plano',              'ADD COLUMN `plano` VARCHAR(120) NULL AFTER `empresa_solicitada`');
  await addColumn('pagamento_status',   "ADD COLUMN `pagamento_status` VARCHAR(16) NOT NULL DEFAULT 'pendente' AFTER `plano`");
  await addColumn('pagamento_por',      'ADD COLUMN `pagamento_por` VARCHAR(191) NULL AFTER `pagamento_status`');
  await addColumn('pagamento_em',       'ADD COLUMN `pagamento_em` DATETIME(3) NULL AFTER `pagamento_por`');
}

// ============================================================================
// Dono da categoria — `user_id` por conta de usuário. Nullable: categorias
// legadas/semeadas ficam `user_id = NULL` (compartilhadas/visíveis a todos);
// novas categorias recebem o id do usuário que as criou. Idempotente.
// ============================================================================
export async function ensureFinanceCategoriaOwner() {
  if (!(await columnExists('FinCategoria', 'user_id'))) {
    await query(
      'ALTER TABLE `FinCategoria` ADD COLUMN `user_id` VARCHAR(191) NULL AFTER `empresa_id`'
    );
    invalidateColumnsCache('FinCategoria');
  }
  if (!(await indexExists('FinCategoria', 'FinCategoria_empresa_user_idx'))) {
    await query(
      'ALTER TABLE `FinCategoria` ADD KEY `FinCategoria_empresa_user_idx` (`empresa_id`, `user_id`)'
    );
  }
}

// ============================================================================
// Webhook token — guarda sha256(token) em vez do token em texto puro.
// Idempotente: adiciona `token_hash` e afrouxa `token` para NULL (permite que o
// lookup migre os tokens legados para hash e apague o texto puro na 1ª utilização).
// ============================================================================
export async function ensureFinanceCategoriaPessoal() {
  await query(
    `CREATE TABLE IF NOT EXISTS \`FinCategoriaPessoal\` (
       \`id\`         VARCHAR(191) NOT NULL,
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`user_id\`    VARCHAR(191) NULL,
       \`nome\`       VARCHAR(120) NOT NULL,
       \`natureza\`   VARCHAR(16)  NULL,
       \`icone\`      VARCHAR(50)  NULL,
       \`cor\`        VARCHAR(16)  NULL,
       \`ativo\`      TINYINT(1)   NOT NULL DEFAULT 1,
       \`createdAt\`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       \`updatedAt\`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`id\`),
       UNIQUE KEY \`FinCategoriaPessoal_empresa_user_nome_key\` (\`empresa_id\`, \`user_id\`, \`nome\`),
       KEY \`FinCategoriaPessoal_empresa_user_idx\` (\`empresa_id\`, \`user_id\`, \`ativo\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  if (!(await columnExists('FinTransacao', 'categoria_pessoal_id'))) {
    await query(
      'ALTER TABLE `FinTransacao` ADD COLUMN `categoria_pessoal_id` VARCHAR(191) NULL AFTER `categoria_id`'
    );
    invalidateColumnsCache('FinTransacao');
  }
  if (!(await indexExists('FinTransacao', 'FinTransacao_categoria_pessoal_idx'))) {
    await query('ALTER TABLE `FinTransacao` ADD KEY `FinTransacao_categoria_pessoal_idx` (`categoria_pessoal_id`)');
  }
  if (!(await constraintExists('FinTransacao', 'FinTransacao_categoria_pessoal_fk'))) {
    await query(
      `ALTER TABLE \`FinTransacao\`
         ADD CONSTRAINT \`FinTransacao_categoria_pessoal_fk\`
         FOREIGN KEY (\`categoria_pessoal_id\`) REFERENCES \`FinCategoriaPessoal\`(\`id\`)
         ON DELETE SET NULL ON UPDATE CASCADE`
    );
  }
}

export async function ensureFinanceOrcamentoPessoal() {
  await query('ALTER TABLE `FinOrcamento` MODIFY COLUMN `categoria_id` VARCHAR(191) NULL').catch(() => {});
  if (!(await columnExists('FinOrcamento', 'categoria_pessoal_id'))) {
    await query(
      'ALTER TABLE `FinOrcamento` ADD COLUMN `categoria_pessoal_id` VARCHAR(191) NULL AFTER `categoria_id`'
    );
    invalidateColumnsCache('FinOrcamento');
  }
  if (!(await indexExists('FinOrcamento', 'FinOrcamento_categoria_pessoal_idx'))) {
    await query('ALTER TABLE `FinOrcamento` ADD KEY `FinOrcamento_categoria_pessoal_idx` (`categoria_pessoal_id`)');
  }
  if (!(await indexExists('FinOrcamento', 'FinOrcamento_empresa_cat_pessoal_mes_key'))) {
    await query(
      'ALTER TABLE `FinOrcamento` ADD UNIQUE KEY `FinOrcamento_empresa_cat_pessoal_mes_key` (`empresa_id`, `categoria_pessoal_id`, `mes`)'
    );
  }
  if (!(await constraintExists('FinOrcamento', 'FinOrcamento_categoria_pessoal_fk'))) {
    await query(
      `ALTER TABLE \`FinOrcamento\`
         ADD CONSTRAINT \`FinOrcamento_categoria_pessoal_fk\`
         FOREIGN KEY (\`categoria_pessoal_id\`) REFERENCES \`FinCategoriaPessoal\`(\`id\`)
         ON DELETE CASCADE ON UPDATE CASCADE`
    );
  }
  if (!(await columnExists('FinOrcamento', 'data_inicio'))) {
    await query('ALTER TABLE `FinOrcamento` ADD COLUMN `data_inicio` DATE NULL AFTER `mes`');
    invalidateColumnsCache('FinOrcamento');
  }
  if (!(await columnExists('FinOrcamento', 'data_fim'))) {
    await query('ALTER TABLE `FinOrcamento` ADD COLUMN `data_fim` DATE NULL AFTER `data_inicio`');
    invalidateColumnsCache('FinOrcamento');
  }
  await query('UPDATE `FinOrcamento` SET `data_inicio` = `mes` WHERE `data_inicio` IS NULL').catch(() => {});
  await query('UPDATE `FinOrcamento` SET `data_fim` = LAST_DAY(`mes`) WHERE `data_fim` IS NULL').catch(() => {});
}

export async function ensureFinanceWebhookTokenHash() {
  if (!(await columnExists('FinanceWebhookToken', 'token_hash'))) {
    await query(
      'ALTER TABLE `FinanceWebhookToken` ADD COLUMN `token_hash` CHAR(64) NULL AFTER `token`'
    );
  }
  if (!(await indexExists('FinanceWebhookToken', 'FinanceWebhookToken_token_hash_unique'))) {
    await query(
      'ALTER TABLE `FinanceWebhookToken` ADD UNIQUE KEY `FinanceWebhookToken_token_hash_unique` (`token_hash`)'
    );
  }
  // Permite token = NULL para podermos apagar o texto puro após migrar para hash.
  await query('ALTER TABLE `FinanceWebhookToken` MODIFY COLUMN `token` VARCHAR(191) NULL').catch(() => {});
}

// ============================================================================
// DRE editável — linhas de detalhe data-driven, mapa categoria→linha e metas.
// Tudo idempotente: roda no boot e não falha se já existir.
// ============================================================================
export async function ensureFinanceDreConfig() {
  // 1) Linhas de detalhe editáveis do DRE (por empresa/seção).
  await query(
    `CREATE TABLE IF NOT EXISTS \`FinDreLinha\` (
       \`id\`         VARCHAR(191) NOT NULL,
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`secao\`      VARCHAR(32)  NOT NULL,
       \`nome\`       VARCHAR(191) NOT NULL,
       \`ordem\`      INT          NOT NULL DEFAULT 0,
       \`ativo\`      TINYINT(1)   NOT NULL DEFAULT 1,
       \`createdAt\`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       \`updatedAt\`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`id\`),
       KEY \`FinDreLinha_empresa_secao_idx\` (\`empresa_id\`, \`secao\`, \`ordem\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  // 2) Mapa categoria → linha do DRE.
  if (!(await columnExists('FinCategoria', 'dre_linha_id'))) {
    await query('ALTER TABLE `FinCategoria` ADD COLUMN `dre_linha_id` VARCHAR(191) NULL AFTER `dre_secao`');
  }
  if (!(await indexExists('FinCategoria', 'FinCategoria_dre_linha_idx'))) {
    await query('ALTER TABLE `FinCategoria` ADD KEY `FinCategoria_dre_linha_idx` (`dre_linha_id`)');
  }
  if (!(await constraintExists('FinCategoria', 'FinCategoria_dre_linha_fk'))) {
    await query(
      `ALTER TABLE \`FinCategoria\`
         ADD CONSTRAINT \`FinCategoria_dre_linha_fk\`
         FOREIGN KEY (\`dre_linha_id\`) REFERENCES \`FinDreLinha\`(\`id\`)
         ON DELETE SET NULL ON UPDATE CASCADE`
    );
  }

  // 3) Meta/projetado por linha e mês.
  await query(
    `CREATE TABLE IF NOT EXISTS \`FinDreMeta\` (
       \`empresa_id\` VARCHAR(191)  NOT NULL,
       \`linha_id\`   VARCHAR(191)  NOT NULL,
       \`mes\`        DATE          NOT NULL,
       \`valor\`      DECIMAL(15,2) NOT NULL DEFAULT 0,
       \`updatedAt\`  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`empresa_id\`, \`linha_id\`, \`mes\`),
       KEY \`FinDreMeta_linha_idx\` (\`linha_id\`),
       CONSTRAINT \`FinDreMeta_linha_fk\`
         FOREIGN KEY (\`linha_id\`) REFERENCES \`FinDreLinha\`(\`id\`)
         ON DELETE CASCADE ON UPDATE CASCADE
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  // 3b) Ajuste manual sobre o realizado + auditoria (quem editou).
  //     Bases legadas: adiciona as colunas se ainda não existirem. Idempotente.
  if (!(await columnExists('FinDreMeta', 'ajuste_real'))) {
    await query(
      'ALTER TABLE `FinDreMeta` ADD COLUMN `ajuste_real` DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER `valor`'
    );
  }
  if (!(await columnExists('FinDreMeta', 'updated_by'))) {
    await query(
      'ALTER TABLE `FinDreMeta` ADD COLUMN `updated_by` VARCHAR(191) NULL AFTER `ajuste_real`'
    );
  }

  // 4) DRE por usuário (Fase 1): dimensão `user_id` ('' = template da empresa,
  //    qualquer outro = DRE pessoal daquele admin). Aditivo: as linhas/metas atuais
  //    viram template (DEFAULT ''). A cópia do mapa template é lazy em
  //    `ensureFinanceDreLinhasSeeded`. Idempotente.
  if (!(await columnExists('FinDreLinha', 'user_id'))) {
    await query("ALTER TABLE `FinDreLinha` ADD COLUMN `user_id` VARCHAR(191) NOT NULL DEFAULT '' AFTER `empresa_id`");
  }
  if (!(await indexExists('FinDreLinha', 'FinDreLinha_empresa_user_secao_idx'))) {
    await query('ALTER TABLE `FinDreLinha` ADD KEY `FinDreLinha_empresa_user_secao_idx` (`empresa_id`, `user_id`, `secao`, `ordem`)');
  }
  if (!(await columnExists('FinDreMeta', 'user_id'))) {
    await query("ALTER TABLE `FinDreMeta` ADD COLUMN `user_id` VARCHAR(191) NOT NULL DEFAULT '' AFTER `empresa_id`");
  }

  // Mapa categoria→linha por escopo (substitui o uso de FinCategoria.dre_linha_id,
  // que permanece como legado/fonte da migração lazy).
  await query(
    `CREATE TABLE IF NOT EXISTS \`FinDreUserMapa\` (
       \`empresa_id\`   VARCHAR(191) NOT NULL,
       \`user_id\`      VARCHAR(191) NOT NULL DEFAULT '',
       \`categoria_id\` VARCHAR(191) NOT NULL,
       \`linha_id\`     VARCHAR(191) NOT NULL,
       \`updatedAt\`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`empresa_id\`, \`user_id\`, \`categoria_id\`),
       KEY \`FinDreUserMapa_linha_idx\` (\`linha_id\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  // Layout do DRE por escopo: colunas visíveis/ordem + ordem de seções (JSON).
  await query(
    `CREATE TABLE IF NOT EXISTS \`FinDreUserConfig\` (
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`user_id\`    VARCHAR(191) NOT NULL DEFAULT '',
       \`config\`     LONGTEXT     NOT NULL,
       \`updatedAt\`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`empresa_id\`, \`user_id\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  // 5) DRE Fase 2: linhas de total com fórmula editável por escopo (data-driven).
  await query(
    `CREATE TABLE IF NOT EXISTS \`FinDreFormula\` (
       \`id\`         VARCHAR(191) NOT NULL,
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`user_id\`    VARCHAR(191) NOT NULL DEFAULT '',
       \`chave\`      VARCHAR(64)  NOT NULL,
       \`nome\`       VARCHAR(191) NOT NULL,
       \`formula\`    LONGTEXT     NOT NULL,
       \`formato\`    VARCHAR(16)  NOT NULL DEFAULT 'currency',
       \`oculto\`     TINYINT(1)   NOT NULL DEFAULT 0,
       \`ordem\`      INT          NOT NULL DEFAULT 0,
       \`ativo\`      TINYINT(1)   NOT NULL DEFAULT 1,
       \`createdAt\`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       \`updatedAt\`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`id\`),
       UNIQUE KEY \`FinDreFormula_escopo_chave\` (\`empresa_id\`, \`user_id\`, \`chave\`),
       KEY \`FinDreFormula_escopo_ordem\` (\`empresa_id\`, \`user_id\`, \`ordem\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

// ============================================================================
// Preferência de período do dashboard por usuário/escopo (JSON).
// Mesmo padrão de FinDreUserConfig: PK (empresa_id, user_id, escopo) + config LONGTEXT.
// Guarda { tipo:'mes'|'custom', dataInicio:'YYYY-MM-DD', dataFim:'YYYY-MM-DD' }.
// Aditivo puro e idempotente — seguro rodar sempre no boot.
// ============================================================================
export async function ensureFinanceDashboardConfig() {
  await query(
    `CREATE TABLE IF NOT EXISTS \`FinDashboardUserConfig\` (
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`user_id\`    VARCHAR(191) NOT NULL DEFAULT '',
       \`escopo\`     VARCHAR(16)  NOT NULL DEFAULT 'empresarial',
       \`config\`     LONGTEXT     NOT NULL,
       \`updatedAt\`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`empresa_id\`, \`user_id\`, \`escopo\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

// ============================================================================
// Multi-moeda: moeda por conta bancária + moeda-base de consolidação por empresa
// + cache de cotações (FinCambioCache). Aditivo/idempotente. O DEFAULT 'BRL' faz
// os dados existentes continuarem 100% BRL — sem mudança de comportamento até que
// alguém crie uma conta em outra moeda.
// ============================================================================
export async function ensureFinanceMoeda() {
  if (!(await columnExists('Empresa', 'moeda_base'))) {
    await query("ALTER TABLE `Empresa` ADD COLUMN `moeda_base` VARCHAR(3) NOT NULL DEFAULT 'BRL' AFTER `telefone`");
    invalidateColumnsCache('Empresa');
  }
  if (!(await columnExists('FinContaBancaria', 'moeda'))) {
    await query("ALTER TABLE `FinContaBancaria` ADD COLUMN `moeda` VARCHAR(3) NOT NULL DEFAULT 'BRL' AFTER `tipo`");
    invalidateColumnsCache('FinContaBancaria');
  }
  await query(
    `CREATE TABLE IF NOT EXISTS \`FinCambioCache\` (
       \`par\`       VARCHAR(7)     NOT NULL,
       \`data\`      DATE           NOT NULL,
       \`taxa\`      DECIMAL(18,8)  NOT NULL,
       \`updatedAt\` DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`par\`, \`data\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

// Snapshot monetario por lancamento. A moeda da conta e a moeda-base podem
// mudar no futuro; o movimento precisa continuar reproduzivel e auditavel.
export async function ensureFinanceTransactionCurrencySnapshot() {
  const columns = [
    ['moeda', "VARCHAR(3) NULL AFTER `valor`"],
    ['moeda_base', "VARCHAR(3) NULL AFTER `moeda`"],
    ['taxa_cambio', "DECIMAL(18,8) NULL AFTER `moeda_base`"],
    ['valor_base', "DECIMAL(15,2) NULL AFTER `taxa_cambio`"],
    ['cotacao_data', "DATE NULL AFTER `valor_base`"],
    ['cotacao_fonte', "VARCHAR(64) NULL AFTER `cotacao_data`"],
    ['cotacao_status', "VARCHAR(24) NOT NULL DEFAULT 'legado_pendente' AFTER `cotacao_fonte`"],
    ['correcao_de_id', "VARCHAR(191) NULL AFTER `origem_id`"],
    ['cancelado_em', "DATETIME(3) NULL AFTER `correcao_de_id`"],
    ['cancelado_por', "VARCHAR(191) NULL AFTER `cancelado_em`"]
  ];
  for (const [name, definition] of columns) {
    if (!(await columnExists('FinTransacao', name))) {
      await query(`ALTER TABLE \`FinTransacao\` ADD COLUMN \`${name}\` ${definition}`);
      invalidateColumnsCache('FinTransacao');
    }
  }
  if (!(await indexExists('FinTransacao', 'FinTransacao_correcao_idx'))) {
    await query('ALTER TABLE `FinTransacao` ADD KEY `FinTransacao_correcao_idx` (`empresa_id`, `correcao_de_id`)');
  }

  await query(
    `UPDATE \`FinTransacao\` t
       JOIN \`FinContaBancaria\` cb ON cb.\`id\` = t.\`conta_bancaria_id\` AND cb.\`empresa_id\` = t.\`empresa_id\`
       JOIN \`Empresa\` e ON e.\`id\` = t.\`empresa_id\`
        SET t.\`moeda\` = COALESCE(t.\`moeda\`, cb.\`moeda\`, 'BRL'),
            t.\`moeda_base\` = COALESCE(t.\`moeda_base\`, e.\`moeda_base\`, 'BRL')
      WHERE t.\`moeda\` IS NULL OR t.\`moeda_base\` IS NULL`
  );
  await query(
    `UPDATE \`FinTransacao\`
        SET \`taxa_cambio\` = 1,
            \`valor_base\` = \`valor\`,
            \`cotacao_data\` = \`data\`,
            \`cotacao_fonte\` = 'Conversao direta',
            \`cotacao_status\` = 'mesma_moeda'
      WHERE \`moeda\` = \`moeda_base\` AND \`valor_base\` IS NULL`
  );
  await query(
    `UPDATE \`FinTransacao\`
        SET \`cotacao_status\` = 'legado_pendente'
      WHERE \`moeda\` <> \`moeda_base\` AND \`valor_base\` IS NULL`
  );
}

// ============================================================================
// Escopo de workspace — separacao TOTAL Pessoal x Empresarial.
// ----------------------------------------------------------------------------
// Adiciona `escopo` (pessoal|empresarial) como dimensao de 1a classe nas tabelas
// transacionais e faz o BACKFILL determinístico dos dados existentes UMA vez (no
// mesmo passo do ADD COLUMN — idempotente: se a coluna ja existe, nao re-backfilla).
// `FinContaBancaria.escopo` ja existe (fonte de verdade). `FinDre*`/`FinPrecificacao*`
// ficam de fora (ja sao exclusivas do empresarial). `FinInvestimento*` fica de fora
// (decisao do usuario: definir por registro depois).
//
// Derivacao do backfill:
//   FinCategoria   : tipo -> escopo (pessoal->pessoal; empresarial/ambos->empresarial)
//   FinTransacao   : = conta.escopo; sem conta -> categoria.escopo; senao 'pessoal'
//   FinOrcamento   : = categoria.escopo
//   FinContaPagar  : = conta.escopo; sem conta -> 'empresarial'
//   FinContaReceber: = conta.escopo; sem conta -> 'empresarial'
//   FinMeta/Divida*: 'pessoal' (coberto pelo DEFAULT da coluna)
// ============================================================================
async function addEscopoColumn(table, afterColumn, defaultVal = 'pessoal') {
  if (await columnExists(table, 'escopo')) return false;
  await query(
    `ALTER TABLE \`${table}\` ADD COLUMN \`escopo\` VARCHAR(16) NOT NULL DEFAULT '${defaultVal}' AFTER \`${afterColumn}\``
  );
  invalidateColumnsCache(table);
  return true; // recem-criada -> rodar backfill
}

async function addEscopoIndex(table) {
  const idx = `${table}_empresa_escopo_idx`;
  if (!(await indexExists(table, idx))) {
    await query(`ALTER TABLE \`${table}\` ADD KEY \`${idx}\` (\`empresa_id\`, \`escopo\`)`);
  }
}

export async function ensureFinanceEscopo() {
  // 1) FinCategoria — escopo derivado de `tipo` (ambos conta como empresarial).
  if (await addEscopoColumn('FinCategoria', 'tipo')) {
    await query("UPDATE `FinCategoria` SET `escopo` = CASE WHEN `tipo` = 'pessoal' THEN 'pessoal' ELSE 'empresarial' END");
  }
  await addEscopoIndex('FinCategoria');

  // Unicidade do nome de categoria deve ser POR ESCOPO, não global por empresa.
  // O schema base tinha UNIQUE(empresa_id, nome) -> bloqueava "Comissão" no
  // Empresarial se já existisse no Pessoal (e vice-versa). Troca por
  // UNIQUE(empresa_id, escopo, nome). Idempotente: adiciona a nova antes de
  // derrubar a antiga. A antiga era MAIS estrita, então os dados atuais já
  // satisfazem a nova (sem risco de duplicata na migração).
  if (!(await indexExists('FinCategoria', 'FinCategoria_empresa_escopo_nome_key'))) {
    await query('ALTER TABLE `FinCategoria` ADD UNIQUE KEY `FinCategoria_empresa_escopo_nome_key` (`empresa_id`, `escopo`, `nome`)');
  }
  if (await indexExists('FinCategoria', 'FinCategoria_empresa_nome_key')) {
    await query('ALTER TABLE `FinCategoria` DROP INDEX `FinCategoria_empresa_nome_key`');
  }

  // 2) FinTransacao — via conta; sem conta, via categoria; senao 'pessoal' (default).
  if (await addEscopoColumn('FinTransacao', 'conta_bancaria_id')) {
    await query('UPDATE `FinTransacao` t JOIN `FinContaBancaria` cb ON cb.`id` = t.`conta_bancaria_id` SET t.`escopo` = cb.`escopo`');
    await query('UPDATE `FinTransacao` t JOIN `FinCategoria` c ON c.`id` = t.`categoria_id` SET t.`escopo` = c.`escopo` WHERE t.`conta_bancaria_id` IS NULL');
  }
  await addEscopoIndex('FinTransacao');

  // 3) FinOrcamento — via categoria.
  if (await addEscopoColumn('FinOrcamento', 'categoria_id')) {
    await query('UPDATE `FinOrcamento` o JOIN `FinCategoria` c ON c.`id` = o.`categoria_id` SET o.`escopo` = c.`escopo`');
  }
  await addEscopoIndex('FinOrcamento');

  // 4) AR/AP — via conta; sem conta -> empresarial (views exclusivas do empresarial).
  if (await addEscopoColumn('FinContaPagar', 'conta_bancaria_id', 'empresarial')) {
    await query('UPDATE `FinContaPagar` p JOIN `FinContaBancaria` cb ON cb.`id` = p.`conta_bancaria_id` SET p.`escopo` = cb.`escopo`');
  }
  await addEscopoIndex('FinContaPagar');
  if (await addEscopoColumn('FinContaReceber', 'conta_bancaria_id', 'empresarial')) {
    await query('UPDATE `FinContaReceber` r JOIN `FinContaBancaria` cb ON cb.`id` = r.`conta_bancaria_id` SET r.`escopo` = cb.`escopo`');
  }
  await addEscopoIndex('FinContaReceber');

  // 5) Pessoais por natureza — escopo 'pessoal' (DEFAULT cobre o backfill).
  await addEscopoColumn('FinMeta', 'empresa_id');
  await addEscopoIndex('FinMeta');
  await addEscopoColumn('FinDividaPessoal', 'empresa_id');
  await addEscopoIndex('FinDividaPessoal');
  await addEscopoColumn('FinDividaEvento', 'empresa_id');
  await addEscopoIndex('FinDividaEvento');
}

// ============================================================================
// Modelo de lançamento como fonte única (Categoria classifica → Lançamento é a
// fonte → movimenta Conta). Aditivo e idempotente. Faz:
//  1) FinTransacao: status, origem, origem_id, observacao (+ índice origem).
//  2) FinContaPagar/FinContaReceber: lancamento_id (FK p/ FinTransacao).
//  3) FinCategoria: natureza, comportamento, usar_no_dre, usar_na_precificacao.
//  4) FinContaBancaria: saldo_inicial.
//  5) BACKFILL do histórico: cada AP/AR já paga (valor_pago>0, com conta) que
//     ainda não tem lançamento ganha UM FinTransacao espelho (origem=conta_a_*,
//     origem_id=id), SEM mexer no saldo (o saldo já foi movido na baixa antiga).
//  6) BACKFILL saldo_inicial = saldo − Σ(efeitos dos lançamentos ativos), rodado
//     UMA vez (quando a coluna é criada) e DEPOIS do passo 5, p/ que a invariante
//     `saldo = saldo_inicial + Σ(lançamentos)` valha já com os espelhos de AP/AR.
//
// Depois disto, TODOS os relatórios podem ler só FinTransacao sem perder o
// histórico de AP/AR e sem dupla contagem.
// ============================================================================
export async function ensureFinanceLancamentoModel() {
  // 1) FinTransacao — campos de origem/status/observação.
  if (!(await columnExists('FinTransacao', 'status'))) {
    await query("ALTER TABLE `FinTransacao` ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'pago' AFTER `escopo`");
    invalidateColumnsCache('FinTransacao');
  }
  if (!(await columnExists('FinTransacao', 'origem'))) {
    await query("ALTER TABLE `FinTransacao` ADD COLUMN `origem` VARCHAR(24) NOT NULL DEFAULT 'lancamento_manual' AFTER `status`");
    invalidateColumnsCache('FinTransacao');
  }
  if (!(await columnExists('FinTransacao', 'origem_id'))) {
    await query('ALTER TABLE `FinTransacao` ADD COLUMN `origem_id` VARCHAR(191) NULL AFTER `origem`');
    invalidateColumnsCache('FinTransacao');
  }
  if (!(await columnExists('FinTransacao', 'observacao'))) {
    await query('ALTER TABLE `FinTransacao` ADD COLUMN `observacao` VARCHAR(500) NULL AFTER `origem_id`');
    invalidateColumnsCache('FinTransacao');
  }
  if (!(await indexExists('FinTransacao', 'FinTransacao_origem_idx'))) {
    await query('ALTER TABLE `FinTransacao` ADD KEY `FinTransacao_origem_idx` (`empresa_id`, `origem`, `origem_id`)');
  }

  // 2) AP/AR — vínculo com o lançamento gerado na baixa.
  for (const table of ['FinContaPagar', 'FinContaReceber']) {
    if (!(await columnExists(table, 'lancamento_id'))) {
      await query(`ALTER TABLE \`${table}\` ADD COLUMN \`lancamento_id\` VARCHAR(191) NULL AFTER \`conta_bancaria_id\``);
      invalidateColumnsCache(table);
    }
    const idx = `${table}_lancamento_idx`;
    if (!(await indexExists(table, idx))) {
      await query(`ALTER TABLE \`${table}\` ADD KEY \`${idx}\` (\`lancamento_id\`)`);
    }
    const fk = `${table}_lancamento_fk`;
    if (!(await constraintExists(table, fk))) {
      await query(
        `ALTER TABLE \`${table}\`
           ADD CONSTRAINT \`${fk}\`
           FOREIGN KEY (\`lancamento_id\`) REFERENCES \`FinTransacao\`(\`id\`)
           ON DELETE SET NULL ON UPDATE CASCADE`
      );
    }
  }

  // 3) FinCategoria — natureza/comportamento + flags de uso.
  if (!(await columnExists('FinCategoria', 'natureza'))) {
    await query('ALTER TABLE `FinCategoria` ADD COLUMN `natureza` VARCHAR(16) NULL AFTER `escopo`');
    invalidateColumnsCache('FinCategoria');
    // Backfill best-effort a partir da seção do DRE: seções de receita → receita;
    // o resto → despesa. Categorias sem seção ficam NULL (definíveis na UI).
    await query(
      "UPDATE `FinCategoria` SET `natureza` = CASE " +
      "WHEN `dre_secao` IN ('receita_bruta','deducoes') THEN 'receita' " +
      "WHEN `dre_secao` IS NULL THEN NULL ELSE 'despesa' END"
    );
  }
  if (!(await columnExists('FinCategoria', 'comportamento'))) {
    await query('ALTER TABLE `FinCategoria` ADD COLUMN `comportamento` VARCHAR(16) NULL AFTER `natureza`');
    invalidateColumnsCache('FinCategoria');
  }
  if (!(await columnExists('FinCategoria', 'usar_no_dre'))) {
    await query('ALTER TABLE `FinCategoria` ADD COLUMN `usar_no_dre` TINYINT(1) NOT NULL DEFAULT 1 AFTER `comportamento`');
    invalidateColumnsCache('FinCategoria');
  }
  if (!(await columnExists('FinCategoria', 'usar_na_precificacao'))) {
    await query('ALTER TABLE `FinCategoria` ADD COLUMN `usar_na_precificacao` TINYINT(1) NOT NULL DEFAULT 0 AFTER `usar_no_dre`');
    invalidateColumnsCache('FinCategoria');
  }

  // 4) FinContaBancaria — saldo inicial (abertura) separado do saldo corrente.
  const saldoInicialNovo = !(await columnExists('FinContaBancaria', 'saldo_inicial'));
  if (saldoInicialNovo) {
    await query('ALTER TABLE `FinContaBancaria` ADD COLUMN `saldo_inicial` DECIMAL(15,2) NOT NULL DEFAULT 0.00 AFTER `tipo`');
    invalidateColumnsCache('FinContaBancaria');
  }

  // 5) BACKFILL histórico AP→despesa / AR→receita (idempotente via lancamento_id IS NULL).
  //    UUID() gera id com hifens (compatível com randomUUID das rotas). Sem mexer no saldo.
  await query(
    `INSERT INTO \`FinTransacao\`
       (\`id\`, \`empresa_id\`, \`tipo\`, \`valor\`, \`data\`, \`descricao\`,
        \`categoria_id\`, \`conta_bancaria_id\`, \`escopo\`, \`ativo\`,
        \`status\`, \`origem\`, \`origem_id\`, \`createdAt\`, \`updatedAt\`)
     SELECT UUID(), cp.\`empresa_id\`, 'despesa', cp.\`valor_pago\`, cp.\`data_pagamento\`,
            CONCAT('Pagamento: ', cp.\`credor\`), cp.\`categoria_id\`, cp.\`conta_bancaria_id\`,
            cp.\`escopo\`, 1, 'pago', 'conta_a_pagar', cp.\`id\`, NOW(3), NOW(3)
       FROM \`FinContaPagar\` cp
      WHERE cp.\`valor_pago\` > 0 AND cp.\`data_pagamento\` IS NOT NULL
        AND cp.\`conta_bancaria_id\` IS NOT NULL AND cp.\`lancamento_id\` IS NULL
        AND cp.\`credor\` NOT LIKE 'enc:v1:%'`
  );
  await query(
    `UPDATE \`FinContaPagar\` cp
        JOIN \`FinTransacao\` t ON t.\`origem\` = 'conta_a_pagar' AND t.\`origem_id\` = cp.\`id\`
        SET cp.\`lancamento_id\` = t.\`id\`
      WHERE cp.\`lancamento_id\` IS NULL`
  );
  await query(
    `INSERT INTO \`FinTransacao\`
       (\`id\`, \`empresa_id\`, \`tipo\`, \`valor\`, \`data\`, \`descricao\`,
        \`categoria_id\`, \`conta_bancaria_id\`, \`escopo\`, \`ativo\`,
        \`status\`, \`origem\`, \`origem_id\`, \`createdAt\`, \`updatedAt\`)
     SELECT UUID(), cr.\`empresa_id\`, 'receita', cr.\`valor_pago\`, cr.\`data_recebimento\`,
            CONCAT('Recebimento: ', cr.\`devedor_nome\`), cr.\`categoria_id\`, cr.\`conta_bancaria_id\`,
            cr.\`escopo\`, 1, 'recebido', 'conta_a_receber', cr.\`id\`, NOW(3), NOW(3)
       FROM \`FinContaReceber\` cr
      WHERE cr.\`valor_pago\` > 0 AND cr.\`data_recebimento\` IS NOT NULL
        AND cr.\`conta_bancaria_id\` IS NOT NULL AND cr.\`lancamento_id\` IS NULL
        AND cr.\`devedor_nome\` NOT LIKE 'enc:v1:%'`
  );
  await query(
    `UPDATE \`FinContaReceber\` cr
        JOIN \`FinTransacao\` t ON t.\`origem\` = 'conta_a_receber' AND t.\`origem_id\` = cr.\`id\`
        SET cr.\`lancamento_id\` = t.\`id\`
      WHERE cr.\`lancamento_id\` IS NULL`
  );

  // 6) BACKFILL saldo_inicial só na criação da coluna (depois dos espelhos do passo 5).
  //    saldo_inicial = saldo − Σ(receitas − despesas dos lançamentos ativos da conta).
  if (saldoInicialNovo) {
    await query(
      `UPDATE \`FinContaBancaria\` cb
          SET cb.\`saldo_inicial\` = cb.\`saldo\` - COALESCE((
                SELECT SUM(CASE WHEN t.\`tipo\` = 'receita' THEN t.\`valor\` ELSE -t.\`valor\` END)
                  FROM \`FinTransacao\` t
                 WHERE t.\`conta_bancaria_id\` = cb.\`id\`
                   AND t.\`empresa_id\` = cb.\`empresa_id\` AND t.\`ativo\` = 1
              ), 0)`
    );
  }
}

// ============================================================================
// Precificacao empresarial — catalogo, custos, faixas e versoes imutaveis.
// ============================================================================
export async function ensureFinancePricing() {
  await query(
    `CREATE TABLE IF NOT EXISTS \`FinPrecificacaoConfig\` (
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`impostos_pct\` DECIMAL(9,4) NOT NULL DEFAULT 0,
       \`comissao_pct\` DECIMAL(9,4) NOT NULL DEFAULT 0,
       \`despesas_variaveis_pct\` DECIMAL(9,4) NOT NULL DEFAULT 0,
       \`margem_padrao_pct\` DECIMAL(9,4) NOT NULL DEFAULT 20,
       \`rateio_tipo\` VARCHAR(16) NOT NULL DEFAULT 'percentual',
       \`rateio_valor\` DECIMAL(15,6) NOT NULL DEFAULT 0,
       \`updated_by\` VARCHAR(191) NULL,
       \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`empresa_id\`),
       CONSTRAINT \`FinPrecificacaoConfig_rateio_chk\` CHECK (\`rateio_tipo\` IN ('percentual','fixo'))
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await query(
    `CREATE TABLE IF NOT EXISTS \`FinPrecificacaoCategoria\` (
       \`id\` VARCHAR(191) NOT NULL,
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`nome\` VARCHAR(120) NOT NULL,
       \`ativo\` TINYINT(1) NOT NULL DEFAULT 1,
       \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`id\`),
       UNIQUE KEY \`FinPrecificacaoCategoria_empresa_nome_key\` (\`empresa_id\`, \`nome\`),
       KEY \`FinPrecificacaoCategoria_empresa_idx\` (\`empresa_id\`, \`ativo\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await query(
    `CREATE TABLE IF NOT EXISTS \`FinPrecificacaoFuncao\` (
       \`id\` VARCHAR(191) NOT NULL,
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`nome\` VARCHAR(120) NOT NULL,
       \`custo_hora\` DECIMAL(15,6) NOT NULL DEFAULT 0,
       \`ativo\` TINYINT(1) NOT NULL DEFAULT 1,
       \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`id\`),
       UNIQUE KEY \`FinPrecificacaoFuncao_empresa_nome_key\` (\`empresa_id\`, \`nome\`),
       KEY \`FinPrecificacaoFuncao_empresa_idx\` (\`empresa_id\`, \`ativo\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await query(
    `CREATE TABLE IF NOT EXISTS \`FinPrecificacaoItem\` (
       \`id\` VARCHAR(191) NOT NULL,
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`categoria_id\` VARCHAR(191) NULL,
       \`tipo\` VARCHAR(16) NOT NULL,
       \`nome\` VARCHAR(191) NOT NULL,
       \`codigo\` VARCHAR(80) NULL,
       \`unidade\` VARCHAR(40) NOT NULL DEFAULT 'unidade',
       \`descricao\` TEXT NULL,
       \`ativo\` TINYINT(1) NOT NULL DEFAULT 1,
       \`created_by\` VARCHAR(191) NULL,
       \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`id\`),
       UNIQUE KEY \`FinPrecificacaoItem_empresa_nome_key\` (\`empresa_id\`, \`nome\`),
       UNIQUE KEY \`FinPrecificacaoItem_empresa_codigo_key\` (\`empresa_id\`, \`codigo\`),
       KEY \`FinPrecificacaoItem_empresa_idx\` (\`empresa_id\`, \`ativo\`, \`tipo\`),
       KEY \`FinPrecificacaoItem_categoria_idx\` (\`categoria_id\`),
       CONSTRAINT \`FinPrecificacaoItem_tipo_chk\` CHECK (\`tipo\` IN ('produto','servico')),
       CONSTRAINT \`FinPrecificacaoItem_categoria_fk\` FOREIGN KEY (\`categoria_id\`) REFERENCES \`FinPrecificacaoCategoria\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await query(
    `CREATE TABLE IF NOT EXISTS \`FinPrecificacaoVersao\` (
       \`id\` VARCHAR(191) NOT NULL,
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`item_id\` VARCHAR(191) NOT NULL,
       \`numero\` INT NOT NULL,
       \`status\` VARCHAR(16) NOT NULL DEFAULT 'rascunho',
       \`vigencia_inicio\` DATETIME(3) NULL,
       \`impostos_pct\` DECIMAL(9,4) NOT NULL DEFAULT 0,
       \`comissao_pct\` DECIMAL(9,4) NOT NULL DEFAULT 0,
       \`despesas_variaveis_pct\` DECIMAL(9,4) NOT NULL DEFAULT 0,
       \`margem_padrao_pct\` DECIMAL(9,4) NOT NULL DEFAULT 20,
       \`rateio_tipo\` VARCHAR(16) NOT NULL DEFAULT 'percentual',
       \`rateio_valor\` DECIMAL(15,6) NOT NULL DEFAULT 0,
       \`custo_direto\` DECIMAL(18,6) NULL,
       \`created_by\` VARCHAR(191) NULL,
       \`published_by\` VARCHAR(191) NULL,
       \`published_at\` DATETIME(3) NULL,
       \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`id\`),
       UNIQUE KEY \`FinPrecificacaoVersao_item_numero_key\` (\`item_id\`, \`numero\`),
       KEY \`FinPrecificacaoVersao_empresa_item_idx\` (\`empresa_id\`, \`item_id\`, \`status\`, \`vigencia_inicio\`),
       CONSTRAINT \`FinPrecificacaoVersao_status_chk\` CHECK (\`status\` IN ('rascunho','publicada','cancelada')),
       CONSTRAINT \`FinPrecificacaoVersao_rateio_chk\` CHECK (\`rateio_tipo\` IN ('percentual','fixo')),
       CONSTRAINT \`FinPrecificacaoVersao_item_fk\` FOREIGN KEY (\`item_id\`) REFERENCES \`FinPrecificacaoItem\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await query(
    `CREATE TABLE IF NOT EXISTS \`FinPrecificacaoComponente\` (
       \`id\` VARCHAR(191) NOT NULL,
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`versao_id\` VARCHAR(191) NOT NULL,
       \`funcao_id\` VARCHAR(191) NULL,
       \`tipo\` VARCHAR(24) NOT NULL,
       \`nome\` VARCHAR(191) NOT NULL,
       \`unidade\` VARCHAR(40) NOT NULL,
       \`quantidade\` DECIMAL(18,6) NOT NULL,
       \`custo_unitario\` DECIMAL(18,6) NOT NULL,
       \`perda_pct\` DECIMAL(9,4) NOT NULL DEFAULT 0,
       \`custo_total\` DECIMAL(18,6) NOT NULL,
       \`ordem\` INT NOT NULL DEFAULT 0,
       PRIMARY KEY (\`id\`),
       KEY \`FinPrecificacaoComponente_versao_idx\` (\`versao_id\`, \`ordem\`),
       KEY \`FinPrecificacaoComponente_empresa_idx\` (\`empresa_id\`),
       CONSTRAINT \`FinPrecificacaoComponente_versao_fk\` FOREIGN KEY (\`versao_id\`) REFERENCES \`FinPrecificacaoVersao\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
       CONSTRAINT \`FinPrecificacaoComponente_funcao_fk\` FOREIGN KEY (\`funcao_id\`) REFERENCES \`FinPrecificacaoFuncao\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await query(
    `CREATE TABLE IF NOT EXISTS \`FinPrecificacaoFaixa\` (
       \`id\` VARCHAR(191) NOT NULL,
       \`empresa_id\` VARCHAR(191) NOT NULL,
       \`versao_id\` VARCHAR(191) NOT NULL,
       \`quantidade_min\` INT NOT NULL,
       \`quantidade_max\` INT NULL,
       \`custo_ajuste_pct\` DECIMAL(9,4) NOT NULL DEFAULT 0,
       \`margem_alvo_pct\` DECIMAL(9,4) NOT NULL,
       \`custo_direto_ajustado\` DECIMAL(18,6) NOT NULL,
       \`rateio\` DECIMAL(18,6) NOT NULL,
       \`custo_base\` DECIMAL(18,6) NOT NULL,
       \`preco_minimo\` DECIMAL(15,2) NOT NULL,
       \`preco_sugerido\` DECIMAL(15,2) NOT NULL,
       \`margem_resultante_pct\` DECIMAL(9,4) NOT NULL,
       \`ordem\` INT NOT NULL DEFAULT 0,
       PRIMARY KEY (\`id\`),
       UNIQUE KEY \`FinPrecificacaoFaixa_versao_min_key\` (\`versao_id\`, \`quantidade_min\`),
       KEY \`FinPrecificacaoFaixa_empresa_idx\` (\`empresa_id\`),
       CONSTRAINT \`FinPrecificacaoFaixa_versao_fk\` FOREIGN KEY (\`versao_id\`) REFERENCES \`FinPrecificacaoVersao\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

// ============================================================================
// Separação Pessoal x Empresarial — cada usuário ganha 1 "empresa pessoal"
// oculta (Empresa.tipo='pessoal'). `empresa_id` das tabelas Fin* continua
// NOT NULL em toda parte — nenhum redesenho de PK/FK/índice existente.
// Aditivo + idempotente: nenhum passo faz DROP/RENAME/DELETE.
// Espelha database/migrations/001-004 (mesma lógica, sem TEMPORARY TABLE:
// o pool pode despachar cada query() numa conexão física diferente, então
// uma tabela temporária criada numa chamada podia não existir na próxima —
// aqui o "staging" é feito em JS puro).
// ============================================================================
export async function ensureFinanceAmbientePessoal() {
  // 1) Empresa.tipo — normal (empresa de verdade) | pessoal (sintética por usuário).
  if (!(await columnExists('Empresa', 'tipo'))) {
    await query("ALTER TABLE `Empresa` ADD COLUMN `tipo` ENUM('normal','pessoal') NOT NULL DEFAULT 'normal' AFTER `nome`");
  }
  if (!(await indexExists('Empresa', 'Empresa_tipo_idx'))) {
    await query('ALTER TABLE `Empresa` ADD KEY `Empresa_tipo_idx` (`tipo`)');
  }

  // 2) FinanceUserEmpresa — vínculo N:M usuário↔empresa.
  await query(
    `CREATE TABLE IF NOT EXISTS \`FinanceUserEmpresa\` (
       \`id\`          VARCHAR(191) NOT NULL,
       \`user_id\`     VARCHAR(191) NOT NULL,
       \`empresa_id\`  VARCHAR(191) NOT NULL,
       \`perfil\`      ENUM('dono','admin','financeiro','visualizador') NOT NULL DEFAULT 'admin',
       \`ativo\`       TINYINT(1)   NOT NULL DEFAULT 1,
       \`createdAt\`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       \`updatedAt\`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (\`id\`),
       UNIQUE KEY \`FinanceUserEmpresa_user_empresa_key\` (\`user_id\`, \`empresa_id\`),
       KEY \`FinanceUserEmpresa_user_idx\` (\`user_id\`),
       KEY \`FinanceUserEmpresa_empresa_idx\` (\`empresa_id\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  if (!(await constraintExists('FinanceUserEmpresa', 'FinanceUserEmpresa_user_fk'))) {
    await query(
      `ALTER TABLE \`FinanceUserEmpresa\`
         ADD CONSTRAINT \`FinanceUserEmpresa_user_fk\`
         FOREIGN KEY (\`user_id\`) REFERENCES \`FinanceUser\`(\`id\`)
         ON DELETE CASCADE ON UPDATE CASCADE`
    );
  }
  if (!(await constraintExists('FinanceUserEmpresa', 'FinanceUserEmpresa_empresa_fk'))) {
    await query(
      `ALTER TABLE \`FinanceUserEmpresa\`
         ADD CONSTRAINT \`FinanceUserEmpresa_empresa_fk\`
         FOREIGN KEY (\`empresa_id\`) REFERENCES \`Empresa\`(\`id\`)
         ON DELETE CASCADE ON UPDATE CASCADE`
    );
  }

  // 3) Backfill: FinanceUser.empresa_id atual vira vínculo explícito (dono).
  //    Idempotente via NOT EXISTS — rodar de novo não duplica.
  await query(
    `INSERT INTO \`FinanceUserEmpresa\` (\`id\`, \`user_id\`, \`empresa_id\`, \`perfil\`)
     SELECT UUID(), fu.\`id\`, fu.\`empresa_id\`, 'dono'
       FROM \`FinanceUser\` fu
      WHERE fu.\`empresa_id\` IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM \`FinanceUserEmpresa\` fue
           WHERE fue.\`user_id\` = fu.\`id\` AND fue.\`empresa_id\` = fu.\`empresa_id\`
        )`
  );

  // 3b) Admins mantêm o acesso amplo que já tinham na prática: vínculo explícito
  //     com toda empresa normal existente. Necessário porque a validação de
  //     vínculo passou a valer também para admin (resolveAmbienteAlvo +
  //     validateEmpresaOverride). Idempotente via NOT EXISTS; revogação manual
  //     (ativo=0) não é desfeita — a linha existe, então o INSERT não repete.
  //     Empresas criadas depois ganham vínculo do criador em routes/empresas.js.
  await query(
    `INSERT INTO \`FinanceUserEmpresa\` (\`id\`, \`user_id\`, \`empresa_id\`, \`perfil\`)
     SELECT UUID(), fu.\`id\`, e.\`id\`, 'admin'
       FROM \`FinanceUser\` fu
       JOIN \`Empresa\` e ON e.\`tipo\` = 'normal'
      WHERE fu.\`role\` = 'admin'
        AND NOT EXISTS (
          SELECT 1 FROM \`FinanceUserEmpresa\` fue
           WHERE fue.\`user_id\` = fu.\`id\` AND fue.\`empresa_id\` = e.\`id\`
        )`
  );

  // 4) Backfill: 1 empresa pessoal por usuário que ainda não tem uma.
  const usersSemPessoal = await query(
    `SELECT fu.\`id\`, fu.\`nome\`
       FROM \`FinanceUser\` fu
      WHERE NOT EXISTS (
        SELECT 1 FROM \`FinanceUserEmpresa\` fue
        JOIN \`Empresa\` pe ON pe.\`id\` = fue.\`empresa_id\` AND pe.\`tipo\` = 'pessoal'
       WHERE fue.\`user_id\` = fu.\`id\` AND fue.\`ativo\` = 1
      )`
  );
  for (const user of usersSemPessoal) {
    const empresaId = randomUUID();
    await query(
      'INSERT INTO `Empresa` (`id`, `nome`, `tipo`) VALUES (?, ?, ?)',
      [empresaId, `Pessoal — ${user.nome}`, 'pessoal']
    );
    await query(
      'INSERT INTO `FinanceUserEmpresa` (`id`, `user_id`, `empresa_id`, `perfil`) VALUES (?, ?, ?, ?)',
      [randomUUID(), user.id, empresaId, 'dono']
    );
  }
}

// ============================================================================
// Backfill de dado pessoal existente para a empresa pessoal individual.
// Decisão do usuário (2026-07-01): migrar escopo='pessoal' já gravado sob a
// empresa "normal" para a empresa pessoal sintética de cada dono. Espelha
// database/migrations/005 e 006. Só migra o que é INEQUÍVOCO:
//  - FinCategoria com `user_id` explícito → sempre (dono já é conhecido).
//  - Resto (contas/transações/orçamentos/metas/dívidas/categoria sem dono) →
//    só em empresas com EXATAMENTE 1 usuário vinculado (dono implícito
//    inequívoco). Empresa com mais de 1 usuário fica de fora — ver
//    database/migrations/007_relatorio_pessoal_multiusuario.sql (só leitura,
//    decisão manual; não há como adivinhar de quem é cada lançamento).
// Idempotente: toda UPDATE é guardada por comparação de empresa_id atual —
// rodar de novo não re-move nada que já foi movido.
// ============================================================================
export async function ensureFinancePessoalBackfill() {
  // FinCategoria com dono explícito — independe de quantos usuários a empresa tem.
  await query(
    `UPDATE \`FinCategoria\` c
     JOIN \`FinanceUserEmpresa\` fue ON fue.\`user_id\` = c.\`user_id\` AND fue.\`ativo\` = 1
     JOIN \`Empresa\` pe ON pe.\`id\` = fue.\`empresa_id\` AND pe.\`tipo\` = 'pessoal'
        SET c.\`empresa_id\` = pe.\`id\`,
            c.\`dre_linha_id\` = NULL,
            c.\`dre_secao\` = NULL
      WHERE c.\`escopo\` = 'pessoal'
        AND c.\`user_id\` IS NOT NULL
        AND c.\`empresa_id\` <> pe.\`id\``
  );

  // Empresas 'normal' com exatamente 1 vínculo ativo → dono implícito inequívoco.
  const empresasUnicoUsuario = await query(
    `SELECT fue.\`empresa_id\` AS empresa_id, MIN(pe.\`id\`) AS pessoal_empresa_id
       FROM \`FinanceUserEmpresa\` fue
       JOIN \`Empresa\` e ON e.\`id\` = fue.\`empresa_id\` AND e.\`tipo\` = 'normal'
       JOIN \`FinanceUserEmpresa\` fue_p ON fue_p.\`user_id\` = fue.\`user_id\` AND fue_p.\`ativo\` = 1
       JOIN \`Empresa\` pe ON pe.\`id\` = fue_p.\`empresa_id\` AND pe.\`tipo\` = 'pessoal'
      WHERE fue.\`ativo\` = 1
      GROUP BY fue.\`empresa_id\`
     HAVING COUNT(DISTINCT fue.\`user_id\`) = 1`
  );

  for (const row of empresasUnicoUsuario) {
    const empresaId = row.empresa_id;
    const pessoalId = row.pessoal_empresa_id;
    await query(
      "UPDATE `FinContaBancaria` SET `empresa_id` = ? WHERE `empresa_id` = ? AND `escopo` = 'pessoal'",
      [pessoalId, empresaId]
    );
    await query(
      "UPDATE `FinTransacao` SET `empresa_id` = ? WHERE `empresa_id` = ? AND `escopo` = 'pessoal'",
      [pessoalId, empresaId]
    );
    await query(
      "UPDATE `FinOrcamento` SET `empresa_id` = ? WHERE `empresa_id` = ? AND `escopo` = 'pessoal'",
      [pessoalId, empresaId]
    );
    await query(
      "UPDATE `FinMeta` SET `empresa_id` = ? WHERE `empresa_id` = ? AND `escopo` = 'pessoal'",
      [pessoalId, empresaId]
    );
    await query(
      "UPDATE `FinCategoria` SET `empresa_id` = ?, `dre_linha_id` = NULL, `dre_secao` = NULL WHERE `empresa_id` = ? AND `escopo` = 'pessoal' AND `user_id` IS NULL",
      [pessoalId, empresaId]
    );
    await query(
      "UPDATE `FinDividaPessoal` SET `empresa_id` = ? WHERE `empresa_id` = ? AND `escopo` = 'pessoal'",
      [pessoalId, empresaId]
    );
  }

  // FinDividaEvento sempre segue o empresa_id ATUAL da dívida-pai (corrige
  // qualquer drift, mesmo de execuções anteriores) — nunca por escopo próprio.
  await query(
    `UPDATE \`FinDividaEvento\` ev
     JOIN \`FinDividaPessoal\` fd ON fd.\`id\` = ev.\`divida_id\`
        SET ev.\`empresa_id\` = fd.\`empresa_id\`
      WHERE ev.\`empresa_id\` <> fd.\`empresa_id\``
  );
}

// Trilha de auditoria (hardening 2026-07-07). Sem FK de propósito: o log deve
// sobreviver à deleção de usuários/empresas. Metadados apenas — nunca req.body.
export async function ensureFinanceAuditLog() {
  await query(`
    CREATE TABLE IF NOT EXISTS \`FinAuditLog\` (
      \`id\`          VARCHAR(191) NOT NULL,
      \`empresa_id\`  VARCHAR(191) NULL,
      \`user_id\`     VARCHAR(191) NULL,
      \`username\`    VARCHAR(191) NULL,
      \`role\`        VARCHAR(32)  NULL,
      \`action\`      VARCHAR(40)  NOT NULL DEFAULT 'http',
      \`method\`      VARCHAR(8)   NOT NULL,
      \`path\`        VARCHAR(255) NOT NULL,
      \`entity\`      VARCHAR(64)  NULL,
      \`entity_id\`   VARCHAR(191) NULL,
      \`status_code\` SMALLINT     NULL,
      \`ip\`          VARCHAR(64)  NULL,
      \`request_id\`  VARCHAR(64)  NULL,
      \`created_at\`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      KEY \`FinAuditLog_empresa_created_idx\` (\`empresa_id\`, \`created_at\`),
      KEY \`FinAuditLog_user_created_idx\` (\`user_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

// Criptografia em repouso (hardening 2026-07-07): os campos sensíveis passam a
// guardar ciphertext AES-256-GCM ("enc:v1:" + base64) — maior que o plaintext,
// então as colunas VARCHAR viram TEXT. Idempotente: MODIFY só quando o tipo
// atual ainda não é text. Nenhuma dessas colunas é indexada/filtrada em SQL.
const ENC_COLUMNS = [
  ['FinTransacao',     'descricao',     'NULL'],
  ['FinTransacao',     'observacao',    'NULL'],
  ['FinContaPagar',    'credor',        'NOT NULL'],
  ['FinContaPagar',    'descricao',     'NULL'],
  ['FinContaReceber',  'devedor_nome',  'NOT NULL'],
  ['FinContaReceber',  'devedor_email', 'NULL'],
  ['FinContaReceber',  'descricao',     'NULL'],
  ['FinDividaPessoal', 'credor',        'NOT NULL'],
  ['FinDividaPessoal', 'descricao',     'NULL'],
  ['FinDividaEvento',  'descricao',     'NULL'],
  ['Empresa',          'cnpj',          'NULL'],
  ['Empresa',          'email',         'NULL'],
  ['Empresa',          'telefone',      'NULL'],
  ['FinanceUser',      'email',         'NULL'],
  ['FinanceUser',      'telefone',      'NULL'],
  ['FinanceUser',      'documento',     'NULL'],
  ['FinanceUser',      'empresa_solicitada', 'NULL']
];

export async function ensureFinanceFieldEncryptionColumns() {
  const db = await queryOne('SELECT DATABASE() AS db');
  for (const [table, column, nullability] of ENC_COLUMNS) {
    const row = await queryOne(
      `SELECT DATA_TYPE AS dt FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [db?.db, table, column]
    );
    if (!row || String(row.dt).toLowerCase().includes('text')) continue;
    await query(`ALTER TABLE \`${table}\` MODIFY \`${column}\` TEXT ${nullability}`);
    invalidateColumnsCache(table);
  }
}

const FINANCE_USER_PII_FIELDS = ['email', 'telefone', 'documento', 'empresa_solicitada'];

export async function backfillFinanceUserPii({ queryFn = query, batchSize = 100 } = {}) {
  if (!isEncryptionEnabled()) {
    throw new Error('FINANCE_ENC_KEY_CURRENT obrigatoria para backfill de FinanceUser.');
  }
  const size = Math.max(1, Math.min(Number(batchSize) || 100, 1000));
  let cursor = '';
  let updated = 0;

  while (true) {
    const rows = await queryFn(
      `SELECT \`id\`, \`email\`, \`telefone\`, \`documento\`, \`empresa_solicitada\`
         FROM \`FinanceUser\`
        WHERE \`id\` > ?
        ORDER BY \`id\`
        LIMIT ${size}`,
      [cursor]
    );
    if (!rows.length) break;

    for (const row of rows) {
      const entries = FINANCE_USER_PII_FIELDS
        .filter((field) => row[field] != null && row[field] !== '' && !String(row[field]).startsWith(ENC_PREFIX))
        .map((field) => [field, encryptField(row[field])]);
      if (entries.length) {
        await queryFn(
          `UPDATE \`FinanceUser\` SET ${entries.map(([field]) => `\`${field}\` = ?`).join(', ')} WHERE \`id\` = ?`,
          [...entries.map(([, value]) => value), row.id]
        );
        updated += 1;
      }
    }
    cursor = rows.at(-1).id;
  }
  return { updated };
}

// ============================================================================
// Lixeira universal (v87). Toda exclusao — soft-delete existente ou hard
// delete convertido — passa a registrar aqui antes de sumir da tela. Sem FK
// de proposito (mesmo raciocinio do FinAuditLog): a lixeira precisa sobreviver
// a exclusao do usuario e da empresa que ela documenta.
// ============================================================================
export async function ensureFinanceLixeira() {
  await query(`
    CREATE TABLE IF NOT EXISTS \`FinLixeira\` (
      \`id\`                 VARCHAR(191) NOT NULL,
      \`grupo_id\`           VARCHAR(191) NOT NULL,
      \`entidade\`           VARCHAR(40)  NOT NULL,
      \`entidade_id\`        VARCHAR(191) NOT NULL,
      \`empresa_id\`         VARCHAR(191) NULL,
      \`escopo\`             VARCHAR(16)  NULL,
      \`estrategia\`         VARCHAR(16)  NOT NULL,
      \`snapshot\`           LONGTEXT     NULL,
      \`rotulo\`             TEXT         NULL,
      \`valor\`              DECIMAL(15,2) NULL,
      \`excluido_por\`       VARCHAR(191) NULL,
      \`excluido_por_nome\`  VARCHAR(191) NULL,
      \`excluido_em\`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`restaurado_em\`      DATETIME(3)  NULL,
      \`restaurado_por\`     VARCHAR(191) NULL,
      \`purgado_em\`         DATETIME(3)  NULL,
      PRIMARY KEY (\`id\`),
      KEY \`FinLixeira_empresa_idx\` (\`empresa_id\`, \`escopo\`, \`excluido_em\`),
      KEY \`FinLixeira_grupo_idx\` (\`grupo_id\`),
      KEY \`FinLixeira_entidade_idx\` (\`entidade\`, \`entidade_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

// ============================================================================
// Delegacao de usuarios (v87). Um gestor comanda N contas pessoais de
// terceiros sem nunca saber a senha delas — o ambiente "pessoal" delegado
// vira uma troca de empresa_id ativo (ver security/ambiente.js), reusando
// toda a maquina de isolamento por empresa_id que ja existe. FK CASCADE:
// se o gestor ou o usuario gerido for apagado de verdade (nunca via lixeira
// normal, so num expurgo manual), a delegacao morre junto — nao ha razao
// pra ela sobreviver a exclusao fisica de qualquer uma das pontas.
// ============================================================================
export async function ensureFinanceDelegacao() {
  await query(`
    CREATE TABLE IF NOT EXISTS \`FinanceDelegacao\` (
      \`id\`             VARCHAR(191) NOT NULL,
      \`gestor_id\`      VARCHAR(191) NOT NULL,
      \`usuario_id\`     VARCHAR(191) NOT NULL,
      \`permissao\`      ENUM('visualizar','operar') NOT NULL DEFAULT 'visualizar',
      \`ativo\`          TINYINT(1)   NOT NULL DEFAULT 1,
      \`concedido_por\`  VARCHAR(191) NULL,
      \`createdAt\`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`updatedAt\`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`FinanceDelegacao_par_key\` (\`gestor_id\`, \`usuario_id\`),
      KEY \`FinanceDelegacao_gestor_idx\` (\`gestor_id\`, \`ativo\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  if (!(await constraintExists('FinanceDelegacao', 'FinanceDelegacao_gestor_fk'))) {
    await query(
      `ALTER TABLE \`FinanceDelegacao\`
         ADD CONSTRAINT \`FinanceDelegacao_gestor_fk\`
         FOREIGN KEY (\`gestor_id\`) REFERENCES \`FinanceUser\`(\`id\`)
         ON DELETE CASCADE ON UPDATE CASCADE`
    );
  }
  if (!(await constraintExists('FinanceDelegacao', 'FinanceDelegacao_usuario_fk'))) {
    await query(
      `ALTER TABLE \`FinanceDelegacao\`
         ADD CONSTRAINT \`FinanceDelegacao_usuario_fk\`
         FOREIGN KEY (\`usuario_id\`) REFERENCES \`FinanceUser\`(\`id\`)
         ON DELETE CASCADE ON UPDATE CASCADE`
    );
  }
}

// ============================================================================
// Papel 'dono' (v87). Um admin com um bit a mais — ver security/financeAuth.js
// (normalizacao role==='dono' -> 'admin' no req.financeUser, is_owner aparte).
// O CHECK de FinanceUser.role precisa aceitar o valor novo; se nenhum dono
// existir ainda, promove o admin mais antigo (idempotente: so roda se a
// contagem de donos for zero).
// ============================================================================
export async function ensureFinanceDono() {
  // Melhor esforco: alarga o CHECK de `role` pra aceitar 'dono'. Isolado num
  // try/catch proprio porque INFORMATION_SCHEMA.CHECK_CONSTRAINTS varia entre
  // MySQL/MariaDB/versoes (incidente real: sem esta protecao, uma falha aqui
  // travava o boot inteiro e derrubava 100% do login em producao). O CHECK do
  // banco e so defesa extra — a validacao de verdade (quem pode setar
  // role='dono') e no app: zod + assertRolePermitido em routes/users.js.
  try {
    const db = await queryOne('SELECT DATABASE() AS db');
    const check = await queryOne(
      `SELECT CHECK_CLAUSE FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME = ? LIMIT 1`,
      [db?.db, 'FinanceUser_role_chk']
    );
    const clause = check?.CHECK_CLAUSE || check?.check_clause || '';
    if (!/dono/i.test(clause)) {
      try {
        await query('ALTER TABLE `FinanceUser` DROP CHECK `FinanceUser_role_chk`');
      } catch {
        // constraint nao existia (instalacao antiga sem CHECK) — segue pro ADD.
      }
      await query(
        "ALTER TABLE `FinanceUser` ADD CONSTRAINT `FinanceUser_role_chk` CHECK (`role` IN ('dono','admin','usuario'))"
      );
    }
  } catch (e) {
    console.warn(`[schema-evolution] nao foi possivel alargar o CHECK de role (seguindo mesmo assim): ${e?.message || e}`);
  }

  const donoCount = await queryOne("SELECT COUNT(*) AS n FROM `FinanceUser` WHERE `role` = 'dono'");
  if (Number(donoCount?.n || 0) > 0) return;

  const candidato = await queryOne(
    `SELECT \`id\`, \`username\` FROM \`FinanceUser\`
      WHERE \`role\` = 'admin' AND \`deleted_at\` IS NULL
      ORDER BY \`createdAt\` ASC LIMIT 1`
  );
  if (!candidato) return; // sem admin ainda (instalacao zerada) — nada a promover.

  try {
    await query('UPDATE `FinanceUser` SET `role` = ? WHERE `id` = ?', ['dono', candidato.id]);
    console.log(`[schema-evolution] dono promovido: ${candidato.username}`);
  } catch (e) {
    // Se o bloco acima nao conseguiu alargar o CHECK, esta UPDATE pode ser
    // rejeitada pela constraint antiga. Nunca bloqueia o boot — fica sem
    // dono ate isso ser corrigido (manualmente ou num proximo deploy).
    console.warn(`[schema-evolution] nao foi possivel promover o dono automaticamente: ${e?.message || e}`);
  }
}
