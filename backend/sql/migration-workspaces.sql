-- ============================================================================
-- Migração: adiciona coluna workspaces em FinanceUser
-- Execute no phpMyAdmin em: u107090545_Apifinanceiro_Mb
-- ============================================================================

ALTER TABLE `FinanceUser`
  ADD COLUMN `workspaces` VARCHAR(20) NOT NULL DEFAULT 'ambos' AFTER `role`;

ALTER TABLE `FinanceUser`
  ADD CONSTRAINT `FinanceUser_workspaces_chk` CHECK (`workspaces` IN ('pessoal','empresarial','ambos'));
