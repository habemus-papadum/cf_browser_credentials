# @habemus-papadum/cf-creds-motherduck

MotherDuck in the browser with broker-minted read-scaling tokens. A MotherDuck
token is a **session credential** in this kit's taxonomy — minutes to a year,
reusable, revocable — so the browser side is the plain `CredentialManager`
typed to the MotherDuck envelope, plus an **engine holder** over
`@motherduck/wasm-client`, because the token is consumed by a DuckDB instance
rather than by a fetch.

`@motherduck/wasm-client` is the stock duckdb-wasm build (1.5.5-r.1 vendors
`@duckdb/duckdb-wasm@1.33.1-dev64.0`, byte-identical binaries) with the
MotherDuck extension installed at boot. The engine it boots is one ordinary
`AsyncDuckDB`: the tab's own `memory` catalog beside the attached MotherDuck
databases, one statement able to read both (dual execution). That is the
instance Mosaic's stock `wasmConnector` drives, unchanged.

Peers (optional): `@motherduck/wasm-client`, `apache-arrow` (the client's own peer).

## Worker route

The broker's `/api/credentials/motherduck` route resolves the site's key to a
lane — a MotherDuck **service account** (whose Duckling size and read-scaling
flock are the tier) and a TTL — and mints a read-scaling token through the
REST API with the organization admin's token held as a worker secret:

```ts
// POST https://api.motherduck.com/v1/users/<serviceAccount>/tokens
//   { name: <visitor identity>, ttl: <seconds, 300..31536000>, token_type: "read_scaling" }
// → { id, token, expire_at }   (the secret is returned once)
return Response.json({ token, expiration: expire_at, serviceAccount }, { headers });
```

The token's `name` carries the Access identity, so MotherDuck's token list and
`QUERY_HISTORY` attribute each mint to a visitor; `DELETE .../tokens/<id>`
revokes one. A `name` is **required** (1–255 characters; the API has no
anonymous or unnamed token, and the only other credential it mints, a Dive
embed session, is not a DuckDB token) and **unique among the account's live
tokens**: a second mint under a live name answers `409 CONFLICT` ("A token with
that name already exists"); revocation frees the name at once and expiry within
minutes. A visitor's second tab or refresh is therefore a second live token
under the same identity, so the route suffixes the identity with the mint time
(`alice@example.com#m3k9…`) rather than naming the visitor alone. Compute is a property of the account, never of the token, so a
different tier for a different audience is a different service account in the
grant, not a different token type.

## Browser

```ts
import { createMotherDuckCredentialManager, motherDuckEngine } from "@habemus-papadum/cf-creds-motherduck";
import { wasmConnector } from "@uwdata/mosaic-core";

// The page names only itself; the route answers with the token.
const manager = createMotherDuckCredentialManager({
  base: "https://creds.example.com",
  key: "notes",
});

// The engine: built on first ready(), from whatever token the manager holds then.
const engine = motherDuckEngine(manager, {
  sessionName: "notes-visitor",
  customUserAgent: "notes/1.0",
});
const { db, connect } = await engine.ready();

// Mosaic over the same instance — the stock connector, the stock decode.
coordinator().databaseConnector(wasmConnector({ duckdb: db, connection: await connect() }));

// Dual execution: a local table joined to a cloud table in one statement.
const agent = await connect();
await agent.query(`CREATE TABLE picks AS SELECT * FROM (VALUES ('north'), ('south')) t(region)`);
await agent.query(`SELECT r.region, count(*) FROM shop.main.orders r JOIN picks USING (region) GROUP BY 1`);
```

A dev page with an injected token uses `staticMotherDuckToken(token)` as the
source; nothing else changes.

## Rotation, measured

Two facts (2026-09-24, wasm-client 1.5.5-r.1, headless Chrome, a read-scaling
token of a service account with a Standard flock) decide how the holder treats
rotation:

1. **The token is consumed at connect, once.** The client configures the
   extension with `SET motherduck_token` during initialization and the setting
   is sealed afterwards: `SET motherduck_token` answers "can only be set during
   initialization"; `DETACH` of the workspace is refused for read-only
   credentials; `ATTACH 'md:'` says the databases are already attached. There
   is no in-place swap.
2. **A live session outlives its token.** Revoking the token the session was
   created with did not stop remote queries, hybrid joins, or the tab's local
   tables; a session created with a 5-minute token kept answering, polled
   every 20 s, for 8 minutes (3 past expiry); and a session left idle for
   6.5 minutes — past expiry and past the flock's 60 s cooldown, so a replica
   had to wake — answered its next remote query in 700 ms with its local
   tables intact. The extension holds a session, not the token.

So a token's lifetime only has to cover the connect, the manager's job is a
fresh token *at hand* for the next (re)build, and the engine is rebuilt
(`terminateDuckDB` + create, which **drops the tab's local tables**) only when
the app decides: an explicit `engine.rebuild()`, typically when a remote query
reports a dead session (`isMotherDuckAuthError`), at a moment the app can
re-materialize afterwards. `onRebuild` hands the new handle over so Mosaic can
be re-wired. `rebuildOnRotate: true` restores eager rebuilding for an app with
nothing local to lose.

`accessMode: "read_only"` is refused up front: it governs the tab's own
in-memory DuckDB (which cannot open read-only) — the read-scaling token is what
makes the cloud side read-only.

## Two more rules, measured the same day

- **`MD_ALL_DATABASES()` under duckdb-wasm's blocking `RUN_QUERY` protocol
  wedges the whole engine** — `connection.query()` (and Mosaic's `runQuery`)
  never returns from it, alone, every time, and every connection on the engine
  hangs with it (one worker, one queue). The same statement on the same raw
  connection through the pending-query protocol (`connection.send()`) answers
  in about 200 ms, and that is the path the client's own connection
  (`handle.connection.evaluateQuery`) rides under its sequencer.
  `md_user_info()`, `md_live_duckling_size()`, `duckdb_databases()`,
  `information_schema.*`, `DESCRIBE` and table scans are fine either way. Keep
  Mosaic on a raw connection (its SQL never calls `md_*`); run free-form SQL —
  anything a person or a model types — through the client's connection. The
  record (the probes, the two protocols, the choices if revisited) is the aiui
  docs' duckdb-mosaic guide, Part 4b, "The RUN_QUERY wedge":
  <https://habemus-papadum.github.io/pdum_aiui/packages/aiui-viz/duckdb-mosaic>.
- **A cloud table reaches a vgplot mark through a local view**, not a qualified
  name: `from("db.main.t")` quotes one identifier and `from(["db","main","t"])`
  is spread into three tables and cross-joined. `CREATE OR REPLACE VIEW t AS
  SELECT * FROM "db"."main"."t"` in the tab's catalog copies nothing and pushes
  the scan down.

## Mosaic pre-aggregation, measured

Over a 766 k-row remote table through a local view, with two linked
histograms and a crossfilter selection: Mosaic's `PreAggregator` created its
cube as `memory.mosaic.preagg_…` in 59 ms — dual execution ran the group-by on
the Duckling and downloaded the cube — and every brush afterwards was a local
query over the cube, 4 to 8 ms, with no cloud round trip. Leave pre-aggregation
on.
