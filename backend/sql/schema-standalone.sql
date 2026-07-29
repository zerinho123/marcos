-- ============================================================================
-- CF Finance — schema standalone (banco separado do CRM)
-- Execute no phpMyAdmin em: u107090545_Apifinanceiro_Mb
-- ============================================================================
-- Diferenças em relação ao schema do CRM:
--   - Inclui tabela Empresa simplificada (sem depender do CRM)
--   - Remove FK para Lead (crm_lead_id é apenas referência textual)
--   - Remove FK para Empresa nas tabelas Fin* (sem CASCADE cross-service)
--     mas mantém empresa_id como chave de tenant
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================================
-- 1) Empresa (simplificada — apenas para tenant lookup)
-- ============================================================================
CREATE TABLE IF NOT EXISTS `Empresa` (
  `id`        VARCHAR(191) NOT NULL,
  `nome`      VARCHAR(255) NOT NULL,
  `cnpj`      TEXT NULL, -- cifrado em repouso (enc:v1:...)
  `email`     TEXT NULL, -- cifrado em repouso
  `telefone`  TEXT NULL, -- cifrado em repouso
  `moeda_base` VARCHAR(3) NOT NULL DEFAULT 'BRL', -- moeda de consolidação (ISO 4217)
  `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 2) FinanceUser
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinanceUser` (
  `id`                     VARCHAR(191) NOT NULL,
  `username`               VARCHAR(191) NOT NULL,
  `password`               VARCHAR(255) NOT NULL,
  `nome`                   VARCHAR(191) NOT NULL,
  `email`                  TEXT NULL,
  `telefone`               TEXT NULL,
  `documento`              TEXT NULL,
  `empresa_solicitada`     TEXT NULL,
  `plano`                  VARCHAR(120) NULL,
  `role`                   VARCHAR(32)  NOT NULL DEFAULT 'usuario',
  `status`                 VARCHAR(16)  NOT NULL DEFAULT 'aprovado',
  `aprovado_por`           VARCHAR(191) NULL,
  `aprovado_em`            DATETIME(3) NULL,
  `pagamento_status`       VARCHAR(16) NOT NULL DEFAULT 'pendente',
  `pagamento_por`          VARCHAR(191) NULL,
  `pagamento_em`           DATETIME(3) NULL,
  `workspaces`             VARCHAR(20)  NOT NULL DEFAULT 'ambos',
  `access_level`           VARCHAR(20)  NOT NULL DEFAULT 'operacao',
  `empresa_id`             VARCHAR(191) NULL,
  `mfa_enabled`            TINYINT(1)   NOT NULL DEFAULT 0,
  `last_login_at`          DATETIME(3)  NULL,
  `password_changed_at`    DATETIME(3)  NULL,
  `force_password_change`  TINYINT(1)   NOT NULL DEFAULT 0,
  `locked_until`           DATETIME(3)  NULL,
  `failed_login_attempts`  INT NOT NULL DEFAULT 0,
  `session_version`        INT NOT NULL DEFAULT 0,
  `deleted_at`             DATETIME(3) NULL,
  `createdAt`              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `FinanceUser_username_key` (`username`),
  KEY `FinanceUser_empresa_id_idx` (`empresa_id`),
  KEY `FinanceUser_deleted_at_idx` (`deleted_at`),
  CONSTRAINT `FinanceUser_role_chk` CHECK (`role` IN ('dono','admin','usuario')),
  CONSTRAINT `FinanceUser_workspaces_chk` CHECK (`workspaces` IN ('pessoal','empresarial','ambos')),
  CONSTRAINT `FinanceUser_access_level_chk` CHECK (`access_level` IN ('consulta','operacao'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 3) FinCategoria
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinCategoria` (
  `id`         VARCHAR(191) NOT NULL,
  `empresa_id` VARCHAR(191) NOT NULL,
  `nome`       VARCHAR(120) NOT NULL,
  `tipo`       VARCHAR(16)  NOT NULL DEFAULT 'pessoal',
  `escopo`     VARCHAR(16)  NOT NULL DEFAULT 'pessoal',
  `natureza`             VARCHAR(16) NULL,
  `comportamento`        VARCHAR(16) NULL,
  `usar_no_dre`          TINYINT(1)  NOT NULL DEFAULT 1,
  `usar_na_precificacao` TINYINT(1)  NOT NULL DEFAULT 0,
  `dre_secao`  VARCHAR(32)  NULL,
  `dre_linha_id` VARCHAR(191) NULL,
  `icone`      VARCHAR(50)  NULL,
  `cor`        VARCHAR(16)  NULL,
  `ativo`      TINYINT(1)   NOT NULL DEFAULT 1,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `FinCategoria_empresa_nome_key` (`empresa_id`, `nome`),
  KEY `FinCategoria_empresa_idx` (`empresa_id`),
  KEY `FinCategoria_dre_secao_idx` (`empresa_id`, `dre_secao`),
  KEY `FinCategoria_dre_linha_idx` (`dre_linha_id`),
  CONSTRAINT `FinCategoria_tipo_check`
    CHECK (`tipo` IN ('pessoal','empresarial','ambos')),
  CONSTRAINT `FinCategoria_dre_secao_check`
    CHECK (`dre_secao` IS NULL OR `dre_secao` IN (
      'receita_bruta','deducoes','cmv','servicos_terceiros',
      'comerciais','operacionais_diretas','administrativas',
      'nao_operacionais','juros_emprestimos','ir'
    ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 4) FinCategoriaPessoal
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinCategoriaPessoal` (
  `id`         VARCHAR(191) NOT NULL,
  `empresa_id` VARCHAR(191) NOT NULL,
  `user_id`    VARCHAR(191) NULL,
  `nome`       VARCHAR(120) NOT NULL,
  `natureza`   VARCHAR(16)  NULL,
  `icone`      VARCHAR(50)  NULL,
  `cor`        VARCHAR(16)  NULL,
  `ativo`      TINYINT(1)   NOT NULL DEFAULT 1,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `FinCategoriaPessoal_empresa_user_nome_key` (`empresa_id`, `user_id`, `nome`),
  KEY `FinCategoriaPessoal_empresa_user_idx` (`empresa_id`, `user_id`, `ativo`),
  CONSTRAINT `FinCategoriaPessoal_natureza_check`
    CHECK (`natureza` IS NULL OR `natureza` IN ('receita','despesa'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 5) FinContaBancaria
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinContaBancaria` (
  `id`         VARCHAR(191)  NOT NULL,
  `empresa_id` VARCHAR(191)  NOT NULL,
  `escopo`     VARCHAR(16)   NOT NULL DEFAULT 'pessoal',
  `nome`       VARCHAR(120)  NOT NULL,
  `tipo`       VARCHAR(20)   NOT NULL,
  `moeda`      VARCHAR(3)    NOT NULL DEFAULT 'BRL', -- moeda da conta (ISO 4217)
  `saldo_inicial` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `saldo`      DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `cor`        VARCHAR(16)   NULL,
  `ativo`      TINYINT(1)    NOT NULL DEFAULT 1,
  `createdAt`  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `FinContaBancaria_empresa_idx` (`empresa_id`),
  CONSTRAINT `FinContaBancaria_tipo_check`
    CHECK (`tipo` IN ('corrente','poupanca','carteira','investimento','outro')),
  CONSTRAINT `FinContaBancaria_escopo_check`
    CHECK (`escopo` IN ('pessoal','empresarial'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 6) FinTransacao
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinTransacao` (
  `id`                VARCHAR(191)  NOT NULL,
  `empresa_id`        VARCHAR(191)  NOT NULL,
  `tipo`              VARCHAR(16)   NOT NULL,
  `valor`             DECIMAL(15,2) NOT NULL,
  `moeda`             VARCHAR(3)    NULL,
  `moeda_base`        VARCHAR(3)    NULL,
  `taxa_cambio`       DECIMAL(18,8) NULL,
  `valor_base`        DECIMAL(15,2) NULL,
  `cotacao_data`      DATE          NULL,
  `cotacao_fonte`     VARCHAR(64)   NULL,
  `cotacao_status`    VARCHAR(24)   NOT NULL DEFAULT 'legado_pendente',
  `data`              DATE          NOT NULL,
  `descricao`         TEXT          NULL, -- cifrado em repouso (enc:v1:...)
  `categoria_id`      VARCHAR(191)  NULL,
  `categoria_pessoal_id` VARCHAR(191) NULL,
  `conta_bancaria_id` VARCHAR(191)  NULL,
  `escopo`            VARCHAR(16)   NOT NULL DEFAULT 'pessoal',
  `status`            VARCHAR(16)   NOT NULL DEFAULT 'pago',
  `origem`            VARCHAR(24)   NOT NULL DEFAULT 'lancamento_manual',
  `origem_id`         VARCHAR(191)  NULL,
  `correcao_de_id`    VARCHAR(191)  NULL,
  `cancelado_em`      DATETIME(3)   NULL,
  `cancelado_por`     VARCHAR(191)  NULL,
  `observacao`        TEXT          NULL, -- cifrado em repouso
  `ativo`             TINYINT(1)    NOT NULL DEFAULT 1,
  `createdAt`         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `FinTransacao_empresa_data_idx` (`empresa_id`, `data`),
  KEY `FinTransacao_empresa_ativo_data_idx` (`empresa_id`, `ativo`, `data`),
  KEY `FinTransacao_categoria_idx` (`categoria_id`),
  KEY `FinTransacao_categoria_pessoal_idx` (`categoria_pessoal_id`),
  KEY `FinTransacao_conta_idx` (`conta_bancaria_id`),
  KEY `FinTransacao_origem_idx` (`empresa_id`, `origem`, `origem_id`),
  KEY `FinTransacao_correcao_idx` (`empresa_id`, `correcao_de_id`),
  CONSTRAINT `FinTransacao_tipo_check` CHECK (`tipo` IN ('receita','despesa')),
  CONSTRAINT `FinTransacao_categoria_fk`
    FOREIGN KEY (`categoria_id`) REFERENCES `FinCategoria`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `FinTransacao_categoria_pessoal_fk`
    FOREIGN KEY (`categoria_pessoal_id`) REFERENCES `FinCategoriaPessoal`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `FinTransacao_conta_fk`
    FOREIGN KEY (`conta_bancaria_id`) REFERENCES `FinContaBancaria`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 6) FinOrcamento
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinOrcamento` (
  `id`           VARCHAR(191)  NOT NULL,
  `empresa_id`   VARCHAR(191)  NOT NULL,
  `categoria_id` VARCHAR(191)  NULL,
  `categoria_pessoal_id` VARCHAR(191) NULL,
  `escopo`       VARCHAR(16)   NOT NULL DEFAULT 'pessoal',
  `mes`          DATE          NOT NULL,
  `data_inicio`  DATE          NULL,
  `data_fim`     DATE          NULL,
  `limite`       DECIMAL(15,2) NOT NULL,
  `createdAt`    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `FinOrcamento_empresa_cat_mes_key` (`empresa_id`, `categoria_id`, `mes`),
  UNIQUE KEY `FinOrcamento_empresa_cat_pessoal_mes_key` (`empresa_id`, `categoria_pessoal_id`, `mes`),
  KEY `FinOrcamento_empresa_idx` (`empresa_id`),
  KEY `FinOrcamento_categoria_pessoal_idx` (`categoria_pessoal_id`),
  CONSTRAINT `FinOrcamento_categoria_fk`
    FOREIGN KEY (`categoria_id`) REFERENCES `FinCategoria`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FinOrcamento_categoria_pessoal_fk`
    FOREIGN KEY (`categoria_pessoal_id`) REFERENCES `FinCategoriaPessoal`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 7) FinMeta
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinMeta` (
  `id`          VARCHAR(191)  NOT NULL,
  `empresa_id`  VARCHAR(191)  NOT NULL,
  `nome`        VARCHAR(150)  NOT NULL,
  `valor_alvo`  DECIMAL(15,2) NOT NULL,
  `valor_atual` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `escopo`      VARCHAR(16)   NOT NULL DEFAULT 'pessoal',
  `prazo`       DATE          NULL,
  `status`      VARCHAR(20)   NOT NULL DEFAULT 'ativa',
  `createdAt`   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `FinMeta_empresa_idx` (`empresa_id`),
  CONSTRAINT `FinMeta_status_check`
    CHECK (`status` IN ('ativa','concluida','cancelada'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 8) FinContaPagar
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinContaPagar` (
  `id`             VARCHAR(191)  NOT NULL,
  `empresa_id`     VARCHAR(191)  NOT NULL,
  `credor`         TEXT          NOT NULL, -- cifrado em repouso (enc:v1:...)
  `valor`          DECIMAL(15,2) NOT NULL,
  `vencimento`     DATE          NOT NULL,
  `categoria_id`   VARCHAR(191)  NULL,
  `conta_bancaria_id` VARCHAR(191) NULL,
  `lancamento_id`  VARCHAR(191)  NULL,
  `escopo`         VARCHAR(16)   NOT NULL DEFAULT 'empresarial',
  `status`         VARCHAR(20)   NOT NULL DEFAULT 'pendente',
  `valor_pago`     DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `data_pagamento` DATE          NULL,
  `descricao`      TEXT          NULL, -- cifrado em repouso
  `createdAt`      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `FinContaPagar_empresa_status_idx` (`empresa_id`, `status`),
  KEY `FinContaPagar_empresa_venc_idx`   (`empresa_id`, `vencimento`),
  KEY `FinContaPagar_categoria_idx`      (`categoria_id`),
  KEY `FinContaPagar_conta_idx`          (`conta_bancaria_id`),
  KEY `FinContaPagar_lancamento_idx`     (`lancamento_id`),
  CONSTRAINT `FinContaPagar_status_check`
    CHECK (`status` IN ('pendente','pago','parcial','vencido')),
  CONSTRAINT `FinContaPagar_categoria_fk`
    FOREIGN KEY (`categoria_id`) REFERENCES `FinCategoria`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `FinContaPagar_conta_fk`
    FOREIGN KEY (`conta_bancaria_id`) REFERENCES `FinContaBancaria`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `FinContaPagar_lancamento_fk`
    FOREIGN KEY (`lancamento_id`) REFERENCES `FinTransacao`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 9) FinContaReceber
--    crm_lead_id: referência textual ao Lead do CRM (sem FK cross-db)
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinContaReceber` (
  `id`               VARCHAR(191)  NOT NULL,
  `empresa_id`       VARCHAR(191)  NOT NULL,
  `devedor_nome`     TEXT          NOT NULL, -- cifrado em repouso (enc:v1:...)
  `devedor_email`    TEXT          NULL,     -- cifrado em repouso
  `valor`            DECIMAL(15,2) NOT NULL,
  `vencimento`       DATE          NOT NULL,
  `categoria_id`     VARCHAR(191)  NULL,
  `conta_bancaria_id` VARCHAR(191) NULL,
  `lancamento_id`    VARCHAR(191)  NULL,
  `escopo`           VARCHAR(16)   NOT NULL DEFAULT 'empresarial',
  `status`           VARCHAR(20)   NOT NULL DEFAULT 'pendente',
  `valor_pago`       DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `data_recebimento` DATE          NULL,
  `origem`           VARCHAR(16)   NOT NULL DEFAULT 'manual',
  `crm_lead_id`      VARCHAR(191)  NULL,
  `descricao`        TEXT          NULL, -- cifrado em repouso
  `createdAt`        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `FinContaReceber_crm_lead_key` (`empresa_id`, `crm_lead_id`),
  KEY `FinContaReceber_empresa_status_idx` (`empresa_id`, `status`),
  KEY `FinContaReceber_empresa_venc_idx`   (`empresa_id`, `vencimento`),
  KEY `FinContaReceber_categoria_idx`      (`categoria_id`),
  KEY `FinContaReceber_conta_idx`          (`conta_bancaria_id`),
  KEY `FinContaReceber_lancamento_idx`     (`lancamento_id`),
  CONSTRAINT `FinContaReceber_status_check`
    CHECK (`status` IN ('pendente','pago','parcial','vencido')),
  CONSTRAINT `FinContaReceber_origem_check`
    CHECK (`origem` IN ('manual','crm')),
  CONSTRAINT `FinContaReceber_categoria_fk`
    FOREIGN KEY (`categoria_id`) REFERENCES `FinCategoria`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `FinContaReceber_conta_fk`
    FOREIGN KEY (`conta_bancaria_id`) REFERENCES `FinContaBancaria`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `FinContaReceber_lancamento_fk`
    FOREIGN KEY (`lancamento_id`) REFERENCES `FinTransacao`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 10) FinDividaPessoal + FinDividaEvento
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinDividaPessoal` (
  `id`              VARCHAR(191)  NOT NULL,
  `empresa_id`      VARCHAR(191)  NOT NULL,
  `credor`          TEXT          NOT NULL, -- cifrado em repouso (enc:v1:...)
  `tipo`            VARCHAR(32)   NOT NULL,
  `valor_original`  DECIMAL(15,2) NOT NULL,
  `saldo_devedor`   DECIMAL(15,2) NOT NULL,
  `data_inicio`     DATE          NOT NULL,
  `data_vencimento` DATE          NULL,
  `taxa_juros`      DECIMAL(8,4)  NULL,
  `status`          VARCHAR(20)   NOT NULL DEFAULT 'ativa',
  `escopo`          VARCHAR(16)   NOT NULL DEFAULT 'pessoal',
  `descricao`       TEXT          NULL, -- cifrado em repouso
  `createdAt`       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `FinDividaPessoal_empresa_status_idx` (`empresa_id`, `status`),
  CONSTRAINT `FinDividaPessoal_tipo_check`
    CHECK (`tipo` IN ('cartao_credito','emprestimo','financiamento','cheque_especial','outro')),
  CONSTRAINT `FinDividaPessoal_status_check`
    CHECK (`status` IN ('ativa','em_negociacao','renegociada','quitada'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `FinDividaEvento` (
  `id`         VARCHAR(191)  NOT NULL,
  `divida_id`  VARCHAR(191)  NOT NULL,
  `empresa_id` VARCHAR(191)  NOT NULL,
  `data`       DATE          NOT NULL,
  `tipo`       VARCHAR(32)   NOT NULL,
  `valor`      DECIMAL(15,2) NULL,
  `escopo`     VARCHAR(16)   NOT NULL DEFAULT 'pessoal',
  `descricao`  TEXT          NULL, -- cifrado em repouso
  `createdAt`  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `FinDividaEvento_divida_idx` (`divida_id`),
  KEY `FinDividaEvento_empresa_data_idx` (`empresa_id`, `data`),
  CONSTRAINT `FinDividaEvento_tipo_check`
    CHECK (`tipo` IN ('pagamento','renegociacao','nota','juros_aplicados')),
  CONSTRAINT `FinDividaEvento_divida_fk`
    FOREIGN KEY (`divida_id`) REFERENCES `FinDividaPessoal`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 11) FinInvestimento + FinAporteInvestimento + FinInvestimentoCotacao
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinInvestimento` (
  `id`                 VARCHAR(191)  NOT NULL,
  `empresa_id`         VARCHAR(191)  NOT NULL,
  `nome`               VARCHAR(150)  NOT NULL,
  `ticker`             VARCHAR(20)   NULL,
  `tipo`               VARCHAR(20)   NOT NULL,
  `corretora`          VARCHAR(100)  NULL,
  `valor_atual_manual` DECIMAL(15,2) NULL,
  `ativo`              TINYINT(1)    NOT NULL DEFAULT 1,
  `createdAt`          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `FinInvestimento_empresa_idx` (`empresa_id`),
  KEY `FinInvestimento_ticker_idx` (`ticker`),
  CONSTRAINT `FinInvestimento_tipo_check`
    CHECK (`tipo` IN ('renda_fixa','acao','fii','cripto','outro'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `FinAporteInvestimento` (
  `id`              VARCHAR(191)   NOT NULL,
  `investimento_id` VARCHAR(191)   NOT NULL,
  `empresa_id`      VARCHAR(191)   NOT NULL,
  `data`            DATE           NOT NULL,
  `tipo`            VARCHAR(16)    NOT NULL,
  `quantidade`      DECIMAL(20,8)  NOT NULL,
  `preco_unitario`  DECIMAL(15,6)  NOT NULL,
  `total`           DECIMAL(15,2)  AS (ROUND(`quantidade` * `preco_unitario`, 2)) STORED,
  `createdAt`       DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `FinAporteInvestimento_inv_idx` (`investimento_id`),
  KEY `FinAporteInvestimento_empresa_data_idx` (`empresa_id`, `data`),
  CONSTRAINT `FinAporteInvestimento_tipo_check`
    CHECK (`tipo` IN ('compra','venda')),
  CONSTRAINT `FinAporteInvestimento_inv_fk`
    FOREIGN KEY (`investimento_id`) REFERENCES `FinInvestimento`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `FinInvestimentoCotacao` (
  `ticker`        VARCHAR(20)   NOT NULL,
  `valor_atual`   DECIMAL(15,6) NOT NULL,
  `variacao_dia`  DECIMAL(8,4)  NULL,
  `atualizado_em` DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`ticker`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 12) FinDrePlanoReceita
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinDrePlanoReceita` (
  `empresa_id` VARCHAR(191)  NOT NULL,
  `mes`        DATE          NOT NULL,
  `valor`      DECIMAL(15,2) NOT NULL,
  `updatedAt`  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`empresa_id`, `mes`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 12b) FinDreLinha — linhas de detalhe editáveis do DRE (data-driven)
-- ============================================================================
-- user_id '' = template da empresa; qualquer outro = DRE pessoal daquele admin.
CREATE TABLE IF NOT EXISTS `FinDreLinha` (
  `id`         VARCHAR(191) NOT NULL,
  `empresa_id` VARCHAR(191) NOT NULL,
  `user_id`    VARCHAR(191) NOT NULL DEFAULT '',
  `secao`      VARCHAR(32)  NOT NULL,
  `nome`       VARCHAR(191) NOT NULL,
  `ordem`      INT          NOT NULL DEFAULT 0,
  `ativo`      TINYINT(1)   NOT NULL DEFAULT 1,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `FinDreLinha_empresa_secao_idx` (`empresa_id`, `secao`, `ordem`),
  KEY `FinDreLinha_empresa_user_secao_idx` (`empresa_id`, `user_id`, `secao`, `ordem`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 12c) FinDreMeta — projetado/meta por linha e mês
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinDreMeta` (
  `empresa_id`  VARCHAR(191)  NOT NULL,
  `user_id`     VARCHAR(191)  NOT NULL DEFAULT '',
  `linha_id`    VARCHAR(191)  NOT NULL,
  `mes`         DATE          NOT NULL,
  `valor`       DECIMAL(15,2) NOT NULL DEFAULT 0,
  `ajuste_real` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `updated_by`  VARCHAR(191)  NULL,
  `updatedAt`   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`empresa_id`, `linha_id`, `mes`),
  KEY `FinDreMeta_linha_idx` (`linha_id`),
  CONSTRAINT `FinDreMeta_linha_fk`
    FOREIGN KEY (`linha_id`) REFERENCES `FinDreLinha`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mapa categoria → linha do DRE (FK adicionada após FinDreLinha existir).
ALTER TABLE `FinCategoria`
  ADD CONSTRAINT `FinCategoria_dre_linha_fk`
  FOREIGN KEY (`dre_linha_id`) REFERENCES `FinDreLinha`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 12d) FinDreUserMapa — mapa categoria→linha por escopo (user_id '' = template)
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinDreUserMapa` (
  `empresa_id`   VARCHAR(191) NOT NULL,
  `user_id`      VARCHAR(191) NOT NULL DEFAULT '',
  `categoria_id` VARCHAR(191) NOT NULL,
  `linha_id`     VARCHAR(191) NOT NULL,
  `updatedAt`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`empresa_id`, `user_id`, `categoria_id`),
  KEY `FinDreUserMapa_linha_idx` (`linha_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 12e) FinDreUserConfig — layout do DRE por escopo (colunas/ordem em JSON)
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinDreUserConfig` (
  `empresa_id` VARCHAR(191) NOT NULL,
  `user_id`    VARCHAR(191) NOT NULL DEFAULT '',
  `config`     LONGTEXT     NOT NULL,
  `updatedAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`empresa_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 12e2) FinDashboardUserConfig — preferência de período do dashboard por escopo
--       config JSON: { tipo:'mes'|'custom', dataInicio:'YYYY-MM-DD', dataFim:'YYYY-MM-DD' }
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinDashboardUserConfig` (
  `empresa_id` VARCHAR(191) NOT NULL,
  `user_id`    VARCHAR(191) NOT NULL DEFAULT '',
  `escopo`     VARCHAR(16)  NOT NULL DEFAULT 'empresarial',
  `config`     LONGTEXT     NOT NULL,
  `updatedAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`empresa_id`, `user_id`, `escopo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 12e3) FinCambioCache — cotações de câmbio em cache (par ex.: 'USDBRL')
--       Fonte: frankfurter.app (sem key). taxa = 1 unidade da moeda origem em
--       moeda destino. Uma linha por (par, data) → permite consolidação por data.
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinCambioCache` (
  `par`       VARCHAR(7)     NOT NULL, -- <origem><destino>, ex.: 'USDBRL'
  `data`      DATE           NOT NULL,
  `taxa`      DECIMAL(18,8)  NOT NULL,
  `updatedAt` DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`par`, `data`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 12f) FinDreFormula — linhas de total com fórmula editável por escopo (Fase 2)
--      formula = JSON { terms: [ {op, ref:'sec:<secao>'|'row:<chave>'} | {op, value} ] }
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinDreFormula` (
  `id`         VARCHAR(191) NOT NULL,
  `empresa_id` VARCHAR(191) NOT NULL,
  `user_id`    VARCHAR(191) NOT NULL DEFAULT '',
  `chave`      VARCHAR(64)  NOT NULL,
  `nome`       VARCHAR(191) NOT NULL,
  `formula`    LONGTEXT     NOT NULL,
  `formato`    VARCHAR(16)  NOT NULL DEFAULT 'currency',
  `oculto`     TINYINT(1)   NOT NULL DEFAULT 0,
  `ordem`      INT          NOT NULL DEFAULT 0,
  `ativo`      TINYINT(1)   NOT NULL DEFAULT 1,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `FinDreFormula_escopo_chave` (`empresa_id`, `user_id`, `chave`),
  KEY `FinDreFormula_escopo_ordem` (`empresa_id`, `user_id`, `ordem`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 13) Precificacao empresarial
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinPrecificacaoConfig` (
  `empresa_id` VARCHAR(191) NOT NULL, `impostos_pct` DECIMAL(9,4) NOT NULL DEFAULT 0,
  `comissao_pct` DECIMAL(9,4) NOT NULL DEFAULT 0, `despesas_variaveis_pct` DECIMAL(9,4) NOT NULL DEFAULT 0,
  `margem_padrao_pct` DECIMAL(9,4) NOT NULL DEFAULT 20, `rateio_tipo` VARCHAR(16) NOT NULL DEFAULT 'percentual',
  `rateio_valor` DECIMAL(15,6) NOT NULL DEFAULT 0, `updated_by` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`empresa_id`),
  CONSTRAINT `FinPrecificacaoConfig_rateio_chk` CHECK (`rateio_tipo` IN ('percentual','fixo'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `FinPrecificacaoCategoria` (
  `id` VARCHAR(191) NOT NULL, `empresa_id` VARCHAR(191) NOT NULL, `nome` VARCHAR(120) NOT NULL,
  `ativo` TINYINT(1) NOT NULL DEFAULT 1, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE KEY `FinPrecificacaoCategoria_empresa_nome_key` (`empresa_id`,`nome`),
  KEY `FinPrecificacaoCategoria_empresa_idx` (`empresa_id`,`ativo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `FinPrecificacaoFuncao` (
  `id` VARCHAR(191) NOT NULL, `empresa_id` VARCHAR(191) NOT NULL, `nome` VARCHAR(120) NOT NULL,
  `custo_hora` DECIMAL(15,6) NOT NULL DEFAULT 0, `ativo` TINYINT(1) NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE KEY `FinPrecificacaoFuncao_empresa_nome_key` (`empresa_id`,`nome`),
  KEY `FinPrecificacaoFuncao_empresa_idx` (`empresa_id`,`ativo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `FinPrecificacaoItem` (
  `id` VARCHAR(191) NOT NULL, `empresa_id` VARCHAR(191) NOT NULL, `categoria_id` VARCHAR(191) NULL,
  `tipo` VARCHAR(16) NOT NULL, `nome` VARCHAR(191) NOT NULL, `codigo` VARCHAR(80) NULL,
  `unidade` VARCHAR(40) NOT NULL DEFAULT 'unidade', `descricao` TEXT NULL, `ativo` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE KEY `FinPrecificacaoItem_empresa_nome_key` (`empresa_id`,`nome`),
  UNIQUE KEY `FinPrecificacaoItem_empresa_codigo_key` (`empresa_id`,`codigo`),
  KEY `FinPrecificacaoItem_empresa_idx` (`empresa_id`,`ativo`,`tipo`), KEY `FinPrecificacaoItem_categoria_idx` (`categoria_id`),
  CONSTRAINT `FinPrecificacaoItem_tipo_chk` CHECK (`tipo` IN ('produto','servico')),
  CONSTRAINT `FinPrecificacaoItem_categoria_fk` FOREIGN KEY (`categoria_id`) REFERENCES `FinPrecificacaoCategoria`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `FinPrecificacaoVersao` (
  `id` VARCHAR(191) NOT NULL, `empresa_id` VARCHAR(191) NOT NULL, `item_id` VARCHAR(191) NOT NULL,
  `numero` INT NOT NULL, `status` VARCHAR(16) NOT NULL DEFAULT 'rascunho', `vigencia_inicio` DATETIME(3) NULL,
  `impostos_pct` DECIMAL(9,4) NOT NULL DEFAULT 0, `comissao_pct` DECIMAL(9,4) NOT NULL DEFAULT 0,
  `despesas_variaveis_pct` DECIMAL(9,4) NOT NULL DEFAULT 0, `margem_padrao_pct` DECIMAL(9,4) NOT NULL DEFAULT 20,
  `rateio_tipo` VARCHAR(16) NOT NULL DEFAULT 'percentual', `rateio_valor` DECIMAL(15,6) NOT NULL DEFAULT 0,
  `custo_direto` DECIMAL(18,6) NULL, `created_by` VARCHAR(191) NULL, `published_by` VARCHAR(191) NULL,
  `published_at` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE KEY `FinPrecificacaoVersao_item_numero_key` (`item_id`,`numero`),
  KEY `FinPrecificacaoVersao_empresa_item_idx` (`empresa_id`,`item_id`,`status`,`vigencia_inicio`),
  CONSTRAINT `FinPrecificacaoVersao_status_chk` CHECK (`status` IN ('rascunho','publicada','cancelada')),
  CONSTRAINT `FinPrecificacaoVersao_rateio_chk` CHECK (`rateio_tipo` IN ('percentual','fixo')),
  CONSTRAINT `FinPrecificacaoVersao_item_fk` FOREIGN KEY (`item_id`) REFERENCES `FinPrecificacaoItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `FinPrecificacaoComponente` (
  `id` VARCHAR(191) NOT NULL, `empresa_id` VARCHAR(191) NOT NULL, `versao_id` VARCHAR(191) NOT NULL,
  `funcao_id` VARCHAR(191) NULL, `tipo` VARCHAR(24) NOT NULL, `nome` VARCHAR(191) NOT NULL,
  `unidade` VARCHAR(40) NOT NULL, `quantidade` DECIMAL(18,6) NOT NULL, `custo_unitario` DECIMAL(18,6) NOT NULL,
  `perda_pct` DECIMAL(9,4) NOT NULL DEFAULT 0, `custo_total` DECIMAL(18,6) NOT NULL, `ordem` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`), KEY `FinPrecificacaoComponente_versao_idx` (`versao_id`,`ordem`),
  KEY `FinPrecificacaoComponente_empresa_idx` (`empresa_id`),
  CONSTRAINT `FinPrecificacaoComponente_versao_fk` FOREIGN KEY (`versao_id`) REFERENCES `FinPrecificacaoVersao`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FinPrecificacaoComponente_funcao_fk` FOREIGN KEY (`funcao_id`) REFERENCES `FinPrecificacaoFuncao`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `FinPrecificacaoFaixa` (
  `id` VARCHAR(191) NOT NULL, `empresa_id` VARCHAR(191) NOT NULL, `versao_id` VARCHAR(191) NOT NULL,
  `quantidade_min` INT NOT NULL, `quantidade_max` INT NULL, `custo_ajuste_pct` DECIMAL(9,4) NOT NULL DEFAULT 0,
  `margem_alvo_pct` DECIMAL(9,4) NOT NULL, `custo_direto_ajustado` DECIMAL(18,6) NOT NULL,
  `rateio` DECIMAL(18,6) NOT NULL, `custo_base` DECIMAL(18,6) NOT NULL,
  `preco_minimo` DECIMAL(15,2) NOT NULL, `preco_sugerido` DECIMAL(15,2) NOT NULL,
  `margem_resultante_pct` DECIMAL(9,4) NOT NULL, `ordem` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`), UNIQUE KEY `FinPrecificacaoFaixa_versao_min_key` (`versao_id`,`quantidade_min`),
  KEY `FinPrecificacaoFaixa_empresa_idx` (`empresa_id`),
  CONSTRAINT `FinPrecificacaoFaixa_versao_fk` FOREIGN KEY (`versao_id`) REFERENCES `FinPrecificacaoVersao`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 14) Tokens de integração
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinanceWebhookToken` (
  `id`          VARCHAR(191) NOT NULL,
  `empresa_id`  VARCHAR(191) NOT NULL,
  `token`       VARCHAR(191) NOT NULL,
  `ativo`       TINYINT(1)   NOT NULL DEFAULT 1,
  `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_used_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `FinanceWebhookToken_token_unique` (`token`),
  UNIQUE KEY `FinanceWebhookToken_empresa_unique` (`empresa_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `FinanceEmbedToken` (
  `id`          VARCHAR(191) NOT NULL,
  `empresa_id`  VARCHAR(191) NOT NULL,
  `tipo`        VARCHAR(32)  NOT NULL DEFAULT 'dre',
  `token`       VARCHAR(191) NOT NULL,
  `ativo`       TINYINT(1)   NOT NULL DEFAULT 1,
  `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_used_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `FinanceEmbedToken_token_unique` (`token`),
  UNIQUE KEY `FinanceEmbedToken_empresa_tipo_unique` (`empresa_id`, `tipo`),
  CONSTRAINT `FinanceEmbedToken_tipo_check`
    CHECK (`tipo` IN ('dre','fluxo','dashboard'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- FinAuditLog — trilha de auditoria (hardening 2026-07-07)
-- Sem FK de propósito: o log sobrevive à deleção de usuários/empresas.
-- Metadados apenas — corpo de request NUNCA é gravado aqui.
-- ============================================================================
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

-- ============================================================================
-- FinLixeira — lixeira universal (v87)
-- Sem FK de proposito: precisa sobreviver a exclusao do usuario/empresa que
-- ela documenta. `snapshot` guarda o JSON da linha como estava no banco
-- (campos cifrados permanecem cifrados); `rotulo` e cifrado antes de gravar.
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinLixeira` (
  `id`                 VARCHAR(191) NOT NULL,
  `grupo_id`           VARCHAR(191) NOT NULL,
  `entidade`           VARCHAR(40)  NOT NULL,
  `entidade_id`        VARCHAR(191) NOT NULL,
  `empresa_id`         VARCHAR(191) NULL,
  `escopo`             VARCHAR(16)  NULL,
  `estrategia`         VARCHAR(16)  NOT NULL,
  `snapshot`           LONGTEXT     NULL,
  `rotulo`             TEXT         NULL,
  `valor`              DECIMAL(15,2) NULL,
  `excluido_por`       VARCHAR(191) NULL,
  `excluido_por_nome`  VARCHAR(191) NULL,
  `excluido_em`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `restaurado_em`      DATETIME(3)  NULL,
  `restaurado_por`     VARCHAR(191) NULL,
  `purgado_em`         DATETIME(3)  NULL,
  PRIMARY KEY (`id`),
  KEY `FinLixeira_empresa_idx` (`empresa_id`, `escopo`, `excluido_em`),
  KEY `FinLixeira_grupo_idx` (`grupo_id`),
  KEY `FinLixeira_entidade_idx` (`entidade`, `entidade_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- FinanceDelegacao — gestor comanda N contas pessoais de terceiros (v87)
-- ============================================================================
CREATE TABLE IF NOT EXISTS `FinanceDelegacao` (
  `id`             VARCHAR(191) NOT NULL,
  `gestor_id`      VARCHAR(191) NOT NULL,
  `usuario_id`     VARCHAR(191) NOT NULL,
  `permissao`      ENUM('visualizar','operar') NOT NULL DEFAULT 'visualizar',
  `ativo`          TINYINT(1)   NOT NULL DEFAULT 1,
  `concedido_por`  VARCHAR(191) NULL,
  `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `FinanceDelegacao_par_key` (`gestor_id`, `usuario_id`),
  KEY `FinanceDelegacao_gestor_idx` (`gestor_id`, `ativo`),
  CONSTRAINT `FinanceDelegacao_gestor_fk`  FOREIGN KEY (`gestor_id`)  REFERENCES `FinanceUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FinanceDelegacao_usuario_fk` FOREIGN KEY (`usuario_id`) REFERENCES `FinanceUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- SEED: empresa e admin inicial
-- ============================================================================
-- Substitua os valores abaixo antes de executar.
-- Senha gerada com: bcrypt("suaSenhaAqui", 12)
-- Use https://bcrypt.online/ ou: node -e "require('bcryptjs').hash('senha',12).then(console.log)"
-- ============================================================================

-- INSERT INTO `Empresa` (`id`, `nome`) VALUES ('empresa-1', 'CF Mentoria');

-- INSERT INTO `FinanceUser`
--   (`id`, `username`, `password`, `nome`, `role`, `empresa_id`, `createdAt`, `updatedAt`)
-- VALUES (
--   'admin-1',
--   'admin',
--   '$2b$12$HASH_GERADO_AQUI',
--   'Administrador',
--   'admin',
--   'empresa-1',
--   NOW(3), NOW(3)
-- );
