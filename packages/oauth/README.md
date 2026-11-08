# @mcp-gateway/oauth

OAuth 2.1 protocol logic for the gateway's authorization server (ADR-030): PKCE `S256`, redirect URI rules (exact match, loopback port per RFC 8252), Client ID Metadata Documents and Dynamic Client Registration validation, scopes, MCP resource indicators (RFC 8707), authorization and token request parsing, RFC 6749 errors and the RFC 8414 metadata document.

Pure package: no I/O (enforced by ESLint). Routes, persistence, CIMD fetching and the login screens live in `apps/gateway/src/oauth`.

Part of the [mcp-gateway](../../README.md) monorepo; internal and not published to npm. Licensed under [Apache-2.0](../../LICENSE).
