/**
 * Test stub for the `server-only` package.
 *
 * `server-only` throws by design when it is imported outside a React Server Component graph,
 * which is the behaviour we want in the application. Vitest runs plain Node with no such graph,
 * so importing a route handler that transitively touches Prisma would fail before a single
 * assertion ran. Aliasing the package to this empty module in `vitest.config.mts` keeps the
 * guard intact in the app and makes the module importable in tests.
 *
 * It is only ever substituted under test — nothing in `next build` resolves this file.
 */
export {};