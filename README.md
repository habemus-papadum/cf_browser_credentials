# cf_browser_credentials

A TypeScript library for minting ephemeral credentials from a Cloudflare worker for an otherwise static site

A pnpm + TypeScript monorepo. Every package under `packages/*` is published to npm under the
`@habemus-papadum` scope and released on its own, with its own version and tag series.

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

A new package starts at `0.0.0+dev` with no tag; its first release computes `0.1.0` or `0.0.1`.
Dependencies on sibling packages are peer dependencies with floors (`workspace:>=0.8.0`, published
as `>=0.8.0`) plus a `workspace:*` devDependency, so each package builds alone and an application
holds one copy of the credential kit.

## Releasing

[ship](https://github.com/habemus-papadum/pdum_ship) releases one package per run, entirely in
CI — there is no local release script and no tag trigger. From the GitHub Actions UI run the
**release** workflow, or:

```sh
gh workflow run release.yml -f package=@habemus-papadum/cf-creds-aws -f bump=minor -f dry_run=true   # plan
gh workflow run release.yml -f package=@habemus-papadum/cf-creds-aws -f bump=minor -f dry_run=false  # release
```

The workflow waits for this commit's CI to be green, computes the next version from the package's
last tag (`cf-creds-aws-v0.8.0` → `0.9.0` for `minor`), builds the package and its workspace
dependencies, runs the tests, publishes to npm, commits, tags `<package>-v<version>`, pushes, and
returns the manifest to `<version>+dev`. Each package has its own version; releasing one does not
touch the others.

Between releases a manifest carries `X.Y.Z+dev`; ship refuses to publish it, and
`uv run ship deps check` reports a manifest that says anything else. To see what would be released:

```sh
uv run ship packages                                              # every package, version, last tag
uv run ship changed                                               # commits since each last release
uv run ship release @habemus-papadum/cf-creds-aws --bump minor --dry-run
```

### One-time setup

Add an npm automation token as the `NPM_TOKEN` Actions secret (Settings → Secrets and variables →
Actions). Locally, `uv sync` installs ship (it is the only Python dependency; `pyproject.toml`
exists for it) and `uvx pre-commit install` enables the `ship-check` hook.

## Layout

```
packages/*               published libraries, each with its own version and tags
scripts/new-package.mjs  scaffolder for new packages
pyproject.toml           installs ship and holds [tool.ship]; not a Python package
.agents/skills/          ship's agent skills, written by `uv run ship skills sync`
.github/workflows/       ci.yml (gate) + release.yml (calls ship's reusable release workflow)
```
