# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `--repo owner/name` (or `$SKYLIGHT_GITHUB_REPO`) links app `file:line` in `trace` and the commit in `compare` to
  GitHub at the deployed sha. The links match Skylight's UI. They are clickable OSC 8 hyperlinks in terminals, and
  `url` fields in `--json`. `githubFileUrl()`, `githubCommitUrl()`, `parseGithubRepo()`.

## [0.6.0] - 2026-09-25

### Added

- `report` command: a weekly report like Skylight's Trends email. It shows typical and problem performance vs last
  week, the biggest slowdowns, the most improved endpoints, and frog boils over up to 6 weeks. It is rebuilt from
  daily endpoint highlights and hourly app trends. `weeklyReport()`, `getWeek()`, `weekStart()`.
- `getEndpointHighlights()`: every endpoint in a window, unranked and without the 500 limit.
- Fixtures and live checks for Trends intervals, the Trends report's 401 for MCP sessions, and data retention.

### Fixed

- `trace`: a deploy that fails to load (e.g. deleted) no longer hides every source location; only its git sha is
  missing. Traces spanning several deploys list each sha once.

## [0.5.0] - 2026-09-25

### Added

- `endpoints` shows Skylight's grade, agony, requests per minute, and N+1 and high-allocation flags, and sorts by
  agony by default, like the Skylight UI. Scores come from the UI's own formulas. `rankEndpoints()`, `gradeFor()`.
- `endpoint` and `trace` show the time breakdown (app / db / view / other); `endpoint` adds a response-time histogram
  from the latency digest. `timeBreakdown()`, `digestQuantile()`, `digestHistogram()`.
- `trace` marks events that repeat within a request (`×N`, e.g. N+1 queries) and hints where app code needs custom
  instrumentation. `--latency fastest` and `--latency slowest` select the quickest 30% or requests above p95.
- `compare` command and `compareEndpoints()`: endpoints that got slower or faster across a deploy, ranked by request
  time added per minute, with endpoints that appeared or disappeared.
- `TraceSpan` fields are all named (repetitions, max repetitions, variance), following Skylight's frontend.

### Fixed

- Trace self time was too low when a child event ran in only some of the requests, which also shifted time from
  app to db in the breakdown.

## [0.4.0] - 2026-09-25

### Added

- `trace` shows each event's source: its app `file:line`, or `[gem]` for library code, and the deploy that
  recorded it. `--no-sources` skips the lookup, and a failed lookup does not affect the trace.
- `getSourceLocations()`, `getDeploy()`, `traceSourceRefs()`, `parseTraceSource()`, and `locateTraceTree()` in the
  library.

### Changed

- Recorded test fixtures keep the trace structure, with timings and request counts scaled like other metrics, and
  include source locations and deploys with every path segment renamed.

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

[unreleased]: https://github.com/linyiru/skylight-cli/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/linyiru/skylight-cli/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/linyiru/skylight-cli/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/linyiru/skylight-cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/linyiru/skylight-cli/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/linyiru/skylight-cli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/linyiru/skylight-cli/releases/tag/v0.1.0
