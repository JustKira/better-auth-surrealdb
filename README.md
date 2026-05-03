# @surrealdb/better-auth

A [BetterAuth](https://better-auth.com) database adapter for [SurrealDB](https://surrealdb.com). Supports all BetterAuth plugins, schema generation, transactions, and every WHERE operator out of the box.

## Prerequisites

- SurrealDB 3.x
- BetterAuth 1.6.x
- Node.js 18+ or Bun 1.x

## Installation

```bash
# Bun
bun add @surrealdb/better-auth better-auth surrealdb

# npm
npm install @surrealdb/better-auth better-auth surrealdb

# pnpm
pnpm add @surrealdb/better-auth better-auth surrealdb
```

## Quick Start

```typescript
import { betterAuth } from 'better-auth';
import { Surreal } from 'surrealdb';
import { surrealAdapter } from '@surrealdb/better-auth';

const db = new Surreal();
await db.connect('ws://localhost:8000/rpc');
await db.use({ namespace: 'namespace', database: 'database' });

export const auth = betterAuth({
    database: surrealAdapter({ db }),
    emailAndPassword: { enabled: true },
});
```

That's it. BetterAuth manages all table operations through the adapter.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `db` | `Surreal` | required | A connected SurrealDB client instance |
| `usePlural` | `boolean` | `false` | Use plural table names (`users` instead of `user`) |

```typescript
surrealAdapter({
    db,
    usePlural: true, // use plural table names
})
```

## Connecting to SurrealDB

The adapter accepts any connected `Surreal` instance. Connect before passing it:

```typescript
import { Surreal } from 'surrealdb';

const db = new Surreal();

// WebSocket (recommended for persistent servers)
await db.connect('ws://localhost:8000/rpc', {
    namespace: 'myapp',
    database: 'production',
    authentication: {
        username: 'root',
        password: 'root',
    },
});

// HTTP (for stateless environments)
await db.connect('http://localhost:8000', {
    namespace: 'myapp',
    database: 'production',
});
```

## Schema Generation

The adapter includes a `createSchema` implementation that generates SurrealQL DDL statements for all BetterAuth tables. Use the BetterAuth CLI to produce a `schema.surql` file:

```bash
bunx @better-auth/cli generate --output schema.surql
```

Then apply it to your SurrealDB instance:

```bash
surreal import --conn http://localhost:8000 \
    --ns myapp --db production \
    --user root --pass root \
    schema.surql
```

The generated schema uses `SCHEMAFULL` tables with `DEFINE FIELD` and `DEFINE INDEX` statements for unique constraints. Running it with `IF NOT EXISTS` clauses makes it safe to reapply.

## SurrealDB Helper Functions

When you use the `organization` plugin (with or without the `teams` option), schema generation also emits a set of `fn::*` SurrealQL functions you can call directly in your own queries, rules, and permissions.

### `fn::auth::organization::*`

These functions are emitted when the `organization` plugin is active.

| Function | Signature | Returns | Description |
|---|---|---|---|
| `fn::auth::organization::member_of` | `(userId: string, organizationId: string)` | `bool` | True if the user is a member of the organization |
| `fn::auth::organization::get_role` | `(userId: string, organizationId: string)` | `option<string>` | The member's role (`"owner"`, `"admin"`, `"member"`), or NONE if not a member |
| `fn::auth::organization::has_role` | `(userId: string, organizationId: string, minRole: string)` | `bool` | True if the user's role is equal to or senior to `minRole` (owner > admin > member) |
| `fn::auth::organization::members` | `(organizationId: string)` | `array` | All `members` records for the organization |
| `fn::auth::organization::teams` | `(organizationId: string)` | `array` | All `teams` records for the organization (requires `teams: { enabled: true }`) |
| `fn::auth::organization::has_permission` | `(userId: string, organizationId: string, resource: string, action: string)` | `bool` | True if the user's role has a custom permission for the given resource and action (requires `organizationRole` table) |

**Examples:**

```surql
-- Check if a user belongs to an organization
IF fn::auth::organization::member_of($userId, $organizationId) {
    -- allow access
};

-- Require at least admin-level access
IF fn::auth::organization::has_role($userId, $organizationId, "admin") {
    -- perform privileged operation
};

-- Get a user's role string
LET $role = fn::auth::organization::get_role($userId, $organizationId);

-- List all members
LET $members = fn::auth::organization::members($organizationId);
```

### `fn::auth::team::*`

These functions are emitted when `teams: { enabled: true }` is set on the `organization` plugin.

| Function | Signature | Returns | Description |
|---|---|---|---|
| `fn::auth::team::member_of` | `(userId: string, teamId: string)` | `bool` | True if the user is a member of the team |
| `fn::auth::team::members` | `(teamId: string)` | `array` | All `teamMembers` records for the team |

**Examples:**

```surql
-- Check team membership
IF fn::auth::team::member_of($userId, $teamId) {
    -- allow team-scoped access
};

-- List all team members
LET $members = fn::auth::team::members($teamId);
```

These functions are defined with `IF NOT EXISTS`, so re-running the generated schema is safe.

## Transactions

Transaction support is built in. BetterAuth uses transactions internally for operations that need atomicity (for example, creating a session alongside a user record).

```typescript
// BetterAuth handles this automatically.
// If you need manual transaction access:
const adapter = surrealAdapter({ db })(options);
await adapter.transaction(async (trx) => {
    await trx.create({ model: 'user', data: { ... } });
    await trx.create({ model: 'session', data: { ... } });
});
```

Transactions use `SurrealDB.beginTransaction()` under the hood. If any operation inside the callback throws, the transaction is cancelled and changes are discarded.

## Using Plugins

The adapter works with all BetterAuth plugins. Pass them in the `plugins` array as usual:

```typescript
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins/organization';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { admin } from 'better-auth/plugins/admin';
import { Surreal } from 'surrealdb';
import { surrealAdapter } from '@surrealdb/better-auth';

const db = new Surreal();
await db.connect('ws://localhost:8000/rpc');
await db.use({ namespace: 'myapp', database: 'production' });

export const auth = betterAuth({
    database: surrealAdapter({ db }),
    plugins: [
        organization(),
        twoFactor(),
        admin(),
    ],
});
```

Each plugin may add new tables. Re-run schema generation after adding plugins to get the updated DDL.

## SurrealDB Table Names

By default the adapter uses singular table names: `user`, `session`, `verification`, `account`. Set `usePlural: true` to use plural names instead.

BetterAuth lets you override model names per-table via the `modelName` option in your config. The adapter respects those overrides automatically.

## Running Tests

The test suite starts an in-memory SurrealDB server, runs all BetterAuth adapter test suites against it, then shuts down.

```bash
# Requires the surreal CLI to be on your PATH
bun test
```

The `surreal` binary is available at `https://surrealdb.com/install`. On macOS with Homebrew:

```bash
brew install surrealdb/tap/surreal
```

## License

Apache-2.0
