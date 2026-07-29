-- ============================================================================
-- 007_relatorio_pessoal_multiusuario.sql
-- ----------------------------------------------------------------------------
-- SO LEITURA. Nao roda automatico em lugar nenhum, nao faz parte do boot.
--
-- ensureFinancePessoalBackfill() (backend/schema-evolution.js) move dado
-- escopo='pessoal' pra empresa pessoal sintetica do dono, mas so quando o
-- dono e inequivoco: categoria com `user_id` explicito, ou empresa 'normal'
-- com EXATAMENTE 1 usuario vinculado ativo. Empresa com mais de 1 usuario
-- fica de fora de proposito — nao ha como adivinhar de quem e cada
-- lancamento sem dono explicito.
--
-- Esta query lista essas empresas (o caso ambiguo) pra decisao manual:
-- cada linha e uma empresa 'normal' com >1 usuario vinculado que ainda tem
-- dado escopo='pessoal' preso nela. Rodar DEPOIS do backfill automatico
-- (Fase 4, passo 4) pra ver o que sobrou.
-- ============================================================================

-- 1) Empresas 'normal' com mais de 1 usuario vinculado ativo (o universo
--    ambiguo — o backfill automatico nunca mexe nelas).
SELECT
  e.`id`                                   AS empresa_id,
  e.`nome`                                 AS empresa_nome,
  COUNT(DISTINCT fue.`user_id`)            AS usuarios_vinculados,
  GROUP_CONCAT(DISTINCT fu.`nome` SEPARATOR ', ') AS usuarios_nomes
FROM `Empresa` e
JOIN `FinanceUserEmpresa` fue ON fue.`empresa_id` = e.`id` AND fue.`ativo` = 1
JOIN `FinanceUser` fu ON fu.`id` = fue.`user_id` AND fu.`deleted_at` IS NULL
WHERE e.`tipo` = 'normal'
GROUP BY e.`id`, e.`nome`
HAVING COUNT(DISTINCT fue.`user_id`) > 1
ORDER BY e.`nome`;

-- 2) Dado escopo='pessoal' ainda preso nessas empresas, por tabela — o que
--    de fato precisa de uma decisao manual de "de quem e isso" antes de
--    mover pra empresa pessoal do dono certo. Rodar filtrando por um
--    empresa_id da lista acima.
-- Troque `?` pelo empresa_id que voce esta revisando.

SELECT 'FinContaBancaria' AS tabela, id, nome AS descricao, `escopo`
  FROM `FinContaBancaria` WHERE `empresa_id` = ? AND `escopo` = 'pessoal'
UNION ALL
SELECT 'FinTransacao', id, descricao, `escopo`
  FROM `FinTransacao` WHERE `empresa_id` = ? AND `escopo` = 'pessoal'
UNION ALL
SELECT 'FinOrcamento', id, CAST(`mes` AS CHAR), `escopo`
  FROM `FinOrcamento` WHERE `empresa_id` = ? AND `escopo` = 'pessoal'
UNION ALL
SELECT 'FinMeta', id, nome, `escopo`
  FROM `FinMeta` WHERE `empresa_id` = ? AND `escopo` = 'pessoal'
UNION ALL
SELECT 'FinCategoria', id, nome, `escopo`
  FROM `FinCategoria` WHERE `empresa_id` = ? AND `escopo` = 'pessoal' AND `user_id` IS NULL
UNION ALL
SELECT 'FinDividaPessoal', id, descricao, `escopo`
  FROM `FinDividaPessoal` WHERE `empresa_id` = ? AND `escopo` = 'pessoal';

-- Decisao manual, por linha: identificar o dono real (ex.: por historico de
-- quem criou, se houver auditoria; ou perguntar ao cliente) e so entao mover
-- com um UPDATE pontual pra empresa pessoal desse usuario -- nunca em lote
-- automatico pra este grupo.
