# How it works

A walk through the pieces, in the order a request travels: agent → MCP server → test data library →
the app. Then the design choices, and some exercises.

## 1. What MCP actually is

MCP (Model Context Protocol) is a standard way for an AI agent to call your code. The agent (the
**client**, e.g. Claude Code) starts your **server** as a child process and they exchange JSON
messages (JSON-RPC 2.0), one per line, over the process's stdin and stdout.

A server can offer three kinds of things:

| Kind | Who decides to use it | Here |
|---|---|---|
| **Tools** | The agent, when it thinks they help | `create_test_user`, `cleanup_test_data`, ... |
| **Resources** | The agent or the user, to read context | `test-data://products`, `test-data://guide` |
| **Prompts** | The user, as a ready-made task | `test_with_fresh_data` |

Because stdout carries the protocol, **a server must never print to stdout**: one stray
`console.log` corrupts the stream. This server logs to stderr (`console.error`).

## 2. A real exchange

Captured from this server (`>>>` from the agent, `<<<` from the server; lines shortened):

```text
>>> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1"}}}
<<< {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{...},"resources":{...},"prompts":{...}},"serverInfo":{"name":"test-data","version":"0.1.0"}}}

>>> {"jsonrpc":"2.0","method":"notifications/initialized"}

>>> {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_test_user","arguments":{"label":"demo","cart":["backpack"],"card":"expired"}}}
<<< {"jsonrpc":"2.0","id":2,"result":{
      "content":[{"type":"text","text":"Created user demo_mcpzxad_1 (password: 8AxNrYyn, id: e31ed677-...).\nStatus: active. Card expires 01/20.\nCart: 1 item(s). Past orders: 0. ..."}],
      "structuredContent":{"id":"e31ed677-...","username":"demo_mcpzxad_1","password":"8AxNrYyn","status":"active","cardExpiry":"01/20","cartItems":1,"orderIds":[]}}}

>>> {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cleanup_test_data","arguments":{}}}
<<< {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Deleted 1 test user(s)."}]}}
```

What to notice:

- **The handshake.** `initialize` agrees on a protocol version and says what the server can do;
  `notifications/initialized` (no `id`, so no reply) says the client is ready.
- **`id` pairs each reply with its request.** Several calls can be in flight at once.
- **Two forms of the same result.** `content` is text for the model to read; `structuredContent` is
  typed data (checked against the tool's `outputSchema`) for code to use without parsing text.
- Before calling, a client normally asks `tools/list`; each tool comes with its description and a
  JSON Schema of its inputs, generated here from the zod schemas. **The description is what the
  model reads to decide when to use the tool**, so it's written for the model, not for people.

## 3. Inside the server (`src/mcp/server.ts`)

Each tool is registered with a name, a description, an input schema, optional output schema and
**annotations**, then a handler:

```ts
server.registerTool('cleanup_test_data', {
  description: 'Delete test users ... It can never delete another test run\'s fresh data ...',
  inputSchema: {
    scope: z.enum(['session', 'my_sessions', 'abandoned']).optional(),
    older_than_minutes: z.number().int().min(60).optional(),
  },
  annotations: { destructiveHint: true, idempotentHint: true },
}, async ({ scope, older_than_minutes }) => run(() => client.cleanup(/* mapped scope */), (n) => `Deleted ${n} test user(s).`));
```

- **Validation comes free:** a call with a product id that isn't in the enum is rejected before the
  handler runs.
- **Annotations are hints to the client:** `destructiveHint: true` lets Claude Code ask you before
  running it; `readOnlyHint: true` marks safe lookups.
- **Errors are results, not crashes.** `run()` turns a failure into `{ isError: true, content: [...] }`
  with a plain message ("Can't reach the app ... Is it running? Try: npm run app"), so the agent can
  read it and fix the problem itself.
- **The handler is thin.** All the real work is in `TestDataClient`, which the Playwright fixtures use
  too. One place knows how to build data.

## 4. The test data library (`src/core/test-data.ts`)

A **recipe** describes the data a test needs; the client builds it with a few API calls:

```ts
await testData.createUser({ label: 'regular', cart: ['backpack'], orders: 3, card: 'expired' });
// POST /api/test-data/users         (user, tagged, unique name)
// POST /api/test-data/users/:id/cart
// POST /api/test-data/users/:id/orders  x 3
```

Every user gets the tags `test-data`, `run:<runId>` and `owner:<who>` (and `group:<id>` for a
Playwright run). That one decision is what makes cleanup safe: `cleanup('run')` asks the app for users
tagged with *this* run and deletes only those, so it works even after a crash.

| Cleanup scope | Deletes | Used by |
|---|---|---|
| `'run'` | What this client created | each Playwright worker, each agent session |
| `'group'` | What any worker of this Playwright run created | global teardown |
| `'owner'` | What this owner created in any run | an agent's "my_sessions" |
| `{ olderThanMinutes }` | Any test data older than the cutoff (15 min minimum) | an agent's "abandoned" |

There is deliberately **no "delete everything"**: that would remove data another run is still using.
And the app enforces the last line of defence itself: its test data API refuses to delete any user
not tagged `test-data`, whoever calls it.

Two more safety details live in the client: run ids are **random** (an earlier clock-based id repeated
every ~28 minutes and made sessions collide), and it **never follows redirects**, so the admin key
can't be carried to a host that isn't on the allow-list.

## 5. The Playwright side (`e2e/fixtures.ts`)

| Fixture | Scope | What it does |
|---|---|---|
| `testData` | worker | One client per worker, owner `playwright-w<N>`; cleans its run when the worker ends |
| `makeUser` | test | Builds users from recipes; deletes each one when the test ends, pass or fail |
| `user` | test | `makeUser()` with no options: a plain fresh user |
| `loginAs` | test | Logs in through the real login form |

Plus `globalSetup`, which gives the whole run one group id (workers inherit it through
`process.env`), and `globalTeardown`, a safety net that removes this run's leftovers only. Another
run sharing the same app, a teammate's or another CI shard's, is never touched. Cleanup problems
other than "already gone" show up as test annotations instead of being swallowed.

The test then spends its time only on the behaviour it checks. Setup that isn't under test goes
through the API.

## 6. Design choices, and the trade-offs

| Choice | Why | Trade-off |
|---|---|---|
| A demo app inside the repo | Runs anywhere, including CI, with nothing external; the test data API is under our control | Real apps rarely have a test data API; often you build one with the developers, or seed the database directly |
| One fresh user per test | Parallel-safe by design (see the shared-user experiment: 4/4 failed) | More data to create; fine when creation takes milliseconds |
| Tags instead of a local list of created ids | Cleanup survives crashes and restarts | The app has to store and filter by tags |
| Host allow-list in the client, plus rules in the app | The client stops bad targets early; the app enforces what may be deleted, whoever calls | Must be set per environment (`TEST_DATA_ALLOWED_HOSTS`) |
| No "delete everything" cleanup | Shared environments have other runs' data in use | Truly orphaned data needs the age-based scope |
| stdio transport | Simplest; the agent starts the server, no ports or auth | One client per server process. For a shared team server you'd use the HTTP transport |

## 7. Exercises

1. **Watch the protocol yourself.** Run `npm run inspect`, connect, open *Tools*, and call
   `create_test_user` with `{"orders": 2}`. Then read `test-data://guide` under *Resources*.
2. **Add a tool.** Add `lock_user(user_id)`: a `PATCH /api/test-data/users/:id` route in
   `demo-app/server.ts`, a `lockUser()` method in the client, then `registerTool` it. Add a test in
   `test/mcp.test.ts` that the tool is listed and works.
3. **Add a recipe option.** Support `recipe.name` in the login test so the header shows a custom
   name, and assert it.
4. **Break the rules on purpose.** Point `TEST_DATA_BASE_URL` at `https://example.com` and start the
   server: read the refusal. Then remove a tag in `createUser` and watch the cleanup tests fail.
5. **Make it a team server.** Swap `StdioServerTransport` for the SDK's Streamable HTTP transport,
   so several people or agents share one server. Think about what then needs authentication.
6. **Try it on a real app.** Pick a practice app with an API (e.g. Restful-Booker): write a second
   `TestDataClient` for it, keep the same tools, and see how much of the server changes (very little).
