# Notes for Claude Code

- The `test-data` MCP server (see `.mcp.json`) builds fresh users, carts and orders in the Practice Shop.
  Start the app first: `npm run app` (http://127.0.0.1:3100).
- When writing a Playwright test, use the fixtures in `e2e/fixtures.ts` (`user`, `makeUser`, `loginAs`).
  Build the state a test needs with `makeUser({...})`, never by clicking through setup in the UI.
- One fresh user per test. Never log in as the seed users (`demo`, `locked_demo`) in tests.
- `npm run typecheck`, `npm run test:unit` (library + MCP server), `npx playwright test` (UI).
- Test data tools only work against hosts in `TEST_DATA_ALLOWED_HOSTS` (localhost by default). Never widen that to production.
