-- ============================================================================
-- 20260618_contas_escopo.sql
-- Separa contas bancarias por workspace (pessoal x empresarial).
-- Rodar no phpMyAdmin do banco do Finance ANTES de subir o backend novo.
-- Seguro/idempotente: contas existentes herdam escopo='pessoal'.
-- ============================================================================

-- 1) Coluna de escopo (pessoal | empresarial)
ALTER TABLE `FinContaBancaria`
  ADD COLUMN `escopo` VARCHAR(16) NOT NULL DEFAULT 'pessoal' AFTER `empresa_id`;

-- 2) (opcional) restringir valores — descomente se quiser o CHECK
-- ALTER TABLE `FinContaBancaria`
--   ADD CONSTRAINT `FinContaBancaria_escopo_check`
--   CHECK (`escopo` IN ('pessoal','empresarial'));

-- 3) (opcional) indexar para filtros por empresa+escopo
-- ALTER TABLE `FinContaBancaria`
--   ADD KEY `FinContaBancaria_empresa_escopo_idx` (`empresa_id`, `escopo`);
