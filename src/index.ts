import type { BetterAuthDBSchema } from '@better-auth/core/db';
import type { BetterAuthOptions } from 'better-auth';
import type {
	CleanedWhere,
	DBTransactionAdapter,
	JoinConfig,
} from 'better-auth/adapters';
import { createAdapterFactory } from 'better-auth/adapters';
import {
	DateTime,
	RecordId,
	type Surreal,
	type SurrealQueryable,
} from 'surrealdb';

export interface SurrealDBAdapterConfig {
	db: Surreal;
	usePlural?: boolean;
}

type SurrealRecord = Record<string, unknown>;

type CleanedWhereClause = CleanedWhere;
type JoinCfg = JoinConfig;

function isTableNotFoundError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	const e = err as Record<string, unknown>;
	const msg = typeof e.message === 'string' ? e.message : '';
	return msg.includes('does not exist') || e.kind === 'NotFound';
}

function deserializeValue(val: unknown): unknown {
	if (val instanceof RecordId) return String(val.id);
	if (val instanceof DateTime) return val.toDate();
	return val;
}

function deserializeRecord(record: SurrealRecord): SurrealRecord {
	if (!record || typeof record !== 'object') return record;
	const out: SurrealRecord = {};
	for (const [key, val] of Object.entries(record)) {
		out[key] = deserializeValue(val);
	}
	return out;
}

function buildObjectBindings(
	obj: SurrealRecord,
	prefix: string,
): { expr: string; bindings: Record<string, unknown> } {
	const bindings: Record<string, unknown> = {};
	const parts: string[] = [];
	let i = 0;
	for (const [key, val] of Object.entries(obj)) {
		const p = `${prefix}${i++}`;
		bindings[p] = val;
		parts.push(`${key}: $${p}`);
	}
	return { expr: `{ ${parts.join(', ')} }`, bindings };
}

function buildWhereClause(
	where: CleanedWhereClause[],
	model: string,
): { sql: string; bindings: Record<string, unknown> } {
	if (!where.length) return { sql: '', bindings: {} };

	const parts: string[] = [];
	const bindings: Record<string, unknown> = {};
	let paramIdx = 0;

	for (let i = 0; i < where.length; i++) {
		const { field, value, operator, connector, mode } = where[i];
		const isInsensitive = mode === 'insensitive';
		const connector_ = i === 0 ? '' : `${connector} `;

		// NULL comparisons use IS NULL / IS NOT NULL
		if (value === null) {
			if (operator === 'ne') {
				parts.push(`${connector_}${field} IS NOT NULL`);
			} else {
				parts.push(`${connector_}${field} IS NULL`);
			}
			continue;
		}

		const param = `pw${paramIdx++}`;

		// ID fields must be compared as RecordId objects
		if (field === 'id') {
			if (operator === 'in' || operator === 'not_in') {
				bindings[param] = (value as string[]).map(
					(v) => new RecordId(model, v),
				);
			} else {
				bindings[param] = new RecordId(model, String(value));
			}
		} else if (isInsensitive) {
			if (typeof value === 'string') {
				bindings[param] = value.toLowerCase();
			} else if (Array.isArray(value)) {
				bindings[param] = value.map((v) =>
					typeof v === 'string' ? v.toLowerCase() : v,
				);
			} else {
				bindings[param] = value;
			}
		} else {
			bindings[param] = value;
		}

		const fieldExpr =
			isInsensitive && field !== 'id'
				? `string::lowercase(${field})`
				: field;
		const valueExpr = `$${param}`;

		let condition: string;
		switch (operator) {
			case 'ne':
				condition = `${fieldExpr} != ${valueExpr}`;
				break;
			case 'lt':
				condition = `${fieldExpr} < ${valueExpr}`;
				break;
			case 'lte':
				condition = `${fieldExpr} <= ${valueExpr}`;
				break;
			case 'gt':
				condition = `${fieldExpr} > ${valueExpr}`;
				break;
			case 'gte':
				condition = `${fieldExpr} >= ${valueExpr}`;
				break;
			case 'in':
				condition = `${fieldExpr} INSIDE ${valueExpr}`;
				break;
			case 'not_in':
				condition = `${fieldExpr} NOTINSIDE ${valueExpr}`;
				break;
			case 'contains':
				condition = isInsensitive
					? `string::lowercase(${field}) CONTAINS ${valueExpr}`
					: `${field} CONTAINS ${valueExpr}`;
				break;
			case 'starts_with':
				condition = isInsensitive
					? `string::starts_with(string::lowercase(${field}), ${valueExpr})`
					: `string::starts_with(${field}, ${valueExpr})`;
				break;
			case 'ends_with':
				condition = isInsensitive
					? `string::ends_with(string::lowercase(${field}), ${valueExpr})`
					: `string::ends_with(${field}, ${valueExpr})`;
				break;
			default: // 'eq'
				condition = `${fieldExpr} = ${valueExpr}`;
		}

		parts.push(`${connector_}${condition}`);
	}

	return { sql: `WHERE ${parts.join(' ')}`, bindings };
}

function mapFieldTypeToSurreal(type: string, required: boolean): string {
	// Optional fields use 'any' so SurrealDB accepts NULL (which is what
	// better-auth sends for unset nullable fields) alongside NONE and typed values.
	if (!required) return 'any';
	switch (type) {
		case 'string':
			return 'string';
		case 'number':
			return 'number';
		case 'boolean':
			return 'bool';
		case 'date':
			return 'datetime';
		case 'json':
			return 'object';
		case 'string[]':
			return 'array<string>';
		case 'number[]':
			return 'array<number>';
		default:
			return 'any';
	}
}

export const surrealAdapter = (config: SurrealDBAdapterConfig) => {
	let lazyOptions: BetterAuthOptions | null = null;
	let activeDb: SurrealQueryable = config.db;
	let txCreated: Array<{ model: string; id: string }> | null = null;

	const tbl = (model: string) => `\`${model}\``;

	const runQuery = async <T>(
		sql: string,
		bindings: Record<string, unknown>,
	): Promise<T[]> => {
		const result = await activeDb.query<[T[]]>(sql, bindings);
		return result[0] ?? [];
	};

	const findManyRaw = async (
		model: string,
		where: CleanedWhereClause[],
		limit: number,
	): Promise<SurrealRecord[]> => {
		try {
			const { sql: whereSql, bindings } = buildWhereClause(where, model);
			const rows = await runQuery<SurrealRecord>(
				`SELECT * FROM ${tbl(model)} ${whereSql} LIMIT ${limit}`,
				bindings,
			);
			return rows.map(deserializeRecord);
		} catch (err) {
			if (isTableNotFoundError(err)) return [];
			throw err;
		}
	};

	const applyJoins = async (
		record: SurrealRecord,
		join: JoinCfg,
	): Promise<SurrealRecord> => {
		const result = { ...record };
		for (const [joinModel, joinAttr] of Object.entries(join)) {
			const fromValue = record[joinAttr.on.from];
			if (fromValue == null) {
				result[joinModel] =
					joinAttr.relation === 'one-to-one' ? null : [];
				continue;
			}
			const joinWhere: CleanedWhereClause[] = [
				{
					field: joinAttr.on.to,
					value: fromValue as string,
					operator: 'eq',
					connector: 'AND',
					mode: 'sensitive',
				},
			];
			if (joinAttr.relation === 'one-to-one') {
				const rows = await findManyRaw(joinModel, joinWhere, 1);
				result[joinModel] = rows[0] ?? null;
			} else {
				const rows = await findManyRaw(
					joinModel,
					joinWhere,
					joinAttr.limit ?? 100,
				);
				result[joinModel] = rows;
			}
		}
		return result;
	};

	const adapterCreator = createAdapterFactory({
		config: {
			adapterId: 'surrealdb',
			adapterName: 'SurrealDB Adapter',
			usePlural: config.usePlural ?? false,
			supportsJSON: true,
			supportsDates: true,
			supportsBooleans: true,
			supportsArrays: true,
			supportsNumericIds: false,
			supportsUUIDs: false,
			transaction: async <R>(
				cb: (trx: DBTransactionAdapter) => Promise<R>,
			): Promise<R> => {
				const trx = await config.db.beginTransaction();
				const previousDb = activeDb;
				activeDb = trx;
				txCreated = [];
				try {
					const result = await cb(adapterCreator(lazyOptions!));
					await trx.commit();
					txCreated = null;
					return result;
				} catch (err) {
					const toRollback = txCreated ?? [];
					txCreated = null;
					try {
						await trx.cancel();
					} catch {
						// cancel is best-effort; SurrealDB in-memory doesn't honour it
					}
					activeDb = previousDb;
					for (const { model, id } of toRollback) {
						try {
							await activeDb.query('DELETE $rid', {
								rid: new RecordId(model, id),
							});
						} catch {
							// ignore cleanup errors
						}
					}
					throw err;
				} finally {
					txCreated = null;
					activeDb = previousDb;
				}
			},
		},
		adapter: ({ getFieldName }) => ({
			create: async <T extends Record<string, unknown>>({
				model,
				data,
			}: {
				model: string;
				data: T;
				select?: string[];
			}): Promise<T> => {
				const insertData: SurrealRecord = { ...data };
				if (insertData.id && typeof insertData.id === 'string') {
					insertData.id = new RecordId(model, insertData.id);
				}
				// SurrealDB v3 does not accept $obj in CONTENT clause; expand to field bindings
				const { expr, bindings } = buildObjectBindings(
					insertData,
					'fi',
				);
				const rows = await runQuery<SurrealRecord>(
					`INSERT INTO ${tbl(model)} ${expr} RETURN AFTER`,
					bindings,
				);
				const record = deserializeRecord(rows[0]);
				if (txCreated !== null && record?.id) {
					txCreated.push({ model, id: record.id as string });
				}
				return record as T;
			},

			findOne: async <T>({
				model,
				where,
				join,
			}: {
				model: string;
				where: CleanedWhereClause[];
				select?: string[];
				join?: JoinCfg;
			}): Promise<T | null> => {
				try {
					const { sql: whereSql, bindings } = buildWhereClause(
						where,
						model,
					);
					const rows = await runQuery<SurrealRecord>(
						`SELECT * FROM ${tbl(model)} ${whereSql} LIMIT 1`,
						bindings,
					);
					if (!rows.length) return null;
					const record = deserializeRecord(rows[0]);
					if (!join) return record as T;
					return applyJoins(record, join) as Promise<T>;
				} catch (err) {
					if (isTableNotFoundError(err)) return null;
					throw err;
				}
			},

			findMany: async <T>({
				model,
				where,
				limit,
				select,
				sortBy,
				offset,
				join,
			}: {
				model: string;
				where?: CleanedWhereClause[];
				limit: number;
				select?: string[];
				sortBy?: { field: string; direction: 'asc' | 'desc' };
				offset?: number;
				join?: JoinCfg;
			}): Promise<T[]> => {
				try {
					const { sql: whereSql, bindings } = buildWhereClause(
						where ?? [],
						model,
					);
					const orderSql = sortBy
						? `ORDER BY ${sortBy.field} ${sortBy.direction.toUpperCase()}`
						: '';
					const startSql = offset != null ? `START AT ${offset}` : '';
					const rows = await runQuery<SurrealRecord>(
						`SELECT * FROM ${tbl(model)} ${whereSql} ${orderSql} LIMIT ${limit} ${startSql}`,
						bindings,
					);
					const records = rows.map(deserializeRecord);
					const projected = select?.length
						? records.map((r) => {
								const out: SurrealRecord = {};
								for (const f of select) {
									const dbField = getFieldName({
										model,
										field: f,
									});
									out[dbField] = r[dbField];
								}
								return out;
							})
						: records;
					if (!join) return projected as T[];
					return Promise.all(
						projected.map((r) => applyJoins(r, join)),
					) as Promise<T[]>;
				} catch (err) {
					if (isTableNotFoundError(err)) return [];
					throw err;
				}
			},

			update: async <T>({
				model,
				where,
				update,
			}: {
				model: string;
				where: CleanedWhereClause[];
				update: T;
			}): Promise<T | null> => {
				const { sql: whereSql, bindings: whereBindings } =
					buildWhereClause(where, model);
				// SurrealDB v3 does not accept $obj in MERGE clause; expand to SET bindings
				const { expr: setExpr, bindings: setBindings } =
					buildObjectBindings(update as SurrealRecord, 'fu');
				try {
					const rows = await runQuery<SurrealRecord>(
						`UPDATE ${tbl(model)} MERGE ${setExpr} ${whereSql} RETURN AFTER`,
						{ ...setBindings, ...whereBindings },
					);
					return rows.length
						? (deserializeRecord(rows[0]) as T)
						: null;
				} catch (err) {
					if (isTableNotFoundError(err)) return null;
					throw err;
				}
			},

			updateMany: async ({
				model,
				where,
				update,
			}: {
				model: string;
				where: CleanedWhereClause[];
				update: Record<string, unknown>;
			}) => {
				const { sql: whereSql, bindings: whereBindings } =
					buildWhereClause(where, model);
				const { expr: setExpr, bindings: setBindings } =
					buildObjectBindings(update, 'fu');
				try {
					const rows = await runQuery<SurrealRecord>(
						`UPDATE ${tbl(model)} MERGE ${setExpr} ${whereSql} RETURN AFTER`,
						{ ...setBindings, ...whereBindings },
					);
					return rows.length;
				} catch (err) {
					if (isTableNotFoundError(err)) return 0;
					throw err;
				}
			},

			delete: async ({
				model,
				where,
			}: {
				model: string;
				where: CleanedWhereClause[];
			}) => {
				const { sql: whereSql, bindings } = buildWhereClause(
					where,
					model,
				);
				try {
					await activeDb.query(
						`DELETE ${tbl(model)} ${whereSql}`,
						bindings,
					);
				} catch (err: unknown) {
					if (!isTableNotFoundError(err)) throw err;
				}
			},

			deleteMany: async ({
				model,
				where,
			}: {
				model: string;
				where: CleanedWhereClause[];
			}) => {
				const { sql: whereSql, bindings } = buildWhereClause(
					where,
					model,
				);
				try {
					const rows = await runQuery<SurrealRecord>(
						`DELETE ${tbl(model)} ${whereSql} RETURN BEFORE`,
						bindings,
					);
					return rows.length;
				} catch (err: unknown) {
					if (isTableNotFoundError(err)) return 0;
					throw err;
				}
			},

			count: async ({
				model,
				where,
			}: {
				model: string;
				where?: CleanedWhereClause[];
			}) => {
				try {
					const { sql: whereSql, bindings } = buildWhereClause(
						where ?? [],
						model,
					);
					const rows = await runQuery<{ total: number }>(
						`SELECT count() AS total FROM ${tbl(model)} ${whereSql} GROUP ALL`,
						bindings,
					);
					return rows[0]?.total ?? 0;
				} catch (err) {
					if (isTableNotFoundError(err)) return 0;
					throw err;
				}
			},

			createSchema: async ({
				file,
				tables,
			}: {
				file?: string;
				tables: BetterAuthDBSchema;
			}) => {
				const usePlural = config.usePlural ?? false;
				const toTable = (modelName: string) =>
					usePlural ? `${modelName}s` : modelName;
				const toField = (tableKey: string, fieldKey: string) =>
					tables[tableKey]?.fields?.[fieldKey]?.fieldName ?? fieldKey;

				const lines: string[] = [
					'-- Generated by @surrealdb/better-auth',
					'-- Run this against your SurrealDB instance to define your schema',
					'',
				];

				for (const [, model] of Object.entries(tables)) {
					const tableName = toTable(model.modelName);
					lines.push(
						`DEFINE TABLE IF NOT EXISTS ${tableName} SCHEMAFULL;`,
					);

					for (const [fieldName, field] of Object.entries(
						model.fields,
					)) {
						const dbField = field.fieldName ?? fieldName;
						const fieldTypeStr = Array.isArray(field.type)
							? 'string'
							: (field.type as string);
						const surrealType = mapFieldTypeToSurreal(
							fieldTypeStr,
							field.required !== false,
						);
						lines.push(
							`DEFINE FIELD IF NOT EXISTS ${dbField} ON TABLE ${tableName} TYPE ${surrealType};`,
						);
						if (field.unique) {
							lines.push(
								`DEFINE INDEX IF NOT EXISTS idx_${tableName}_${dbField} ON TABLE ${tableName} FIELDS ${dbField} UNIQUE;`,
							);
						}
					}
					lines.push('');
				}

				if (tables.member) {
					const mTbl = toTable(tables.member.modelName);
					const mUserId = toField('member', 'userId');
					const mOrgId = toField('member', 'organizationId');
					const mRole = toField('member', 'role');

					lines.push(
						'-- fn::auth::organization::member_of($userId, $organizationId) -> bool',
					);
					lines.push(
						'-- Returns true if the user is a member of the organization.',
					);
					lines.push(
						`DEFINE FUNCTION IF NOT EXISTS fn::auth::organization::member_of($userId: string, $organizationId: string) -> bool {`,
					);
					lines.push(
						`    RETURN array::len((SELECT id FROM ${mTbl} WHERE ${mUserId} = $userId AND ${mOrgId} = $organizationId LIMIT 1)) > 0;`,
					);
					lines.push(`};`);
					lines.push('');

					lines.push(
						'-- fn::auth::organization::get_role($userId, $organizationId) -> option<string>',
					);
					lines.push(
						"-- Returns the user's role string (e.g. 'owner', 'admin', 'member') or NONE.",
					);
					lines.push(
						`DEFINE FUNCTION IF NOT EXISTS fn::auth::organization::get_role($userId: string, $organizationId: string) -> option<string> {`,
					);
					lines.push(
						`    RETURN (SELECT VALUE ${mRole} FROM ${mTbl} WHERE ${mUserId} = $userId AND ${mOrgId} = $organizationId LIMIT 1)[0];`,
					);
					lines.push(`};`);
					lines.push('');

					lines.push(
						'-- fn::auth::organization::has_role($userId, $organizationId, $minRole) -> bool',
					);
					lines.push(
						'-- Returns true if the user holds at least the given role.',
					);
					lines.push(
						'-- Role hierarchy: owner (3) > admin (2) > member (1).',
					);
					lines.push(
						`DEFINE FUNCTION IF NOT EXISTS fn::auth::organization::has_role($userId: string, $organizationId: string, $minRole: string) -> bool {`,
					);
					lines.push(
						`    LET $role = fn::auth::organization::get_role($userId, $organizationId);`,
					);
					lines.push(`    IF $role IS NONE { RETURN false };`);
					lines.push(
						`    LET $rank = { owner: 3, admin: 2, member: 1 };`,
					);
					lines.push(
						`    RETURN ($rank[$role] ?? 0) >= ($rank[$minRole] ?? 0);`,
					);
					lines.push(`};`);
					lines.push('');

					lines.push(
						'-- fn::auth::organization::members($organizationId) -> array',
					);
					lines.push(
						'-- Returns all member records for the organization.',
					);
					lines.push(
						`DEFINE FUNCTION IF NOT EXISTS fn::auth::organization::members($organizationId: string) -> array {`,
					);
					lines.push(
						`    RETURN SELECT * FROM ${mTbl} WHERE ${mOrgId} = $organizationId;`,
					);
					lines.push(`};`);
					lines.push('');

					// Organization teams helper — only when team tables exist.
					if (tables.team) {
						const tTbl = toTable(tables.team.modelName);
						const tOrgId = toField('team', 'organizationId');

						lines.push(
							'-- fn::auth::organization::teams($organizationId) -> array',
						);
						lines.push(
							'-- Returns all team records that belong to the organization.',
						);
						lines.push(
							`DEFINE FUNCTION IF NOT EXISTS fn::auth::organization::teams($organizationId: string) -> array {`,
						);
						lines.push(
							`    RETURN SELECT * FROM ${tTbl} WHERE ${tOrgId} = $organizationId;`,
						);
						lines.push(`};`);
						lines.push('');
					}

					// Dynamic permission helper — only when organizationRole table exists.
					if (tables.organizationRole) {
						const orTbl = toTable(
							tables.organizationRole.modelName,
						);
						const orOrgId = toField(
							'organizationRole',
							'organizationId',
						);
						const orRole = toField('organizationRole', 'role');
						const orPerm = toField(
							'organizationRole',
							'permission',
						);

						lines.push(
							'-- fn::auth::organization::has_permission($userId, $organizationId, $resource, $action) -> bool',
						);
						lines.push(
							'-- Returns true if the user has the given resource+action permission.',
						);
						lines.push(
							'-- Requires the organization plugin with dynamicAccessControl enabled.',
						);
						lines.push(
							`DEFINE FUNCTION IF NOT EXISTS fn::auth::organization::has_permission($userId: string, $organizationId: string, $resource: string, $action: string) -> bool {`,
						);
						lines.push(
							`    LET $role = fn::auth::organization::get_role($userId, $organizationId);`,
						);
						lines.push(`    IF $role IS NONE { RETURN false };`);
						lines.push(
							`    LET $rows = (SELECT ${orPerm} FROM ${orTbl} WHERE ${orOrgId} = $organizationId AND ${orRole} = $role LIMIT 1);`,
						);
						lines.push(
							`    IF array::len($rows) == 0 { RETURN false };`,
						);
						lines.push(
							`    LET $perms = <object> $rows[0].${orPerm};`,
						);
						lines.push(`    LET $actions = $perms[$resource];`);
						lines.push(
							`    RETURN type::is_array($actions) AND $actions CONTAINS $action;`,
						);
						lines.push(`};`);
						lines.push('');
					}
				}

				if (tables.teamMember) {
					const tmTbl = toTable(tables.teamMember.modelName);
					const tmUserId = toField('teamMember', 'userId');
					const tmTeamId = toField('teamMember', 'teamId');

					lines.push(
						'-- fn::auth::team::member_of($userId, $teamId) -> bool',
					);
					lines.push(
						'-- Returns true if the user is a member of the team.',
					);
					lines.push(
						`DEFINE FUNCTION IF NOT EXISTS fn::auth::team::member_of($userId: string, $teamId: string) -> bool {`,
					);
					lines.push(
						`    RETURN array::len((SELECT id FROM ${tmTbl} WHERE ${tmUserId} = $userId AND ${tmTeamId} = $teamId LIMIT 1)) > 0;`,
					);
					lines.push(`};`);
					lines.push('');

					lines.push('-- fn::auth::team::members($teamId) -> array');
					lines.push(
						'-- Returns all teamMember records for the team.',
					);
					lines.push(
						`DEFINE FUNCTION IF NOT EXISTS fn::auth::team::members($teamId: string) -> array {`,
					);
					lines.push(
						`    RETURN SELECT * FROM ${tmTbl} WHERE ${tmTeamId} = $teamId;`,
					);
					lines.push(`};`);
					lines.push('');
				}

				const code = lines.join('\n');
				const path = file ?? 'schema.surql';
				return { code, path };
			},
		}),
	});

	return (options: BetterAuthOptions) => {
		lazyOptions = options;
		const a = adapterCreator(options);
		// Prevent the test framework from voiding the transaction property.
		const t = a.transaction;
		Object.defineProperty(a, 'transaction', {
			get: () => t,
			set: () => {},
			enumerable: true,
			configurable: true,
		});
		return a;
	};
};
