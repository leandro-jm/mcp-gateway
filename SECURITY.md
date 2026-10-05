# Security Policy

mcp-gateway sits between AI agents and APIs that may carry personal data and upstream credentials, so security reports are taken seriously.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for security problems.**

Report privately through [GitHub Security Advisories](https://github.com/leandro-jm/mcp-gateway/security/advisories/new). Include:
- affected version or commit;
- a description of the issue and its impact (for example tenant isolation bypass, policy bypass, SSRF, PII or credential leak, prompt-injection-driven escalation);
- steps to reproduce or a proof of concept;
- any suggested fix.

You should get an acknowledgement within 5 business days. Once the issue is confirmed, a fix and an advisory are prepared together with you, and you are credited unless you prefer otherwise.

## Scope and threat model
The threat model is documented in [ADR-003](docs/decisions/ADR-003-modelo-de-ameacas.md) (pt-BR). In short, the gateway treats agents as semi-trusted clients and protects personal data in responses, upstream credentials, the boundary between tenants, the internal network (SSRF) and the integrity of write operations.

## Hardening reminders
- The seed users and the `mgw_dev-agent-token-…` token are for **local development only**. Production admins are created with `pnpm db:create-admin`.
- Set a unique `GATEWAY_MASTER_KEY` (`openssl rand -base64 32`) and `METRICS_TOKEN`; the gateway refuses to start in production with the development key.
- Keep `NETWORK_ALLOW_PRIVATE=false` in production.
- Follow the security checklist in [docs/deploy.md](docs/deploy.md).
