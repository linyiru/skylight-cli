# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-25

### Added

- `trace <name>` command: the endpoint's aggregated trace as a tree, with each event's start, duration, self time,
  allocations, and share of requests. `--latency a-b` limits it to requests in that response-time range,
  `--min-ms` hides short events, and `--full` disables condensing.
- `buildTraceTree()` and `condenseTraceTree()` in the library.
- Types for the endpoint summary trace (`TraceNode`, `TraceSpan`, `TraceTarget`, `TraceAnnotation`). The format
  was decoded by comparing API responses with the Skylight UI.
- This changelog.

### Changed

- `endpoint` and `trace` accept a name without its `<sk-segment>` variant and use the non-`error` variant.
- Latencies are documented as milliseconds, confirmed against the Skylight UI.

## [0.2.0] - 2026-09-25

### Added

- `trends` command and `getLatencyTrends()`: app-wide request count and p50/p90/p95/p98/p99/max per bucket. Windows
  longer than 7 days are split into parallel requests. `--step` accepts 60, 600, or 3600 seconds.
- `endpoint <name>` command and `getEndpointDetail()`: an endpoint's latency and inspections, such as N+1 queries
  with their SQL. `<name>` may be a search term that matches exactly one endpoint.
- TypeScript declarations for the client, the API wire formats, and the upstream limits in `spec.ts`.
- Tests that replay recorded, de-identified live API responses through MSW, plus an opt-in live contract check
  (`npm run test:live`).
- Releases publish from GitHub Actions through npm trusted publishing, with provenance.

### Changed

- Rewritten in TypeScript and compiled to `dist/`. There are still no runtime dependencies.
- An unknown `--sort` key now lists the valid keys.

### Fixed

- An error response with a body could hang the client while the body was discarded.

## [0.1.0] - 2026-09-25

### Added

- `skylight-cli` with `auth`, `apps`, `components`, `endpoints`, and `deploys` commands, table or `--json` output.
- `endpoints --search` (Rails-style `users#index`) and `--sort count|p50|p95|p99`.
- `SkylightClient`, a read-only Node.js client that handles the MCP token → session token → client API token chain.

[unreleased]: https://github.com/linyiru/skylight-cli/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/linyiru/skylight-cli/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/linyiru/skylight-cli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/linyiru/skylight-cli/releases/tag/v0.1.0
