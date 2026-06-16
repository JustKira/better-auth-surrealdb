# 🔒 Security Policy

`@surrealdb/better-auth` is the official [BetterAuth](https://better-auth.com) database
adapter for [SurrealDB](https://surrealdb.com). Because this package sits on the
authentication path of the applications that use it, we take its security — and the
security of its dependencies — very seriously.

## Supported Versions

This adapter is pre-`1.0`, so the public API may still change between minor releases.
Security fixes are applied to the latest released `0.x` minor; older versions are not
maintained. Once a `1.0` release is published, this table will be updated to reflect
the stable support window.

| Version   | Supported |
| --------- | --------- |
| < 0.1.0   | ❌        |
| >= 0.1.0  | ✅        |

## Reporting a Vulnerability

If you believe you have found a security vulnerability in `@surrealdb/better-auth`, we
encourage you to let us know right away. We will investigate all legitimate reports and
do our best to quickly fix the problem.

Please report any issues or vulnerabilities via [GitHub Security
Advisories](https://github.com/surrealdb-dev/better-auth/security/advisories) instead of
posting a public issue in GitHub. You can also send security communications to
[security@surrealdb.com](mailto:security@surrealdb.com).

To help us triage quickly, please include:

- The adapter version (run `npm ls @surrealdb/better-auth`, or check your lockfile).
- The `better-auth` and `surrealdb` versions, and the SurrealDB server version, in use.
- A description of the vulnerability and a minimal, reproducible example showing how it
  can be exploited.

### Do

- ✅ Privately disclose the details of any potential vulnerability to SurrealDB.
- ✅ Provide enough information to reproduce the vulnerability in your report.
- ✅ Ask permission from SurrealDB before running automated security tools against any
  SurrealDB-operated infrastructure.

### Do Not

- ❌ Disclose the details of the vulnerability publicly or to third parties.
- ❌ Exploit a vulnerability beyond what is strictly necessary to verify its existence.
- ❌ Run automated security tools against SurrealDB infrastructure without permission.

### Our Responsibility

- Acknowledge your report within 3 business days of the date of communication.
- Verify the issue and keep you informed of the progress toward its resolution.
- Handle your report and any data you share with us with strict confidentiality.
- Abstain from legal action against you for any report made following this policy.
- Credit you in any relevant public security advisory, unless you desire otherwise.

## Security Advisories

SurrealDB strives to provide timely and clear communication regarding any security issues
that may impact users of this adapter, using [GitHub Security
Advisories](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/creating-a-repository-security-advisory)
and other available communication channels. Generally, vulnerabilities will be discussed
and [resolved
privately](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/collaborating-in-a-temporary-private-fork-to-resolve-a-repository-security-vulnerability)
to minimize the risk of exploitation. Security advisories will generally be published once
a version of `@surrealdb/better-auth` including a fix for the relevant vulnerability is
available on [npm](https://www.npmjs.com/package/@surrealdb/better-auth). The goal of
publishing security advisories is to notify users of the risks involved with using a
vulnerable version and to provide information for resolving the issue or implementing any
possible workarounds.

Vulnerabilities in third-party dependencies (for example, `better-auth` or `surrealdb`)
will not be re-published by SurrealDB when an advisory already exists for the upstream
package, since security tooling (e.g. `npm audit`, GitHub Dependabot) will already be able
to track it up the dependency tree. We will, however, release an updated adapter version
that bumps the affected dependency whenever a fix is available.

## Security Updates

As with any other update, security updates to `@surrealdb/better-auth` are released
following [Semantic Versioning (AKA SemVer)](https://semver.org).

While the adapter is in its `0.x` series, urgent security fixes are released as patch
releases (e.g. `0.1.0` to `0.1.1`) and we encourage updating as soon as one is available.
We will avoid breaking the public API in a patch release so that applying a security patch
remains low-risk. Larger or API-affecting security changes may be included in a minor
release (e.g. `0.1.x` to `0.2.0`); these will always be clearly stated in the release
notes.

After `1.0`, we commit to not breaking API backward compatibility in patch releases so
that users have no reservations that may cause delays when applying security patches.

## Security Automation

### Dependencies

`@surrealdb/better-auth` keeps a deliberately small runtime dependency footprint
(`better-auth` and `surrealdb`) to minimize exposure. Dependencies are continuously
monitored for known vulnerabilities using GitHub's [Dependabot
alerts](https://docs.github.com/en/code-security/dependabot/dependabot-alerts/about-dependabot-alerts).
Maintainers are expected to update, replace, or acknowledge any vulnerable dependency as
part of the review process for every pull request.

### Supply chain

Releases are published to npm with [build
provenance](https://docs.npmjs.com/generating-provenance-statements) (`npm publish
--provenance`) so that consumers can cryptographically verify that a given package version
was built from this repository's source via its CI workflow. All third-party GitHub
Actions used in CI and release workflows are pinned to immutable commit SHAs to mitigate
the risk of a compromised or retagged action being introduced into the build.
