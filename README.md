# skylight-cli

Unofficial, read-only command-line tool and Node.js client for [Skylight](https://www.skylight.io) performance data.

> **Not affiliated with or endorsed by Skylight.** It calls the same HTTP endpoints that the official
> [`skylight-mcp`](https://www.skylight.io/support/mcp) server uses. Those endpoints are not a published API
> contract and may change without notice.

Requires Node.js 22+. No dependencies.

## Install

```sh
npm install -g skylight-cli
export SKYLIGHT_MCP_TOKEN=...   # https://www.skylight.io/app/settings/mcp
skylight-cli auth
```

## Usage

```sh
skylight-cli components                          # guid, environment, name
skylight-cli endpoints --sort p95 -n 10          # slowest endpoints, last 6h
skylight-cli endpoints -s users#index --since 24h
skylight-cli endpoints -c staging/web --at 1790000000 --since 1h
skylight-cli endpoint users#show                 # latency + N+1 queries for one endpoint
skylight-cli trends --since 24h                  # app-wide count and p50/p95/p99, 10-minute buckets
skylight-cli trends --since 45d --step 3600      # fetched as 7 parallel requests
skylight-cli deploys -n 5                        # most recent first
skylight-cli endpoints --json | jq '.endpoints[0]'
```

| Option | Meaning |
| --- | --- |
| `-c, --component` | Component guid, `environment/name`, or unique name. Defaults to `$SKYLIGHT_COMPONENT_ID`, or the only component. |
| `--since` | Window length (`90s`, `30m`, `6h`, `45d`). Endpoints/endpoint: default 6h, max 24h. Trends: default 7d, max 45d. Deploys: default 45d, max 180d. |
| `--at` | Window start in unix seconds, rounded down to the minute. Default: now minus `--since`. |
| `-n, --limit` | Rows to show, 1–500 (default 20). Applied after search and sort. |
| `-s, --search` | Endpoint name filter; `users#index` also matches `UsersController#index` and `Admin::UsersController#index`. |
| `--sort` | `count`, `p50`, `p95`, or `p99` (descending). Default: Skylight's order. |
| `--step` | Trends bucket: `60`, `600`, or `3600` seconds. Default: 60 up to 2h, 600 up to 24h, else 3600. |
| `--json` | Machine-readable output. |

Exit codes: `0` success, `1` API or network failure, `2` usage error.

`endpoint <name>` accepts a search term when it matches exactly one endpoint; otherwise it lists candidates.
Its p50/p95/p99 are Skylight's own figures; min and max come from the endpoint's latency digest.

Latencies are in milliseconds.

## Library

```js
import { SkylightClient } from 'skylight-cli';

const client = new SkylightClient(); // reads SKYLIGHT_MCP_TOKEN
const [component] = await client.listComponents();
const { endpoints } = await client.listEndpoints({ componentId: component.guid, sortBy: 'p95', limit: 10 });
const { data } = await client.listDeploys({ componentId: component.guid, limit: 5 });
const trends = await client.getLatencyTrends({ componentId: component.guid, duration: 86_400 });
const detail = await client.getEndpointDetail({ componentId: component.guid, endpoint: endpoints[0]!.name });
```

Types ship with the package. Upstream limits are exported as constants from `src/spec.ts`, for example
`ENDPOINT_WINDOW`, `DEPLOY_WINDOW`, `LIMIT`, and `ENDPOINT_SORT_KEYS`. The client's validators and the CLI help read
the same constants.

The client exchanges the MCP token for a session token and per-component API tokens, then retries once after an HTTP 401
with a fresh set. Requests time out after 30 s and never follow redirects. The data-service URL returned by Skylight must
be HTTPS on `skylight.io`. Errors carry a code and HTTP status only, never tokens or response bodies.

## How the API works

Observed against the live API and `skylight-mcp 0.1.0`, verified 2026-09-25. The `Authorization` header carries
the raw token, with **no** `Bearer` prefix. The three tokens are not interchangeable, and each call to authenticate
or apps issues fresh ones.

| Method | Path | Token | Purpose |
| --- | --- | --- | --- |
| GET | `www.skylight.io/mcp/authenticate` | MCP | session token (valid 3h), `data_url` |
| GET | `www.skylight.io/mcp/apps` | session | apps, components, per-component `client_api_token` |
| GET | `www.skylight.io/deploys?timestamp&duration&app_component_id` | session | deploys, `application/vnd.api+json` |
| POST | `{data_url}/apps/{component}/endpoint_highlights` | client | endpoint metrics; body `{timestamp, duration}` |
| POST | `{data_url}/apps/{component}/endpoints/{encodeURIComponent(name)}/summary` | client | latency q-digest, inspections, trace |
| POST | `{data_url}/apps/{component}/application_highlights` | client | trends; body `{ranges: [{timestamp, step, count}]}` |

- Trends: `step` must be 60, 600, or 3600, and `step × count` summed over all ranges must be at most 7 days.
  Longer windows take several requests.
- Summary: the name keeps its `<sk-segment>…</sk-segment>` suffix and must be percent-encoded. An unknown name
  returns 200 with `count: 0`, not 404.
- Trace, decoded 2026-09-25 by comparing responses with the Skylight UI (types: `TraceNode`, `TraceSpan`):
  - `trace.targets` are 10 ms latency buckets that samples were drawn from.
  - Each node is `[parent index, category, title, description, spans]`; the description is the SQL for queries.
  - Each span holds one node's timing within one target: start and duration in ms, relative to the parent.
  - A span also carries allocations and a `[deploy ref, source location id]` pair. The UI shows the pair as the
    deploy's git sha and a `file.rb:line`.
  - Three span fields are still unknown.
- Latencies are in milliseconds, confirmed against the UI (typical response = p50, problem response = p95).
- Q-digest nodes are `[lower, level, count]`, counting samples in `[lower, lower + 2^level)`.
- Upstream returns full lists; `limit` is applied client-side.

Error responses, as recorded in [`test/fixtures`](test/fixtures):

| Case | Status | Body |
| --- | --- | --- |
| Invalid, missing, or `Bearer`-prefixed MCP token | 401 | JSON `{"error": {"reason": "unauthorized", "message": "Invalid or inactive MCP token."}}` |
| Invalid or wrong-kind token on `www` (apps, deploys) | 401 | empty `text/html` |
| Invalid or wrong-kind token on the data service | 401 | empty |
| Unknown component | 404 | empty (data service) or an HTML error page (deploys) |
| `/deploys` with `Accept: application/json` | 406 | empty; the client sends `*/*` |
| Malformed body, bad trends `step`, missing fields | 422 | `text/plain` serde message, e.g. `ranges[0].step: InvalidRangeStep` |
| Endpoint window over 24h, trends over 7 days | 422 | empty |
| Summary name not percent-encoded | 404 | empty |

## Development

TypeScript source in `src/`, compiled to `dist/` with no runtime dependencies.

```sh
npm install
npm run typecheck   # src and tests
npm test            # unit + recorded-fixture tests, offline
npm run build       # dist/ + .d.ts; also runs on prepublishOnly
```

### Tests against real responses

Every upstream response in the tests is real. `test/support/scenarios.ts` lists the scenarios: each endpoint's
success case plus its error cases (bad tokens, wrong token kind, unknown ids, malformed bodies, limits).

- `npm run fixtures:record` runs every scenario against the live API and writes `test/fixtures/*.json`. It needs
  `SKYLIGHT_MCP_TOKEN`.
- `test/support/sanitize.ts` de-identifies the recordings before they are written. It is default-deny: every string is
  replaced with a keyed HMAC pseudonym unless it is a known-safe field, such as a status, an upstream error message,
  an event category, or a timestamp. The key lives in the gitignored `.fixture-key`.
  - Tokens become `test-mcp-token`, `test-session-token`, and `test-client-token`.
  - Every identifier in an endpoint name is renamed, including the action. Only `::`, `#`, `<sk-segment>`, and the
    format remain.
  - SQL is dropped and HTML error pages are reduced to a marker.
  - Request counts and latencies are scaled by secret factors derived from the key, so fixtures reveal neither
    traffic volume nor which endpoints are slow. Q-digests are rescaled into valid digests.
  - Numbers inside the undecoded trace tuples are zeroed.
  - The recorder aborts without writing if any original value survives.
- `test/fixtures.test.ts` replays the fixtures through [MSW](https://mswjs.io), so the client's real `fetch` path
  sees real statuses, content types, and bodies. A replayed request carrying the wrong token kind fails the test.
- `npm run test:live` is an opt-in contract check. It re-runs every scenario live and compares status, media type,
  error text, and JSON shape with the fixtures, then drives the client end to end. When it fails, Skylight has
  changed: re-record and review the fixture diff.


Source files import each other with `.ts` extensions, and `tsc` rewrites them to `.js`
(`rewriteRelativeImportExtensions`). `erasableSyntaxOnly` keeps the code runnable by Node's type stripping, so
there are no enums or parameter properties.

## Releasing

Push a `v*` tag. `.github/workflows/publish.yml` builds, tests, and publishes through npm trusted publishing
(OIDC), with provenance. No npm token is stored in GitHub.

```sh
npm version minor   # bumps package.json and creates the v* tag
git push --follow-tags
```

## License

MIT
