# CF Finance — Correção de isolamento Pessoal x Empresarial

> Documento de acompanhamento do projeto. Objetivo: eliminar o vazamento de dados entre os ambientes Pessoal e Empresarial (contas, categorias, lançamentos) causado por múltiplos pontos onde o backend confia em valores enviados pelo front em vez do ambiente ativo da sessão.
>
> Repositórios de origem desta auditoria: `nodejs__2_.zip` (frontend) e `backend.zip` (backend Node/Express + MySQL).

---

## Status

| Fase | Descrição | Status |
|---|---|---|
| 0 | Preparação (backup + baseline) | 🟡 backup feito; deploy em produção ainda pendente |
| 1 | Fechar escritas que corrompem dado | ✅ **aplicada** — commit `7fe7e1c` |
| 2 | Ambiente da sessão nunca fica indefinido | ✅ **aplicada** — commit `14989d2` |
| 3 | Falha de troca de ambiente vira erro visível | ✅ **aplicada** — commit `6482618` |
| 4 | Backfill dos dados órfãos | 🔲 pendente — bloqueada até Fase 1 estar em produção há alguns dias (ver nota na seção da Fase 4) |
| 5 | Delegação: PUT/DELETE de categoria | ✅ **aplicada** — ver nota na seção da Fase 5: bug já não existia no ramo pessoal, ramo empresarial ajustado por clareza (no-op comprovado) |

Nenhuma destas fases foi deployada em produção ainda — o código está no branch `claude/session-yi1efo` (default do repo `zerinho123/marcos`).

Trabalhe as fases nesta ordem. 1, 2, 3 e 5 são independentes entre si e podem entrar no mesmo deploy. A Fase 4 mexe em dado de produção — trate como operação isolada, com janela definida.

---

## Modelo de dados (contexto)

- `Empresa.tipo`: `normal` (empresa real) ou `pessoal` (sintética, 1 por usuário, criada automaticamente).
- `FinanceUserEmpresa`: vínculo N:M usuário↔empresa — fonte única de verdade de quem acessa o quê (`ativo`, `perfil`).
- `FinanceDelegacao`: gestor comanda o ambiente Pessoal de outro usuário sem saber a senha (`gestor_id`, `usuario_id`, `permissao`, `ativo`).
- Sessão (JWT em cookie `cff_session`): carrega `empresa_id`, e quando o usuário já passou por `POST /auth/ambiente`, também `ambiente_tipo` + `ambiente_explicito=true`.
- `resolveFinanceEscopo` (`backend/routes/_common.js`): decide se uma requisição é `'pessoal'` ou `'empresarial'`. Quando `ambiente_explicito=true`, **ignora** o que o front manda e usa o `ambiente_tipo` do JWT.
- `resolveFinanceEmpresa` (mesmo arquivo): decide qual `empresa_id` uma requisição usa.

O bug raiz em todas as fases 1–4: esses dois resolvers podem divergir do que a tela mostra, e algumas rotas de escrita gravam `escopo`/`tipo` direto do body sem passar por eles.

---

## FASE 0 — Preparação

Sem deploy de código. Fazer antes de tudo.

1. **Backup completo do banco** (`mysqldump`). Obrigatório antes da Fase 4 — não pule mesmo que ela ainda esteja longe.
2. **Baseline de registros órfãos** — rodar e guardar o resultado:
   ```sql
   -- contas presas no ambiente errado
   SELECT cb.id, cb.nome, cb.escopo, e.tipo AS empresa_tipo
   FROM FinContaBancaria cb JOIN Empresa e ON e.id = cb.empresa_id
   WHERE (e.tipo='pessoal' AND cb.escopo='empresarial') OR (e.tipo='normal' AND cb.escopo='pessoal');

   -- categorias no mesmo problema
   SELECT c.id, c.nome, c.escopo, e.tipo AS empresa_tipo
   FROM FinCategoria c JOIN Empresa e ON e.id = c.empresa_id
   WHERE (e.tipo='pessoal' AND c.escopo='empresarial') OR (e.tipo='normal' AND c.escopo='pessoal');
   ```
3. Criar branch `fix/isolamento-ambiente`. Um commit por fase.

---

## FASE 1 — Fechar as escritas que corrompem dado ✅ APLICADA

**Por que primeiro:** enquanto abertas, todo uso do sistema no ambiente errado cria mais lixo — migrar antes disso é enxugar gelo.

Arquivos já corrigidos (em `fase-1-arquivos-corrigidos.zip`, substituir nos mesmos caminhos):

### `backend/routes/_common.js` — `resolveFinanceEmpresa`
Ambiente explícito passa a mandar mesmo para admin. Antes, o `empresa_id` vindo do front (query/body) sobrepunha a empresa da sessão para qualquer admin — e esse valor no boot do front é sempre a empresa **normal**, mesmo com o ambiente ativo em Pessoal.
```js
export function resolveFinanceEmpresa(req, candidate = null) {
  const user = req.financeUser;
  if (!user) throw ERR.UNAUTHENTICATED();
  const requested = (user.role === 'admin' && !user.ambiente_explicito)
    ? (candidate ?? req.query?.empresa_id ?? req.body?.empresa_id ?? user.empresa_id)
    : user.empresa_id;
  // ... resto inalterado
```

### `frontend/public/app-hotfix.js` — `boot()`
Removida a chamada `setActiveEmpresa(state.activeEmpresaId)` antes do `applyAmbiente`. Esse valor é sempre a empresa dona (normal); injetá-lo em toda requisição antes do ambiente real ser confirmado no backend é o que produzia o par `empresa_id=normal + escopo=pessoal`. `setActiveEmpresa` agora só roda dentro de `applyAmbiente()`, com o `empresa_id` que o backend confirmou.

### `backend/routes/contas-bancarias.js` — `PUT /:id`
`escopo` deixou de ser gravável via body sem checagem. Se vier no corpo, precisa bater com `resolveFinanceEscopo(req)` — senão 400 `'Ambiente da conta nao pode ser alterado. Crie outra conta no ambiente desejado.'`. Antes a única trava exigia histórico (`vinculos_count > 0`); conta nova mudava de ambiente sem resistência.

### `backend/routes/categorias.js` — `PUT /:id`
Mesma trava para `tipo` (que funciona como o escopo da categoria: valores `pessoal`/`empresarial`/`ambos`). `escopoSync` deixou de espelhar automaticamente — se o body pedir um `tipo` que muda o ambiente, rejeita com o mesmo tipo de erro.

### Teste de aceite
1. Como admin, no ambiente Pessoal: force no DevTools um `empresa_id` de empresa normal antes de uma gravação — confirme que a transação ainda grava no par correto (empresa pessoal + escopo pessoal).
2. `PUT /api/finance/contas-bancarias/:id` com `{"escopo":"empresarial"}` numa conta do ambiente Pessoal → deve voltar 400.
3. Mesmo teste em `PUT /api/finance/categorias/:id` com `{"tipo":"empresarial"}`.

---

## FASE 2 — Ambiente da sessão nunca fica indefinido

**Bug:** o login emite `issueFinanceSession(row)` sem ambiente, então `payload.ambiente_tipo` vem nulo. `buildRequireFinanceAuth` preenche com `?? 'empresarial'`. Na janela entre o login e o primeiro `POST /auth/ambiente`, um usuário com `workspaces='pessoal'` consegue chamar rotas exclusivamente empresariais (`/contas-pagar`, `/contas-receber`, `/dre`, `/precificacao`).

### `backend/security/financeAuth.js` — dentro de `buildRequireFinanceAuth`
```js
// ANTES
ambiente_tipo: payload.ambiente_tipo ?? 'empresarial',

// DEPOIS
ambiente_tipo: payload.ambiente_tipo
  ?? (user.workspaces === 'empresarial' ? 'empresarial' : 'pessoal'),
```

### `backend/routes/auth.js` — `POST /login`
Resolver o ambiente inicial antes de emitir a sessão, eliminando a janela indefinida:
```js
// ANTES
const { accessToken } = issueFinanceSession(row);
setFinanceAuthCookie(res, accessToken);
const csrfToken = buildFinanceCsrfToken({ userId: row.id });
...
return res.json({ ok: true, user: serializeUser(row), csrf_token: csrfToken });

// DEPOIS
const tipoInicial = row.workspaces === 'empresarial' ? 'empresarial' : 'pessoal';
const alvo = await resolveAmbienteAlvo(
  { id: row.id, nome: row.nome, empresa_id: row.empresa_id, role: row.role },
  { tipo: tipoInicial, empresa_id: row.empresa_id }
);
const { accessToken } = issueFinanceSession(row, alvo);
setFinanceAuthCookie(res, accessToken);
const csrfToken = buildFinanceCsrfToken({ userId: row.id });
...
return res.json({ ok: true, user: serializeUser(row), ambiente: alvo, csrf_token: csrfToken });
```
`resolveAmbienteAlvo` já está importado neste arquivo (usado em `POST /ambiente`).

### Frontend (opcional, reduz uma chamada de rede)
Se `login()` já devolve `ambiente`, usar direto em vez de esperar o primeiro `applyAmbiente` do boot.

### Teste de aceite
Criar usuário de teste com `workspaces='pessoal'`, logar, chamar `GET /api/finance/dre` sem nenhuma troca de ambiente prévia → deve dar 403 imediatamente após o login (nunca passar).

---

## FASE 3 — Falha de troca de ambiente vira erro visível

**Bug:** `toggle-workspace` grava `state.workspace = alvo` **antes** de esperar o backend. Quando `applyAmbiente` falha (rede, CSRF, vínculo revogado), o `catch` interno só faz `console.warn` — não reverte o estado nem avisa o usuário. A tela passa a mostrar um ambiente enquanto o cookie continua no outro.

### `frontend/public/app-hotfix.js` — handler `toggle-workspace`
```js
// ANTES
'toggle-workspace': async () => {
  document.body.classList.remove('nav-open');
  if (!isHybridUser()) return;
  const alvo = state.workspace === 'empresarial' ? 'pessoal' : 'empresarial';
  state.workspace = alvo;
  state.activeNav = 'dashboard';
  await applyAmbiente(alvo, alvo === 'empresarial' ? state.activeEmpresaId : undefined);
  saveUiPrefs({ workspace: state.workspace, activeNav: state.activeNav });
  await refreshAll();
},

// DEPOIS
'toggle-workspace': async () => {
  document.body.classList.remove('nav-open');
  if (!isHybridUser()) return;
  const anterior = state.workspace;
  const alvo = anterior === 'empresarial' ? 'pessoal' : 'empresarial';
  const ambiente = await applyAmbiente(alvo, alvo === 'empresarial' ? state.activeEmpresaId : undefined);
  if (!ambiente) {
    pushToast('Não foi possível trocar de ambiente. Tente de novo.', 'error');
    return; // state.workspace nunca mudou — nada na tela é alterado
  }
  state.workspace = alvo;
  state.activeNav = 'dashboard';
  saveUiPrefs({ workspace: state.workspace, activeNav: state.activeNav });
  await refreshAll();
},
```

### `boot()` — mesma lógica na inicialização
Se `applyAmbiente` retornar `null` no boot, tratar como erro de boot (`state.bootError`) em vez de seguir carregando dados com ambiente indefinido — mesmo padrão já usado no `catch` de `await me()` logo acima no código.

### Teste de aceite
DevTools → Network → Offline durante o clique no toggle. A tela deve permanecer no ambiente anterior, com toast de erro, em vez de ficar dessincronizada.

---

## FASE 4 — Backfill dos dados órfãos

**Pré-requisito:** Fase 0 (backup) e Fase 1 (escritas fechadas) em produção há pelo menos alguns dias — senão o backfill fica correndo atrás de dado que continua entrando torto.

1. Rodar de novo as duas consultas de diagnóstico da Fase 0. Comparar com o baseline — se a Fase 1 já está em produção, o número novo deve estar estável (nada mais entrando torto).
2. Confirmar backup feito.
3. Ligar `FINANCE_PESSOAL_BACKFILL=1` no `.env` de produção — isso ativa `ensureFinancePessoalBackfill()` (`backend/schema-evolution.js:1044`) no próximo boot do servidor. Alternativa: rodar `database/migrations/005` e `006` manualmente.
4. Rodar a migração/relatório `007` (empresas com múltiplos usuários) e revisar manualmente os casos listados — esses não são movidos automaticamente (dono ambíguo, decisão manual).
5. Rodar as consultas de diagnóstico uma terceira vez → confirmar zero linhas órfãs (fora dos casos da migração 007, que ficam para revisão manual).

**Rollback:** restaurar o backup da Fase 0 caso algo saia errado durante o boot com a flag ligada.

> **Nota (sessão de correção):** `backend/sql/007_relatorio_pessoal_multiusuario.sql` foi criado (não existia no repo, só era referenciado em comentário) — é a query de leitura do passo 4. Execução desta fase segue **bloqueada**: as Fases 1-3 ainda não foram deployadas em produção, então o pré-requisito acima não está satisfeito. Backup (Fase 0) já existe. Nenhuma flag foi ligada, nenhum banco de produção foi tocado.

---

## FASE 5 — Delegação: PUT/DELETE de categoria

Isolado das demais, pode entrar em paralelo com qualquer fase acima.

**Bug:** `GET`/`POST` de categorias resolvem o dono via `personalUserId(req)` (que aponta para `pessoal_owner_id` — o dono da conta comandada por delegação). `PUT`/`DELETE` usam `req.financeUser?.id` (o próprio gestor). Num ambiente delegado com permissão `operar`, o gestor lista as categorias do gerido normalmente, mas toda edição/exclusão retorna 404.

### `backend/routes/categorias.js`
```js
// PUT /:id (linha ~255)
// ANTES: const userId = req.financeUser?.id ?? null;
const userId = personalUserId(req) || null;

// DELETE /:id (linhas ~350 e ~357)
// ANTES: tail.push(req.financeUser?.id ?? null);
tail.push(personalUserId(req) || null);

// ANTES: if (!isAdmin && !(snapshot.user_id === (req.financeUser?.id ?? null) || snapshot.user_id == null)) {
if (!isAdmin && !(snapshot.user_id === (personalUserId(req) || null) || snapshot.user_id == null)) {
```
A escrita continua barrada quando a delegação é só de leitura — `requireFinanceWriteAccess` já cobre isso antes da rota rodar.

### Teste de aceite
Com uma delegação ativa (`operar`), gestor lista categorias do gerido, edita uma e confirma que não cai mais em 404.

> **Nota (sessão de correção):** ao reler `categorias.js` inteiro para aplicar esta fase, o bug descrito acima **já não existia** no ramo pessoal — GET, POST, PUT e DELETE de `FinCategoriaPessoal` já usavam `personalUserId(req)` de forma consistente. O único lugar que ainda usava `req.financeUser?.id` era o ramo empresarial (`FinCategoria`) do DELETE, fora do `if (isPersonalRequest(req))` — mas esse ramo é inalcançável em contexto de delegação (`isPersonalRequest` sempre desvia antes, já que `FinanceDelegacao` só existe para o ambiente Pessoal), e o JWT garante `personalUserId(req) === req.financeUser.id` sempre que esse ramo roda. A troca foi aplicada mesmo assim ali, por clareza/defensivo — é comprovadamente um no-op hoje, não uma correção de comportamento.

---

## Resumo de esforço

| Fase | Arquivos tocados | Risco | Bloqueia deploy? |
|---|---|---|---|
| 1 | `_common.js`, `contas-bancarias.js`, `categorias.js`, `app-hotfix.js` | baixo | não |
| 2 | `financeAuth.js`, `auth.js` | baixo | não |
| 3 | `app-hotfix.js` | baixo | não |
| 4 | banco de dados (`.env` + migrações) | **médio** — exige backup | sim, planejar janela |
| 5 | `categorias.js` | baixo | não |

Fases 1, 2, 3 e 5 podem ir num único deploy. A Fase 4 é a única que mexe em dado de produção — operação separada, com backup confirmado antes de ligar a flag.
