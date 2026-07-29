-- ============================================================================
-- 20260707_security_features.sql — hardening: criptografia em repouso + audit log
-- ----------------------------------------------------------------------------
-- RODAR ANTES DO DEPLOY DO CÓDIGO (via phpMyAdmin, janela de baixo uso).
-- BACKUP COMPLETO DO BANCO ANTES (export phpMyAdmin) + cópia do .env.
--
-- O que faz:
--   1. Alarga as 13 colunas sensíveis de VARCHAR → TEXT (o ciphertext AES-256-GCM
--      "enc:v1:..." é ~4/3× o plaintext + overhead e não caberia no VARCHAR).
--      FinTransacao é a maior tabela — o ALTER reconstrói a tabela, mais lento.
--   2. Cria a tabela FinAuditLog (trilha de auditoria; sem FK de propósito).
--
-- Idempotência: os ensureX() do boot (schema-evolution.js) reaplicam isto como
-- rede de segurança; rodar duas vezes não quebra (MODIFY p/ TEXT é no-op efetivo,
-- CREATE TABLE tem IF NOT EXISTS).
-- ============================================================================

-- 1) Colunas sensíveis → TEXT --------------------------------------------------

ALTER TABLE `FinTransacao`     MODIFY `descricao`     TEXT NULL;
ALTER TABLE `FinTransacao`     MODIFY `observacao`    TEXT NULL;

ALTER TABLE `FinContaPagar`    MODIFY `credor`        TEXT NOT NULL;
ALTER TABLE `FinContaPagar`    MODIFY `descricao`     TEXT NULL;

ALTER TABLE `FinContaReceber`  MODIFY `devedor_nome`  TEXT NOT NULL;
ALTER TABLE `FinContaReceber`  MODIFY `devedor_email` TEXT NULL;
ALTER TABLE `FinContaReceber`  MODIFY `descricao`     TEXT NULL;

ALTER TABLE `FinDividaPessoal` MODIFY `credor`        TEXT NOT NULL;
ALTER TABLE `FinDividaPessoal` MODIFY `descricao`     TEXT NULL;

ALTER TABLE `FinDividaEvento`  MODIFY `descricao`     TEXT NULL;

ALTER TABLE `Empresa`          MODIFY `cnpj`          TEXT NULL;
ALTER TABLE `Empresa`          MODIFY `email`         TEXT NULL;
ALTER TABLE `Empresa`          MODIFY `telefone`      TEXT NULL;

-- 2) Trilha de auditoria -------------------------------------------------------

CREATE TABLE IF NOT EXISTS `FinAuditLog` (
  `id`          VARCHAR(191) NOT NULL,
  `empresa_id`  VARCHAR(191) NULL,
  `user_id`     VARCHAR(191) NULL,
  `username`    VARCHAR(191) NULL,
  `role`        VARCHAR(32)  NULL,
  `action`      VARCHAR(40)  NOT NULL DEFAULT 'http',
  `method`      VARCHAR(8)   NOT NULL,
  `path`        VARCHAR(255) NOT NULL,
  `entity`      VARCHAR(64)  NULL,
  `entity_id`   VARCHAR(191) NULL,
  `status_code` SMALLINT     NULL,
  `ip`          VARCHAR(64)  NULL,
  `request_id`  VARCHAR(64)  NULL,
  `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `FinAuditLog_empresa_created_idx` (`empresa_id`, `created_at`),
  KEY `FinAuditLog_user_created_idx` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
