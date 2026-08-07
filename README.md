# cf_browser_credentials

A TypeScript library for minting ephemeral credentials from a Cloudflare worker for an otherwise static site

A pnpm + TypeScript monorepo. Every package under `packages/*` is published to npm under the
`@habemus-papadum` scope and versioned in **lockstep** (one shared version across the whole repo).

## Requirements

- Node 24+
- pnpm 11+ — install it however you like (`brew install pnpm`, the
  [standalone script](https://pnpm.io/installation#using-a-standalone-script), or
  `npm i -g pnpm`). You do **not** need corepack: this repo pins an exact pnpm in
  `package.json` → `packageManager`, and pnpm 10+ automatically downloads and runs that
  exact version for every command in this repo. Every machine (and CI) gets the identical
  pnpm. To change it, run `pnpm pkg set packageManager=pnpm@<version>` and commit.

## Getting started

```sh
pnpm install
pnpm build       # build every package (Vite library mode + tsc .d.ts)
pnpm test        # run all tests (Vitest)
pnpm typecheck   # tsc --noEmit across packages
pnpm lint        # Biome (lint + format check)
pnpm format      # Biome autofix
```

## Add a package

```sh
pnpm new-package my-lib          # -> packages/my-lib, published as @habemus-papadum/my-lib
pnpm new-package demo --private  # internal-only, never published
```

New packages join version lockstep automatically. Internal dependencies use `workspace:^`; pnpm
rewrites them to a concrete version at publish time.

## Releasing

Releases run **entirely in CI** — there is no local release script and no tag trigger. From the
GitHub Actions UI run the **release** workflow (or `gh workflow run release.yml -f bump=minor`),
choosing `patch`, `minor`, or `major`. The pipeline:

1. **gate** — require this commit's CI to be green (skippable with `skip_ci_check`).
2. **prepare** — compute the next version from the highest `vX.Y.Z` tag, write it across every
   `package.json`, commit, tag `vX.Y.Z`, push.
3. **npm-publish** — `pnpm -r publish --provenance` (private packages are skipped).
4. **github-release** — a GitHub Release with generated notes.
5. **finalize** — return `main` to a `X.Y.Z+dev` marker.

Use `dry_run: true` to compute the version and preview the diff without committing or publishing.

Between releases the tree carries an `X.Y.Z+dev` version — npm rejects it, so a stray publish can't
overwrite a released version.

### One-time setup

Add an npm automation token as the `NPM_TOKEN` Actions secret (Settings → Secrets and variables →
Actions). Provenance additionally requires the repo to be public (or npm Pro/Teams).

## Layout

```
packages/*               published libraries (shared lockstep version)
scripts/versioning.mjs   the lockstep version engine (CI-managed — do not run `set` by hand)
scripts/new-package.mjs  scaffolder for new packages
.github/workflows/       ci.yml (gate) + release.yml (publish)
```
