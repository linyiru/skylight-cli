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

### Verified 2026-09-25, not yet in the CLI

**Latency trends**: `POST {data_url}/apps/{component}/application_highlights`, client API token.

```json
{"ranges": [{"timestamp": 1789765200, "step": 3600, "count": 168}]}
```

- `step` must be `60`, `600`, or `3600`. Other values return 422 `InvalidRangeStep`.
- The sum of `step × count` over all ranges must be at most 604800 (7 days); otherwise 422 with an empty body.
  A 45-day view therefore needs several requests. Zero ranges and duplicate ranges are accepted.
- Unaligned timestamps are echoed back unchanged. Windows ending 60 days ago still return data.
- Response `ranges[]` carries `timestamp`, `duration`, `step`, and per-step arrays `counts`,
  `latenciesP50/P90/P95/P98/P99/Max` of length `count`.
- 422 errors have a `text/plain` serde message naming the missing or invalid field.

**Endpoint detail**: `POST {data_url}/apps/{component}/endpoints/{encodeURIComponent(name)}/summary`, body
`{timestamp, duration}`, client API token. The name keeps its `<sk-segment>…</sk-segment>` suffix, percent-encoded.
The response contains:

- `endpoint`: `name`, `timestamp`, `duration`, `count`, and `latencies` as a q-digest (`count`, `min`, `max`,
  `nodes[]` of 3-number tuples).
- `trace`: `count`, `duration`, `timestamp`, `targets[]` (`start`, `length`, `requests[]`), and `nodes[]` of
  positional tuples `[number|null, string, string|null, string|null, spans[]]`. Each span is 7 numbers followed by
  `[[4 numbers], [number, [[key, value], …]]]`. Field meanings are not yet decoded.
- `inspections`: `results[]` with `type` (e.g. `nPlusOneQuery`), `severity`, `event` (`[category, title, sql]`),
  and q-digests `durations` and `repetitions`.

The official MCP's `latency_range` (full/fastest/slowest) is not sent upstream; it filters trace spans locally.
It also reads `www.skylight.io/source_locations?filter[id]=…` (unverified) to map trace nodes to source code.

Latency values look like milliseconds. The app-wide hourly p95 is about 40, and one endpoint's q-digest spans 5 to 993.
This is not confirmed.

## License

MIT
