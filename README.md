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
skylight-cli endpoints                           # worst first, by Skylight's agony; grade, rpm, flags
skylight-cli endpoints --sort p95 -n 10          # slowest endpoints, last 6h
skylight-cli endpoints -s users#index --since 24h
skylight-cli endpoints -c staging/web --at 1790000000 --since 1h
skylight-cli endpoint users#show                 # latency, time breakdown, N+1 queries, distribution
skylight-cli trace graphql:CoursePage            # aggregated trace tree: start, duration, self time, allocations
skylight-cli trace users#show --latency slowest  # only requests above p95; or fastest, or 500-5000
skylight-cli trace users#show --repo owner/app   # file:line links to GitHub at the deployed commit
                                                 # each event shows its app file:line, or [gem]
skylight-cli trends --since 24h                  # app-wide count and p50/p95/p99, 10-minute buckets
skylight-cli trends --since 45d --step 3600      # fetched as 7 parallel requests
skylight-cli deploys -n 5                        # most recent first
skylight-cli compare                             # what the latest deploy slowed down (2h before vs after)
skylight-cli compare --deploy 07b0150 --since 1h
skylight-cli compare --baseline week             # vs the same hours last week: no time-of-day effects
skylight-cli report                              # last week vs the one before, like Skylight's Trends email
skylight-cli report --week 2026-09-07 --weeks 4
skylight-cli endpoints --json | jq '.endpoints[0]'
```

| Option | Meaning |
| --- | --- |
| `-c, --component` | Component guid, `environment/name`, or unique name. Defaults to `$SKYLIGHT_COMPONENT_ID`, or the only component. |
| `--since` | Window length (`90s`, `30m`, `6h`, `45d`). Endpoints/endpoint: default 6h, max 24h. Trends: default 7d, max 45d. Deploys: default 45d, max 180d. |
| `--at` | Window start in unix seconds, rounded down to the minute. Default: now minus `--since`. |
| `-n, --limit` | Rows to show, 1–500 (default 20). Applied after search and sort. |
| `-s, --search` | Endpoint name filter; `users#index` also matches `UsersController#index` and `Admin::UsersController#index`. |
| `--sort` | `agony` (default), `count`, `p50`, `p95`, or `p99`, worst first. |
| `--full` | Trace: show every event. By default, pass-through middleware is folded and events in under 1% of requests are hidden. |
| `--min-ms` | Trace: hide events shorter than this many ms on average. |
| `--latency` | Trace: only requests in a response-time range: `a-b` ms, `fastest` (quickest 30%), or `slowest` (above p95). |
| `--no-sources` | Trace: skip resolving source locations (two extra requests). |
| `--repo` | GitHub repo, `owner/name` or a github.com URL, also `$SKYLIGHT_GITHUB_REPO`. Links `trace` file:line and the `compare` commit to GitHub. |
| `--step` | Trends bucket: `60`, `600`, or `3600` seconds. Default: 60 up to 2h, 600 up to 24h, else 3600. |
| `--json` | Machine-readable output. |

Exit codes: `0` success, `1` API or network failure, `2` usage error.

`endpoints` scores every endpoint the way Skylight's endpoint list does. The scoring was read from Skylight's
frontend and checked against the UI:
- The grade comes from p50, from A+ (≤ 3 ms) to F (over 709 ms).
- Agony is 0–3, shown as `!`. It is the lowest of how high rpm, p50, and p95 each rank among the window's endpoints,
  so only endpoints that are busy and slow score high.
- The `ALLOC` flag marks the top 5% of endpoints by allocations, when a request allocates over 10,000 objects.
- The UI estimates percentiles with a q-digest, so an endpoint right at a boundary can differ by one step.

`endpoint` and `trace` also show where time goes: `app / db / view / other`, Skylight's own breakdown, from each
event's self time. `endpoint` adds a response-time histogram from the latency digest. In a trace, `×N` marks events
that repeat within a request (e.g. N+1 queries). A `Hint` line appears when app code spends over a quarter of the
request in its own code, where the UI suggests custom instrumentation.

`compare` checks a deploy (latest by default, or `--deploy` with a git sha or deploy id prefix). It compares the
window before the deploy started with an equal window starting 5 minutes after, to skip the rollout.
- Only endpoints with 20 requests in both windows are compared (`--min-requests`).
- Endpoints are ranked by request time added per minute (p50 change × rpm), so a busy endpoint that slowed a
  little ranks above a rare one that swung a lot.
- It notes when the next deploy falls inside the after window.
- Adjacent windows can differ in traffic by time of day. `--baseline week` compares the after window with the
  same hours seven days earlier instead, so time-of-day and weekday patterns cancel out. That baseline then carries
  every change deployed during the week, not just this deploy, so the output names the version it ran and how many
  deploys followed.

`report` rebuilds Skylight's weekly Trends report, whose own API needs a web login. It covers:
- typical (p50) and problem (p95) performance against last week;
- the biggest slowdowns and most improved endpoints;
- frog boils: endpoints that crept slower week after week, over up to 6 weeks.

Weeks run Monday to Monday UTC, as in Skylight. Each week takes 8 requests (seven days of endpoint highlights, one
of hourly app trends). Weekly values are request-weighted means of daily percentiles, so they approximate the true
weekly percentile. The thresholds are ours:
- an endpoint needs 100 requests in each week;
- slower or faster means at least 10%;
- a frog boil rose in all but one week and at least 20% overall.

`endpoint <name>` and `trace <name>` accept a name without its `<sk-segment>` variant (the non-`error` variant is
used), or a search term that matches exactly one endpoint; otherwise they list candidates.

`trace` averages each event over the requests that include it. Self time is computed per latency bucket before
averaging. `SEEN` is the share of requests that include the event, as in Skylight's "Occurs in N% of requests".
Each event is followed by its app `file:line` (with `(+N)` for more call sites), or `[gem]` when only library code is
involved, resolved for the deploy that recorded the trace. If the lookup fails, the trace still prints.

With `--repo`, app `file:line` links to `github.com/{repo}/tree/{deployed sha}/{path}#L{line}`, the same link as
Skylight's UI. In a terminal the link is an OSC 8 hyperlink, and in `--json` each location carries a `url`.
Skylight stores the repo, but only behind a web login (`/apps/{id}` answers 401 to an MCP session), so pass it in.
Its p50/p95/p99 are Skylight's own figures; min and max come from the endpoint's latency digest.

Latencies are in milliseconds.

## Library

```js
import { SkylightClient, buildTraceTree, condenseTraceTree, locateTraceTree, traceSourceRefs } from 'skylight-cli';

const client = new SkylightClient(); // reads SKYLIGHT_MCP_TOKEN
const [component] = await client.listComponents();
const { endpoints } = await client.listEndpoints({ componentId: component.guid, sortBy: 'p95', limit: 10 });
const { data } = await client.listDeploys({ componentId: component.guid, limit: 5 });
const trends = await client.getLatencyTrends({ componentId: component.guid, duration: 86_400 });
const detail = await client.getEndpointDetail({ componentId: component.guid, endpoint: endpoints[0]!.name });
const tree = condenseTraceTree(buildTraceTree(detail.trace)!); // { title, startMs, durationMs, selfMs, children, … }
const { digests } = traceSourceRefs(tree);
const located = locateTraceTree(tree, await client.getSourceLocations({ componentId: component.guid, digests }));
// located.children[0].locations → [{ name: 'app/models/user.rb', line: 12, inApp: true, … }]
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
| GET | `www.skylight.io/source_locations?filter[id]={component}:{digest},…` | session | source location names (JSON:API) |
| GET | `www.skylight.io/deploys/{id}` | session | one deploy, e.g. a trace annotation's deploy ref |
| GET | `www.skylight.io/trends_intervals?filter[app_component_id]={component}` | session | weekly Trends periods |

- Trends: `step` must be 60, 600, or 3600, and `step × count` summed over all ranges must be at most 7 days.
  Longer windows take several requests.
- Summary: the name keeps its `<sk-segment>…</sk-segment>` suffix and must be percent-encoded. An unknown name
  returns 200 with `count: 0`, not 404.
- Trace, decoded 2026-09-25 from the Skylight UI and its frontend code (types: `TraceNode`, `TraceSpan`):
  - `trace.targets` are 10 ms latency buckets that samples were drawn from.
  - Each node is `[parent index, category, title, description, spans]`; the description is the SQL for queries.
  - Each span holds one node's timing within one target: start and duration in ms, relative to the parent.
  - A span also carries allocations and `[deploy ref, source]` pairs, where the source is `digest:line` for app code
    and a bare `digest` for gems. The UI shows them as the deploy's git sha and a `file.rb:line`.
- Source locations, found in Skylight's frontend and verified 2026-09-25:
  - Ids are `{component guid}:{digest}`; a bare digest matches nothing. Several ids go in one comma-separated
    `filter[id]`, and must be URL-encoded because digests can contain `+`. Unknown ids are left out of the result.
  - `name` is an app file path, a gem name, or `<synthetic>` for events without source.
  - The deploy ref resolves through `/deploys/{id}`; its `git_sha` is what the UI shows.
  - Three span fields are still unknown.
- Latencies are in milliseconds, confirmed against the UI (typical response = p50, problem response = p95).
- Q-digest nodes are `[lower, level, count]`, counting samples in `[lower, lower + 2^level)`.
- Upstream returns full lists; `limit` is applied client-side.
- Retention: data goes back to Monday 00:00 UTC six weeks before the current week (about 7 weeks). Older windows
  return 200 with no endpoints, not an error. Verified 2026-09-25.
- Skylight's own Trends report (`/trends_reports/{component};{timestamp}`) answers 401 to an MCP session. It needs a
  web login, so `report` rebuilds it from the APIs above.

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
| `/source_locations` or `/trends_intervals` without a filter | 400 | empty |
| `/trends_reports/…`, `/apps/{id}`, or `/github/commit` with an MCP session token | 401 | empty |
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

Move the `[Unreleased]` entries in `CHANGELOG.md` under the new version, then push a `v*` tag. `.github/workflows/publish.yml` builds, tests, and publishes through npm trusted publishing
(OIDC), with provenance. No npm token is stored in GitHub.

```sh
npm version minor   # bumps package.json and creates the v* tag
git push --follow-tags
```

## License

MIT
