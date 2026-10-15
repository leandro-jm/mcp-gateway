# ADR-024: Setup inicial pela Admin UI (primeiro admin e primeiro tenant)

- Status: aceito
- Data: 2026-10-14

## Contexto
Subir uma instância nova exigia dois passos fora da UI:
1. `node dist/migrate.js create-admin <username>` no console do container, para criar o admin de plataforma (ADR-011);
2. `POST /admin/v1/tenants` com curl, porque a Admin UI bloqueava todas as telas com "Nenhum tenant cadastrado", inclusive a de Tenants.

No Portainer, o caminho é abrir o console de um container, copiar uma senha gerada e montar um login + POST na mão. Foi o primeiro obstáculo de um deploy real. Ferramentas parecidas (Portainer, Grafana, Jenkins) resolvem isso com uma tela de setup.

O risco conhecido de uma tela de setup sem login é o sequestro da instância: quem acessa a URL primeiro vira admin. Para não depender de quem chega primeiro, o setup exige um segredo que só o operador conhece.

## Decisão
**Setup inicial (instância sem nenhum usuário)**
- Nova variável `SETUP_TOKEN` (opcional, no mínimo 16 caracteres). **Sem ela, o setup fica desligado** e a instância segue o caminho da CLI.
- `GET /admin/v1/setup` (público) devolve `{ needed, enabled }`:
  - `needed`: não existe nenhum usuário;
  - `enabled`: `SETUP_TOKEN` está definido.
- `POST /admin/v1/setup` (público) recebe `setupToken`, `username`, `password`, `locale` e `tenant { slug, name }`.
  - Valida o token com comparação em tempo constante e tem rate limit por IP (10 tentativas a cada 15 min).
  - Numa transação com advisory lock, confere que ainda não há usuários e cria o tenant e o admin de plataforma (`tenant_id` nulo, role `gateway-admin`). Se duas requisições chegarem juntas, só a primeira cria.
  - Devolve uma sessão (`token`, `expiresAt`), como o login, e o `slug` do tenant. A UI entra direto, já no tenant criado.
- Depois do primeiro usuário, o setup responde 409 para sempre, mesmo com o token certo. Não há como "reabrir" o setup: novos admins saem da tela de Usuários ou da CLI.
- Erros:
  - setup desligado: 403;
  - já feito: 409;
  - token inválido: 401;
  - todos com mensagens do catálogo (`auth.setup*`).

**Admin sem tenant**
- Quando o admin de plataforma não tem nenhum tenant (instância criada pela CLI), a Admin UI mostra o formulário "Criar o primeiro tenant" no lugar do aviso pedindo `POST /admin/v1/tenants`. Usa o endpoint que já existe.

**O que não muda**
- `create-admin` continua funcionando e é o caminho quando `SETUP_TOKEN` não está definido.
- O seed de desenvolvimento cria usuários, então em dev o setup nunca aparece.
- O token de setup não é gravado no banco nem aparece nos logs. Vale só enquanto não houver usuário. Pode ser removido do ambiente depois do setup.

## Consequências
- O deploy por Portainer fica sem console: definir `SETUP_TOKEN` na stack, abrir a URL e preencher a tela.
- Quem esquece de definir `SETUP_TOKEN` vê na tela de setup como habilitar o setup (variável + restart do gateway) ou usar a CLI.
- Esquecer o `SETUP_TOKEN` no ambiente depois do setup não abre brecha, porque o setup só age sem usuários. Ainda assim, a documentação recomenda removê-lo.
- Se alguém apagar todos os usuários do banco, o setup volta a valer, mas só com o token. É o mesmo nível de acesso de quem tem o banco.
