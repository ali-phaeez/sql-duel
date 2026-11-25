# SQL Duel

A party game for 2 to 8 players who like SQL. Everyone in the room sees the same small tables and the
same **target** result table. Write the `SELECT` that produces the target. First correct answer wins the
most points, and the shortest correct query gets a bonus.

Runs on Cloudflare Workers with one Durable Object per room. No accounts, no install for players:
open the page on a phone or laptop, pick a nickname, share the 4-letter room code.

## How to play

1. One player creates a room and shares the code (or the link `https://<host>/ABCD`).
2. Friends join with the code. The host picks **5, 8 or 12 rounds** and a **difficulty** (easy, mixed or hard), then starts.
3. Each round shows a short question ("Which customers ordered more than twice?"), 1 to 3 tables and the target result.
4. Type a query. The **live preview** runs it in your browser as you type and shows the result or the error.
5. Submit with the button or **Ctrl/Cmd + Enter**. The server checks it against the target.

**Matching.** Your result must have the same number of columns and the same rows as the target.
Column names do not matter. Row order only matters when the round says **order matters**.

**Scoring per round**

| | points |
|---|---|
| first correct | 5 |
| second correct | 3 |
| every later correct | 1 |
| shortest correct query (ties all get it) | +1 |

Query length is counted after trimming and collapsing every run of whitespace to one space.
Wrong tries are allowed (at most one try every 2 seconds) and everyone sees how many you made at the end of the round.

A round lasts 90 seconds, or ends as soon as every connected player has solved it. The round-end screen shows
everyone's correct query, time and points. After the last round you get the leaderboard, and the host can start
another game in the same room.

## Run it locally

Needs Node.js 22 or newer.

```sh
npm ci
npm run dev          # http://localhost:8797
```

`npm run dev` starts `wrangler dev`, which first runs `npm run build` to copy the SQL engine into
`public/engine/` for the browser. Everything works offline after `npm ci`: no CDN, no web fonts.

Open the page in two browser windows (or a normal and a private window) to play against yourself.

## Tests

```sh
npm test             # unit tests: engine, puzzle pack, room rules (node --test)
npm run typecheck    # two TypeScript projects: Worker sources, and Node-side tests/tools
npm run test:e2e     # Playwright + Chromium against wrangler dev on port 8797
```

The e2e config starts `wrangler dev` itself (or reuses one already running on port 8797).
Run the same specs against a deployed copy with `BASE_URL=https://sql-duel.<you>.workers.dev npm run test:e2e`.
If Chromium is missing: `npx playwright install chromium`.

## Deploy

```sh
npx wrangler login
npm run deploy
```

The Durable Object class uses SQLite-backed storage, which the Workers free plan supports.
`npm run tail` streams live logs.

## Architecture

```
public/            static client (plain JS module, no framework, no bundler)
  index.html  style.css  app.js
  engine/          emitted from src/sql by `npm run build` (git-ignored)
src/
  index.ts         Worker: POST /api/rooms, GET /api/rooms/:code, /ws/:code -> room, /ABCD short links
  room.ts          RoomDO: one Durable Object per room; WebSockets (hibernation API), storage, alarms
  game.ts          room rules as pure functions: players, rounds, scoring, snapshots
  protocol.ts      constants and message types shared by the Worker and the tests
  puzzles.ts       pack types, validation, public puzzle view, puzzle picking
  codes.ts         room codes
  sql/             the SQL engine (shared by the server and the browser)
puzzles/pack.json  the puzzle pack
tools/             build-pack.ts (fills targets), sql.ts (author CLI)
test/              unit tests (*.test.ts) and Playwright specs (e2e/)
```

- **One Durable Object per room**, addressed by the room code. The room state is one JSON value in
  `ctx.storage`, written after every change, so a room survives restarts and hibernation. An alarm is set
  for the next deadline (end of round, next round, lobby clean-up, idle expiry).
- **Rules are pure.** `src/game.ts` never reads the clock or does I/O; `room.ts` calls
  `advance(state, now)`, applies the message, persists and broadcasts. That keeps the rules unit-testable.
- **Private data stays on the server.** The puzzle pack is bundled into the Worker. Players receive a
  public view of the puzzle (tables, target, story); the reference answers are never sent. While a round
  runs, other players see who solved it and when, never the query. Each socket gets its own snapshot, so
  your own query comes back after a reload.
- **Reconnects.** The session (room code, player id, secret) is kept in `localStorage`; reloading the page
  resumes the same player with the same score. A player who drops counts as present for 15 seconds, so a
  reload never ends a round early. Opening the room in a second tab takes over, and the first tab says so.
- **Clean-up.** Players who leave the lobby are removed after a minute. A room with no open connection for
  one hour is deleted.

## The SQL engine

`src/sql/` is a small SQL engine written for this game: tokenizer, recursive-descent parser to an AST,
and an evaluator over in-memory tables. Pure TypeScript, no dependencies.

Why its own engine instead of a real database:

- **Safety.** Player SQL must never touch the room's storage. The engine only ever sees the puzzle's tables,
  copied into memory, and it only knows `SELECT`.
- **Live preview.** The exact same code runs in the browser while you type, so the preview and the server's
  verdict always agree.
- **Hard limits.** Every query has a size limit, a row limit and a step limit, so no query can hang a room or
  eat its CPU time.

### Supported subset

```
SELECT [DISTINCT] expr [AS alias], ... | * | t.*
FROM t [[AS] a] [, t2 [[AS] b] ...] [[INNER] JOIN t3 [[AS] c] ON expr ...]
[WHERE expr]
[GROUP BY expr, ...]
[HAVING expr]
[ORDER BY expr|alias|column-number [ASC|DESC], ...]
[LIMIT n [OFFSET m]]
```

- Expressions: integer and decimal literals, `'strings'` (with `''` for a quote), `NULL`, `col`, `t.col`,
  `+ - * / %`, unary minus, `||`, `= == != <> < <= > >=`, `AND OR NOT`, `LIKE` (`%` and `_`), `IN (list)`,
  `BETWEEN ... AND ...`, `IS NULL`, `IS NOT NULL`, `NOT LIKE / NOT IN / NOT BETWEEN`, parentheses.
- Functions: `count(*)`, `count(expr)`, `count(DISTINCT expr)`, `sum`, `avg`, `min`, `max`
  (`DISTINCT` works in all of them), `lower`, `upper`, `length`, `abs`, `round(x[, n])`, `coalesce(a, b, ...)`.
- Keywords and identifiers are case-insensitive. `"double quoted"` names are allowed and are never keywords
  (use them for a column called `"order"`).
- Column aliases need `AS`; table aliases may leave it out. A `SELECT` alias can be used in `ORDER BY`
  (not in `WHERE` or `GROUP BY`). `SELECT` without `FROM` evaluates once (`SELECT 1 + 1`).
- `--` and `/* */` comments are allowed. One statement per query; a trailing `;` is fine.
- Errors say what is wrong and where: `near "FORM" at 1:10: expected FROM, a comma, or AS before an alias`,
  `no such column "nme" at 1:8`.

### Value model

Kept deliberately simple. **Values are JavaScript numbers, strings or NULL.**

- Numbers are JavaScript numbers (64-bit floats). There is no separate integer type: `7 / 2` is `3.5`,
  and `0.1 + 0.2` is `0.30000000000000004`. Division or `%` by zero gives NULL.
- Comparisons give `1` (true) or `0` (false), so `sum(score >= 80)` counts rows.
- Text compares by UTF-16 code unit (`'B' < 'a'`). `LIKE` ignores case.
- Arithmetic on text is an error (no silent conversion). `=` and `!=` between a number and text are simply
  false and true; `<`, `>` and friends between a number and text are an error. `||` turns numbers into text.
- SQL NULL rules: NULL in arithmetic or a comparison gives NULL, `AND`/`OR`/`NOT` use three-valued logic, and
  `WHERE`, `HAVING` and `ON` keep a row only when the condition is true. Aggregates skip NULLs; `count(*)` does
  not. `sum`/`avg`/`min`/`max` of no values is NULL.
- For `GROUP BY`, `DISTINCT` and result matching, NULL equals NULL and a number never equals text.
- `ORDER BY` sorts NULL first, then numbers, then text (reversed with `DESC`); ties keep their earlier order.
- `round` rounds half away from zero. In a grouped query every bare column must be in `GROUP BY` (or inside an
  aggregate).

### Not supported

`LEFT`/`RIGHT`/`FULL`/`CROSS`/`NATURAL` joins, `USING`, subqueries, `UNION`/`INTERSECT`/`EXCEPT`, `WITH`,
`CASE`, `CAST`, `EXISTS`, window functions, `LIKE ... ESCAPE`, dates and times, booleans as a separate type,
scientific notation in literals, and anything that is not a `SELECT`. These words give an error that names
them (`LEFT is not supported in SQL Duel`).

### Limits

| limit | value |
|---|---|
| query text | 2,000 characters |
| intermediate rows (after each join step) | 10,000 |
| evaluation steps | 200,000 |
| expression nesting | 100 levels |

Going over any limit is a clear error, never a hang. Long `LIKE` work is charged to the step limit too.

## Adding puzzles

Puzzles live in `puzzles/pack.json`. Each one has:

```json
{
  "id": "shop-regulars",
  "title": "The regulars",
  "difficulty": "medium",
  "story": "Which customers ordered more than twice? Show their names.",
  "ordered": false,
  "tables": [
    { "name": "customers", "columns": ["id", "name"], "rows": [[1, "Nora"], [2, "Omar"]] },
    { "name": "orders", "columns": ["id", "customer_id", "total"], "rows": [[1, 1, 20], [2, 1, 35], [3, 1, 12], [4, 2, 8]] }
  ],
  "answer": "SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name HAVING count(*) > 2",
  "target": { "columns": ["name"], "rows": [["Nora"]] }
}
```

1. Add the puzzle **without** a `target` (or with an old one): 1 to 3 tables, lower-case names, values that are
   numbers, strings or `null`. Avoid SQL keywords as column names.
2. Try queries against it while you write:
   ```sh
   npm run sql -- puzzles/pack.json shop-regulars                      # show tables and target
   npm run sql -- puzzles/pack.json shop-regulars "SELECT * FROM orders"
   ```
3. Run `npm run puzzles`. It checks every puzzle and writes each `target` by running the reference `answer`
   through the engine. **Never type a target by hand.** It refuses a puzzle when:
   - the answer fails or returns no rows,
   - the result changes when the table rows are reordered (a tie under `ORDER BY` or `LIMIT`), or
   - a target column is named after an expression (`count(*)` would give the answer away: use `AS`).
4. Run `npm test`. One test runs every reference answer and compares it with the stored target.

Tips: set `"ordered": true` only when the story asks for an order, and make the order unique. Prefer prices
like `2.25` or `3.5` that add up exactly in floating point, or round in the answer and say so in the story.
A game of 12 rounds needs at least 12 puzzles of the chosen difficulty (easy and hard games top up with medium).
