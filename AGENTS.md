# Agent guardrails for cf_browser_credentials

## Version management — do NOT touch versions

The `version` field in every `package.json` (the root and each `packages/*`) is managed
**exclusively** by the CI release pipeline. Do not edit it, and do not run
`node scripts/versioning.mjs set`. Between releases the tree carries an `X.Y.Z+dev` marker; the
pipeline writes the clean `X.Y.Z` at release time. If you think a version change is needed, tell the
user — do not make it.

## Releasing — do NOT publish

Releasing is a single GitHub Actions workflow: `.github/workflows/release.yml`, a `workflow_dispatch`
a human runs from the Actions UI (or `gh workflow run release.yml -f bump=minor`). There is **no**
local release script and **no** tag trigger — CI is the only publish path. Never run `pnpm publish`
/ `npm publish`, never push a `vX.Y.Z` tag, and do not suggest a release unless the user explicitly
asks about the process.

## Development

```sh
pnpm install
pnpm build       # Vite library build + tsc .d.ts, per package
pnpm test        # Vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # Biome (also enforced in CI)
pnpm new-package <name> [--private]
```

## Architecture

- pnpm workspace; every `packages/*` is an independent npm package under `@habemus-papadum`.
- **Lockstep versioning**: all packages share one version, enforced by
  `node scripts/versioning.mjs current` (checked in CI).
- Internal dependencies use `workspace:^` (never hand-pinned).
- Build: Vite library mode (ESM) + `tsc --emitDeclarationOnly` for `.d.ts`.
