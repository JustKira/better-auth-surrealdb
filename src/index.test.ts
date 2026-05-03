import {
	authFlowTestSuite,
	caseInsensitiveTestSuite,
	joinsTestSuite,
	normalTestSuite,
	testAdapter,
	transactionsTestSuite,
	uuidTestSuite,
} from '@better-auth/test-utils/adapter';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { organization } from 'better-auth/plugins/organization';
import { RecordId, Surreal, Table } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { surrealAdapter } from './index';

const SURREAL_URL = 'ws://127.0.0.1:4321/rpc';
const SURREAL_NS = 'test';
const SURREAL_DB = 'test';

async function waitForReady(url: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const probe = new Surreal();
			await probe.connect(url);
			await probe.close();
			return;
		} catch {
			await new Promise<void>((r) => setTimeout(r, 100));
		}
	}
	throw new Error(
		`SurrealDB server did not become ready within ${timeoutMs}ms`,
	);
}

const server: ChildProcess = spawn(
	'surreal',
	[
		'start',
		'memory',
		'--bind',
		'127.0.0.1:4321',
		'--unauthenticated',
		'--no-banner',
	],
	{ stdio: 'ignore', detached: false },
);

await waitForReady(SURREAL_URL);

const db = new Surreal();
await db.connect(SURREAL_URL);
await db.use({ namespace: SURREAL_NS, database: SURREAL_DB });

// ─── Schema helper function tests ────────────────────────────────────────────
//
// Run BEFORE the adapter suite so they complete before onFinish kills the server.
// Uses an isolated namespace (fn_test) to avoid cross-contamination.

describe('SurrealDB Adapter', () => {
	describe('schema helper functions', () => {
		const fnDb = new Surreal();

		// Stable IDs used across all sub-tests
		const orgId = 'org_alpha';
		const org2Id = 'org_beta';
		const userAlice = 'user_alice';
		const userBob = 'user_bob';
		const userCarol = 'user_carol';
		const teamId = 'team_red';
		const team2Id = 'team_blue';

		beforeAll(async () => {
			await fnDb.connect(SURREAL_URL);
			await fnDb.use({ namespace: 'fn_test', database: 'fn_test' });

			// Build org-plugin tables via getAuthTables (avoids a full betterAuth() boot).
			const _ = await import('@better-auth/core/db');
			const orgPlugin = organization({
				teams: { enabled: true },
				// biome-ignore lint/suspicious/noExplicitAny: test-only cast
			} as any);
			// biome-ignore lint/suspicious/noExplicitAny: minimal options for schema discovery
			const fakeOptions = { plugins: [orgPlugin] } as any;

			// Generate schema DDL (tables + helper functions) via our createSchema.
			const adapter = surrealAdapter({ db: fnDb });
			// biome-ignore lint/suspicious/noExplicitAny: createSchema not in public types
			const schema = (await (adapter(fakeOptions) as any).createSchema?.(
				null,
				'schema.surql',
			)) as { code: string } | undefined;

			if (schema?.code) {
				// Execute the full DDL as a single query so SurrealDB can correctly
				// parse DEFINE FUNCTION bodies that contain internal semicolons.
				await fnDb.query(schema.code);
			}

			// Verify expected content in generated DDL
			expect(schema?.code).toContain('fn::auth::organization::member_of');
			expect(schema?.code).toContain('fn::auth::organization::get_role');
			expect(schema?.code).toContain('fn::auth::organization::has_role');
			expect(schema?.code).toContain('fn::auth::organization::members');
			expect(schema?.code).toContain('fn::auth::organization::teams');
			expect(schema?.code).toContain('fn::auth::team::member_of');
			expect(schema?.code).toContain('fn::auth::team::members');
			// Table names must be pluralized (usePlural defaults to true)
			expect(schema?.code).toContain(
				'DEFINE TABLE IF NOT EXISTS members',
			);
			expect(schema?.code).toContain('DEFINE TABLE IF NOT EXISTS teams');
			expect(schema?.code).toContain(
				'DEFINE TABLE IF NOT EXISTS teamMembers',
			);

			// ── Seed test data ────────────────────────────────────────────────

			for (const [id, name, slug] of [
				[orgId, 'Alpha Corp', 'alpha'],
				[org2Id, 'Beta LLC', 'beta'],
			] as const) {
				await fnDb.query(
					`INSERT INTO organizations { id: $id, name: $name, slug: $slug, createdAt: time::now() }`,
					{ id: new RecordId('organizations', id), name, slug },
				);
			}

			// alice=owner, bob=admin, carol=member in org_alpha; alice=member in org_beta
			for (const [mid, userId, organizationId, role] of [
				['mem_1', userAlice, orgId, 'owner'],
				['mem_2', userBob, orgId, 'admin'],
				['mem_3', userCarol, orgId, 'member'],
				['mem_4', userAlice, org2Id, 'member'],
			] as const) {
				await fnDb.query(
					`INSERT INTO members { id: $id, userId: $userId, organizationId: $oid, role: $role, createdAt: time::now() }`,
					{
						id: new RecordId('members', mid),
						userId,
						oid: organizationId,
						role,
					},
				);
			}

			// Two teams in org_alpha; nothing in org_beta
			for (const [tid, name] of [
				[teamId, 'Red Team'],
				[team2Id, 'Blue Team'],
			] as const) {
				await fnDb.query(
					`INSERT INTO teams { id: $id, name: $name, organizationId: $oid, createdAt: time::now() }`,
					{ id: new RecordId('teams', tid), name, oid: orgId },
				);
			}

			// alice + bob in red team; carol in blue team
			for (const [tmid, userId, tid] of [
				['tm_1', userAlice, teamId],
				['tm_2', userBob, teamId],
				['tm_3', userCarol, team2Id],
			] as const) {
				await fnDb.query(
					`INSERT INTO teamMembers { id: $id, userId: $userId, teamId: $tid, createdAt: time::now() }`,
					{ id: new RecordId('teamMembers', tmid), userId, tid },
				);
			}
		}, 30_000);

		afterAll(async () => {
			await fnDb.close();
		});

		// ── fn::auth::organization::member_of ────────────────────────────────────────

		describe('fn::auth::organization::member_of', () => {
			it('returns true when user is a member', async () => {
				const [r] = await fnDb.query<[boolean]>(
					'RETURN fn::auth::organization::member_of($u, $o)',
					{ u: userAlice, o: orgId },
				);
				expect(r).toBe(true);
			});

			it('returns false when user is not a member of that org', async () => {
				const [r] = await fnDb.query<[boolean]>(
					'RETURN fn::auth::organization::member_of($u, $o)',
					{ u: userBob, o: org2Id },
				);
				expect(r).toBe(false);
			});

			it('returns false for unknown user', async () => {
				const [r] = await fnDb.query<[boolean]>(
					'RETURN fn::auth::organization::member_of($u, $o)',
					{ u: 'nobody', o: orgId },
				);
				expect(r).toBe(false);
			});
		});

		// ── fn::auth::organization::get_role ─────────────────────────────────────────

		describe('fn::auth::organization::get_role', () => {
			it('returns the correct role for each member', async () => {
				for (const [userId, oid, expected] of [
					[userAlice, orgId, 'owner'],
					[userBob, orgId, 'admin'],
					[userCarol, orgId, 'member'],
					[userAlice, org2Id, 'member'],
				] as const) {
					const [role] = await fnDb.query<[string]>(
						'RETURN fn::auth::organization::get_role($u, $o)',
						{ u: userId, o: oid },
					);
					expect(role).toBe(expected);
				}
			});

			it('returns null/none when user is not a member', async () => {
				const [role] = await fnDb.query<[null | undefined]>(
					'RETURN fn::auth::organization::get_role($u, $o)',
					{ u: userCarol, o: org2Id },
				);
				expect(role == null).toBe(true);
			});
		});

		// ── fn::auth::organization::has_role ─────────────────────────────────────────

		describe('fn::auth::organization::has_role', () => {
			it('owner satisfies has_role("owner")', async () => {
				const [r] = await fnDb.query<[boolean]>(
					'RETURN fn::auth::organization::has_role($u, $o, $m)',
					{ u: userAlice, o: orgId, m: 'owner' },
				);
				expect(r).toBe(true);
			});

			it('owner satisfies has_role("admin") — senior covers junior', async () => {
				const [r] = await fnDb.query<[boolean]>(
					'RETURN fn::auth::organization::has_role($u, $o, $m)',
					{ u: userAlice, o: orgId, m: 'admin' },
				);
				expect(r).toBe(true);
			});

			it('admin does NOT satisfy has_role("owner")', async () => {
				const [r] = await fnDb.query<[boolean]>(
					'RETURN fn::auth::organization::has_role($u, $o, $m)',
					{ u: userBob, o: orgId, m: 'owner' },
				);
				expect(r).toBe(false);
			});

			it('member does NOT satisfy has_role("admin")', async () => {
				const [r] = await fnDb.query<[boolean]>(
					'RETURN fn::auth::organization::has_role($u, $o, $m)',
					{ u: userCarol, o: orgId, m: 'admin' },
				);
				expect(r).toBe(false);
			});

			it('non-member returns false for every role level', async () => {
				const [r] = await fnDb.query<[boolean]>(
					'RETURN fn::auth::organization::has_role($u, $o, $m)',
					{ u: userCarol, o: org2Id, m: 'member' },
				);
				expect(r).toBe(false);
			});
		});

		// ── fn::auth::organization::members ──────────────────────────────────────────
		// Use array::len() in SurrealQL to avoid JS destructuring inconsistencies
		// when SurrealDB returns a single record vs an array.

		describe('fn::auth::organization::members', () => {
			it('returns 3 member records for org_alpha', async () => {
				const [n] = await fnDb.query<[number]>(
					'RETURN array::len(fn::auth::organization::members($o))',
					{ o: orgId },
				);
				expect(n).toBe(3);
			});

			it('returns 1 member record for org_beta', async () => {
				const [n] = await fnDb.query<[number]>(
					'RETURN array::len(fn::auth::organization::members($o))',
					{ o: org2Id },
				);
				expect(n).toBe(1);
			});

			it('returns 0 for unknown org', async () => {
				const [n] = await fnDb.query<[number]>(
					'RETURN array::len(fn::auth::organization::members($o))',
					{ o: 'org_unknown' },
				);
				expect(n).toBe(0);
			});
		});

		// ── fn::auth::organization::teams ────────────────────────────────────────────

		describe('fn::auth::organization::teams', () => {
			it('returns 2 team records for org_alpha', async () => {
				const [n] = await fnDb.query<[number]>(
					'RETURN array::len(fn::auth::organization::teams($o))',
					{ o: orgId },
				);
				expect(n).toBe(2);
			});

			it('returns 0 when org has no teams', async () => {
				const [n] = await fnDb.query<[number]>(
					'RETURN array::len(fn::auth::organization::teams($o))',
					{ o: org2Id },
				);
				expect(n).toBe(0);
			});
		});

		// ── fn::auth::team::member_of ────────────────────────────────────────────────

		describe('fn::auth::team::member_of', () => {
			it('returns true when user is in the team', async () => {
				const [r] = await fnDb.query<[boolean]>(
					'RETURN fn::auth::team::member_of($u, $t)',
					{ u: userAlice, t: teamId },
				);
				expect(r).toBe(true);
			});

			it('returns false when user is not in that team', async () => {
				const [r] = await fnDb.query<[boolean]>(
					'RETURN fn::auth::team::member_of($u, $t)',
					{ u: userCarol, t: teamId },
				);
				expect(r).toBe(false);
			});

			it('returns false for unknown user', async () => {
				const [r] = await fnDb.query<[boolean]>(
					'RETURN fn::auth::team::member_of($u, $t)',
					{ u: 'nobody', t: teamId },
				);
				expect(r).toBe(false);
			});
		});

		// ── fn::auth::team::members ──────────────────────────────────────────────────

		describe('fn::auth::team::members', () => {
			it('returns 2 teamMember records for red team', async () => {
				const [n] = await fnDb.query<[number]>(
					'RETURN array::len(fn::auth::team::members($t))',
					{ t: teamId },
				);
				expect(n).toBe(2);
			});

			it('returns 1 teamMember record for blue team', async () => {
				const [n] = await fnDb.query<[number]>(
					'RETURN array::len(fn::auth::team::members($t))',
					{ t: team2Id },
				);
				expect(n).toBe(1);
			});

			it('returns empty array for unknown team', async () => {
				const [n] = await fnDb.query<[number]>(
					'RETURN array::len(fn::auth::team::members($t))',
					{ t: 'team_unknown' },
				);
				expect(n).toBe(0);
			});
		});
	});
});

// ─── Adapter suite ─────────────────────────────────────────────────────────────

const { execute } = await testAdapter({
	adapter: async (_options) => surrealAdapter({ db }),
	runMigrations: async (_options) => {
		const info =
			await db.query<[{ tables: Record<string, unknown> }]>(
				'INFO FOR DB',
			);
		const tables = Object.keys(info?.[0]?.tables ?? {});
		for (const table of tables) {
			await db.query('DELETE $table', { table: new Table(table) });
		}
	},
	tests: [
		normalTestSuite(),
		uuidTestSuite(),
		transactionsTestSuite(),
		joinsTestSuite(),
		caseInsensitiveTestSuite(),
		authFlowTestSuite(),
	],
	onFinish: async () => {
		await db.close();
		server.kill('SIGTERM');
	},
});

execute();
