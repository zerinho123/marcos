-- Snapshot monetario imutavel por lancamento.
-- Executar com backup e validar /api/ready apos a migracao.

ALTER TABLE `FinTransacao`
  ADD COLUMN `moeda` VARCHAR(3) NULL AFTER `valor`,
  ADD COLUMN `moeda_base` VARCHAR(3) NULL AFTER `moeda`,
  ADD COLUMN `taxa_cambio` DECIMAL(18,8) NULL AFTER `moeda_base`,
  ADD COLUMN `valor_base` DECIMAL(15,2) NULL AFTER `taxa_cambio`,
  ADD COLUMN `cotacao_data` DATE NULL AFTER `valor_base`,
  ADD COLUMN `cotacao_fonte` VARCHAR(64) NULL AFTER `cotacao_data`,
  ADD COLUMN `cotacao_status` VARCHAR(24) NOT NULL DEFAULT 'legado_pendente' AFTER `cotacao_fonte`,
  ADD COLUMN `correcao_de_id` VARCHAR(191) NULL AFTER `origem_id`,
  ADD COLUMN `cancelado_em` DATETIME(3) NULL AFTER `correcao_de_id`,
  ADD COLUMN `cancelado_por` VARCHAR(191) NULL AFTER `cancelado_em`,
  ADD KEY `FinTransacao_correcao_idx` (`empresa_id`, `correcao_de_id`);

UPDATE `FinTransacao` t
JOIN `FinContaBancaria` cb
  ON cb.`id` = t.`conta_bancaria_id` AND cb.`empresa_id` = t.`empresa_id`
JOIN `Empresa` e ON e.`id` = t.`empresa_id`
SET t.`moeda` = COALESCE(t.`moeda`, cb.`moeda`, 'BRL'),
    t.`moeda_base` = COALESCE(t.`moeda_base`, e.`moeda_base`, 'BRL')
WHERE t.`moeda` IS NULL OR t.`moeda_base` IS NULL;

UPDATE `FinTransacao`
SET `taxa_cambio` = 1,
    `valor_base` = `valor`,
    `cotacao_data` = `data`,
    `cotacao_fonte` = 'Conversao direta',
    `cotacao_status` = 'mesma_moeda'
WHERE `moeda` = `moeda_base` AND `valor_base` IS NULL;

UPDATE `FinTransacao`
SET `cotacao_status` = 'legado_pendente'
WHERE `moeda` <> `moeda_base` AND `valor_base` IS NULL;
