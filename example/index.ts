import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins/admin';
import { anonymous } from 'better-auth/plugins/anonymous';
import { bearer } from 'better-auth/plugins/bearer';
import { magicLink } from 'better-auth/plugins/magic-link';
import { multiSession } from 'better-auth/plugins/multi-session';
import { organization } from 'better-auth/plugins/organization';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { username } from 'better-auth/plugins/username';
import { Surreal } from 'surrealdb';

// In production use: '@surrealdb/better-auth';
import { surrealAdapter } from '../src/index';

const db = new Surreal();

await db.connect('ws://localhost:8000/rpc');
await db.use({ namespace: 'myapp', database: 'production' });

export const auth = betterAuth({
	secret: process.env.BETTER_AUTH_SECRET!,
	baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
	emailAndPassword: { enabled: true },
	plugins: [
		organization({
			teams: { enabled: true },
			dynamicAccessControl: { enabled: true },
		}),
		twoFactor(),
		admin(),
		bearer(),
		username(),
		magicLink({
			sendMagicLink: async ({ email, url }) => {
				// send email with magic link url
			},
		}),
		anonymous(),
		multiSession(),
	],
	database: surrealAdapter({ db }),
});
