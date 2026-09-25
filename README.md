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
skylight-cli deploys -n 5                        # most recent first
skylight-cli endpoints --json | jq '.endpoints[0]'
```

| Option | Meaning |
| --- | --- |
| `-c, --component` | Component guid, `environment/name`, or unique name. Defaults to `$SKYLIGHT_COMPONENT_ID`, or the only component. |
| `--since` | Window length (`90s`, `30m`, `6h`, `45d`). Endpoints: default 6h, max 24h. Deploys: default 45d, max 180d. |
| `--at` | Window start in unix seconds, rounded down to the minute. Default: now minus `--since`. |
| `-n, --limit` | Rows to show, 1–500 (default 20). Applied after search and sort. |
| `-s, --search` | Endpoint name filter; `users#index` also matches `UsersController#index` and `Admin::UsersController#index`. |
| `--sort` | `count`, `p50`, `p95`, or `p99` (descending). Default: Skylight's order. |
| `--json` | Machine-readable output. |

Exit codes: `0` success, `1` API or network failure, `2` usage error.

Latency units are not documented upstream; values are shown as returned.

## Library

```js
import { SkylightClient } from 'skylight-cli';

const client = new SkylightClient(); // reads SKYLIGHT_MCP_TOKEN
const [component] = await client.listComponents();
const { endpoints } = await client.listEndpoints({ componentId: component.guid, sortBy: 'p95', limit: 10 });
const { data } = await client.listDeploys({ componentId: component.guid, limit: 5 });
```

The client exchanges the MCP token for a session token and per-component API tokens, then retries once after an HTTP 401
with a fresh set. Requests time out after 30 s and never follow redirects. The data-service URL returned by Skylight must
be HTTPS on `skylight.io`. Errors carry a code and HTTP status only, never tokens or response bodies.

## How the API works

Observed on 2026-09-25 against `skylight-mcp 0.1.0`. The `Authorization` header carries the raw token, with **no**
`Bearer` prefix. There are three distinct tokens:

| Method | Path | Token | Purpose |
| --- | --- | --- | --- |
| GET | `www.skylight.io/mcp/authenticate` | MCP token | session token, `data_url` |
| GET | `www.skylight.io/mcp/apps` | session | apps, components, per-component `client_api_token` |
| POST | `{data_url}/apps/{component}/endpoint_highlights` | client API token | endpoint metrics; body `{timestamp, duration}` |
| GET | `www.skylight.io/deploys?timestamp&duration&app_component_id` | session | deploys (JSON:API `data[].attributes`) |

`/deploys` returns 406 for `Accept: application/json`, so the client sends `Accept: */*` like the official server.
Upstream returns the full list; `limit` is applied client-side.

Not yet verified. These paths were inferred from strings in the official binary:

| MCP tool | Probable path | Response fields |
| --- | --- | --- |
| `get_latency_trends` | `{data_url}/apps/{component}/application_highlights` | `ranges[]`: `counts`, `latenciesP50/P90/P95/P98/P99/Max` |
| `get_endpoint_detail` | `{data_url}/apps/{component}/endpoints/{endpoint}/summary` | `latencies` (q-digest), `trace` |

## License

MIT
