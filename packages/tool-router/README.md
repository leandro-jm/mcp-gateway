# @mcp-gateway/tool-router

Decision-model tool router (ADR-025): provider-neutral questions and answers, wire mapping for the OpenAI Decisions API and TypeSafe Jev, question builders, answer interpretation and the `ToolRouterPlugin` contract (rerank, shortlist, gate).

Pure package: no I/O (enforced by ESLint). HTTP adapters and the router service live in `apps/gateway/src/router`.

Part of the [mcp-gateway](../../README.md) monorepo; internal and not published to npm. Licensed under [Apache-2.0](../../LICENSE).
