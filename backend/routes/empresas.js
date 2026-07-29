// ============================================================================
// routes/empresas.js — CRUD de Empresa (cadastro multi-empresa)
// ----------------------------------------------------------------------------
// Leitura: qualquer usuario autenticado (necessario pro seletor de empresa).
// Escrita: admin only. Cadastro sem fricção — so `nome` e obrigatorio.
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne } from '../db.js';
import { wrap, requireFields, capText } from './_common.js';
import { ERR } from '../security/errors.js';
import { encryptField, decRows } from '../security/encryption.js';
import { MOEDAS_SUPORTADAS, isMoedaSuportada } from '../security/cambio.js';
import { novoGrupo, registrarExclusao, snapshotLinha } from './_lixeira.js';

function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Moeda-base da empresa (consolidação de relatórios). Ausente → null (mantém a
// atual no UPDATE / cai no DEFAULT 'BRL' no INSERT). Inválida → 400.
function parseMoedaBase(value) {
  if (value == null || value === '') return null;
  const m = String(value).trim().toUpperCase();
  if (!isMoedaSuportada(m)) {
    throw ERR.VALIDATION(`Moeda invalida. Valores aceitos: ${MOEDAS_SUPORTADAS.join(', ')}`);
  }
  return m;
}

// Campos cifrados em repouso (enc:v1:...) — decifrar em toda leitura.
const ENC = ['cnpj', 'email', 'telefone'];
// clean + cap (limites antigos do VARCHAR) + cifra, num passo só.
const encClean = (v, max, field) => encryptField(capText(clean(v), max, field));

export function buildEmpresasRouter({ requireFinanceAdmin, poolRef = pool, queryFn = query, queryOneFn = queryOne } = {}) {
  const router = Router();

  // GET / — lista empresas "normais". Empresa pessoal sintetica (tipo='pessoal',
  // ver security/ambiente.js) fica de fora: ela nao e uma empresa gerenciavel,
  // e o ambiente Pessoal ja tem seletor proprio. Admin ve todas; usuario comum
  // ve so as empresas com vinculo ativo (nao vaza nome de empresa alheia).
  router.get('/', wrap(async (req, res) => {
    const isAdmin = req.financeUser?.role === 'admin';
    const rows = isAdmin
      ? await queryFn(
          `SELECT \`id\`, \`nome\`, \`cnpj\`, \`email\`, \`telefone\`, \`moeda_base\`, \`createdAt\`
             FROM \`Empresa\`
            WHERE \`tipo\` = 'normal'
            ORDER BY \`nome\``
        )
      : await queryFn(
          `SELECT e.\`id\`, e.\`nome\`, e.\`cnpj\`, e.\`email\`, e.\`telefone\`, e.\`moeda_base\`, e.\`createdAt\`
             FROM \`Empresa\` e
             JOIN \`FinanceUserEmpresa\` fue
               ON fue.\`empresa_id\` = e.\`id\` AND fue.\`user_id\` = ? AND fue.\`ativo\` = 1
            WHERE e.\`tipo\` = 'normal'
            ORDER BY e.\`nome\``,
          [req.financeUser.id]
        );
    res.json(decRows(rows, ENC));
  }));

  // POST / — cria empresa (admin). So `nome` obrigatorio. O criador ganha
  // vinculo 'dono' na hora — sem isso ele ficaria de fora da propria empresa
  // agora que a checagem de vinculo vale tambem para admin.
  router.post('/', requireFinanceAdmin, wrap(async (req, res) => {
    requireFields(req.body, ['nome']);
    const id = randomUUID();
    const moedaBase = parseMoedaBase(req.body.moeda_base) || 'BRL';
    await queryFn(
      `INSERT INTO \`Empresa\` (\`id\`, \`nome\`, \`cnpj\`, \`email\`, \`telefone\`, \`moeda_base\`)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, String(req.body.nome).trim(),
       encClean(req.body.cnpj, 20, 'cnpj'), encClean(req.body.email, 191, 'email'), encClean(req.body.telefone, 30, 'telefone'),
       moedaBase]
    );
    await queryFn(
      'INSERT INTO `FinanceUserEmpresa` (`id`, `user_id`, `empresa_id`, `perfil`) VALUES (?, ?, ?, ?)',
      [randomUUID(), req.financeUser.id, id, 'dono']
    );
    res.status(201).json({ id });
  }));

  // PUT /:id — atualiza empresa (admin). COALESCE: so altera o que veio.
  router.put('/:id', requireFinanceAdmin, wrap(async (req, res) => {
    const moedaBase = parseMoedaBase(req.body.moeda_base);
    if (moedaBase) {
      const atual = await queryOneFn(
        `SELECT e.\`moeda_base\`, e.\`tipo\`,
                (SELECT COUNT(*) FROM \`FinTransacao\` t WHERE t.\`empresa_id\` = e.\`id\`) AS lancamentos_count
           FROM \`Empresa\` e WHERE e.\`id\` = ? LIMIT 1`,
        [req.params.id]
      );
      if (!atual) throw ERR.NOT_FOUND('Empresa nao encontrada.');
      if (atual.tipo === 'normal'
          && moedaBase !== String(atual.moeda_base || 'BRL').toUpperCase()
          && Number(atual.lancamentos_count || 0) > 0) {
        throw ERR.VALIDATION('A moeda-base empresarial nao pode mudar depois do primeiro lancamento.');
      }
    }
    const r = await queryFn(
      `UPDATE \`Empresa\`
          SET \`nome\`      = COALESCE(?, \`nome\`),
              \`cnpj\`      = COALESCE(?, \`cnpj\`),
              \`email\`     = COALESCE(?, \`email\`),
              \`telefone\`  = COALESCE(?, \`telefone\`),
              \`moeda_base\` = COALESCE(?, \`moeda_base\`),
              \`updatedAt\` = NOW(3)
        WHERE \`id\` = ?`,
      [
        req.body.nome != null && String(req.body.nome).trim() !== '' ? String(req.body.nome).trim() : null,
        encClean(req.body.cnpj, 20, 'cnpj'), encClean(req.body.email, 191, 'email'), encClean(req.body.telefone, 30, 'telefone'),
        moedaBase,
        req.params.id
      ]
    );
    if (!r.affectedRows) throw ERR.NOT_FOUND('Empresa nao encontrada.');
    res.json({ ok: true });
  }));

  // DELETE /:id — remove empresa (admin), com guardas.
  router.delete('/:id', requireFinanceAdmin, wrap(async (req, res) => {
    const alvo = await queryOneFn('SELECT `id`, `tipo` FROM `Empresa` WHERE `id` = ?', [req.params.id]);
    if (!alvo) throw ERR.NOT_FOUND('Empresa nao encontrada.');
    // Empresa pessoal e sintetica (1 por usuario, ver security/ambiente.js) — o
    // CASCADE de FinanceUserEmpresa apagaria o vinculo do dono e orfanaria todo
    // o Pessoal dele. Nunca excluivel por aqui.
    if (alvo.tipo === 'pessoal') {
      throw ERR.VALIDATION('Empresa pessoal nao pode ser excluida.');
    }

    const totalRow = await queryOneFn('SELECT COUNT(*) AS n FROM `Empresa`');
    if (Number(totalRow?.n || 0) <= 1) {
      throw ERR.VALIDATION('Nao e possivel excluir a unica empresa.');
    }

    const usersRow = await queryOneFn(
      'SELECT COUNT(*) AS n FROM `FinanceUser` WHERE `empresa_id` = ?',
      [req.params.id]
    );
    if (Number(usersRow?.n || 0) > 0) {
      throw ERR.CONFLICT('Empresa possui usuarios vinculados. Realoque-os antes de excluir.');
    }

    const conn = await poolRef.getConnection();
    try {
      await conn.beginTransaction();
      const snapshotEmpresa = await snapshotLinha(conn, 'Empresa', req.params.id, null, { forUpdate: true });
      if (!snapshotEmpresa) throw ERR.NOT_FOUND('Empresa nao encontrada.');
      // FinanceUserEmpresa cai em CASCADE quando a empresa e apagada — os
      // snapshots dos vinculos tem que ser tirados ANTES do DELETE, senao a
      // linha ja se foi (CASCADE) quando formos ler.
      const [vinculoRows] = await conn.execute(
        'SELECT `id` FROM `FinanceUserEmpresa` WHERE `empresa_id` = ?',
        [req.params.id]
      );
      const snapshotsVinculos = [];
      for (const { id: vinculoId } of vinculoRows) {
        snapshotsVinculos.push({ id: vinculoId, snapshot: await snapshotLinha(conn, 'FinanceUserEmpresa', vinculoId) });
      }

      const [r] = await conn.execute('DELETE FROM `Empresa` WHERE `id` = ?', [req.params.id]);
      if (!r.affectedRows) throw ERR.NOT_FOUND('Empresa nao encontrada.');
      const grupoId = novoGrupo();
      await registrarExclusao(conn, {
        grupoId, entidade: 'empresa', entidadeId: req.params.id,
        estrategia: 'snapshot', snapshot: snapshotEmpresa,
        rotulo: snapshotEmpresa.nome || null, req
      });
      for (const { id: vinculoId, snapshot } of snapshotsVinculos) {
        await registrarExclusao(conn, {
          grupoId, entidade: 'vinculo_empresa', entidadeId: vinculoId,
          estrategia: 'snapshot', snapshot,
          rotulo: 'Vinculo de empresa', req
        });
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ ok: true });
  }));

  return router;
}
