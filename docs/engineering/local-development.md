# Local development

## Supported baseline

| Tool       | Baseline    |
| ---------- | ----------- |
| Node.js    | 24.19.0 LTS |
| pnpm       | 10.34.5     |
| TypeScript | 6.0.3       |

Node 26 may happen to run the tools, but it is not the supported product baseline. `.npmrc` uses `engine-strict=true` so an unsupported runtime fails early rather than producing an unrepeatable lockfile.

## Running without changing the system Node

If Node 24 is not installed globally, the baseline can be verified temporarily:

```bash
npm exec --yes --package=node@24.19.0 --package=pnpm@10.34.5 --call 'pnpm install'
npm exec --yes --package=node@24.19.0 --package=pnpm@10.34.5 --call 'pnpm check'
```

For day-to-day development, install Node 24 through a version manager that supports `.node-version` (mise, fnm, Volta, asdf) rather than replacing unrelated project runtimes.

## Commands

```bash
pnpm dev          # Local Core + Browser UI
pnpm test         # Unit and integration tests
pnpm typecheck    # Strict TypeScript across every workspace
pnpm lint         # Repository lint
pnpm format:check # Formatting guard
pnpm build        # Core and Web production builds
pnpm check        # All pre-commit quality gates
```

## Architecture boundaries

- `apps/web` cannot import filesystem, database, secret, or process modules.
- `apps/core` owns local authorities and only exposes validated contracts.
- `packages/domain` stays independent of React, Fastify, SQLite, Pi and Electron.
- `packages/contracts` validates every cross-process payload at runtime.
- `packages/providers` contains replaceable capabilities, not implementations tied to a single vendor.
- `packages/ui` can contain adapted Orca components only after provenance is logged.

## Ports

- `3100`: Vite Browser UI — binds `0.0.0.0` so the UI is reachable from the LAN.
- `4318`: PMForge Local Core

The Core binds loopback only and must not be changed to `0.0.0.0` without a separate
authentication and threat-model review. LAN clients reach it solely through the Vite
proxy on `3100`.

Because the Core enforces an Origin allowlist, any LAN address used to open the UI must
be added via `PMFORGE_ALLOWED_ORIGINS` (comma-separated, appended to the built-in
loopback origins) — otherwise every write request is rejected with `FORBIDDEN_ORIGIN`
while the page itself still loads. Note there is no TLS on `3100`: passwords entered in
the UI cross the LAN in cleartext.
