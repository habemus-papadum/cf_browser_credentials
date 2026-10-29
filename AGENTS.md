# Agent guardrails for cf_browser_credentials

## Versions and releases

`ship` (habemus-papadum-ship) releases this repository's packages. Each package under
`packages/*` has its own version and its own tag series, `<package>-v<version>` (the npm name
without the scope: `cf-creds-aws-v0.8.1`). Between releases a manifest says `<last release>+dev`.
Never edit a `version` field by hand; `ship deps check` reports anything other than the marker.

To release, ask the operator; when they agree, run the release workflow for one package:

```sh
gh workflow run release.yml -f package=@habemus-papadum/cf-creds-aws -f bump=minor -f dry_run=true   # see the plan
gh workflow run release.yml -f package=@habemus-papadum/cf-creds-aws -f bump=minor -f dry_run=false  # release
```

The workflow waits for this commit's CI, builds the package and its workspace dependencies,
publishes to npm, tags, pushes and restores the `+dev` marker. Do not publish from this machine;
never run `pnpm publish` or push a tag by hand.

Do not update repositories that consume a package you changed; their scheduled refresh does that.
The one exception: if your change needs a newer release of another `@habemus-papadum/*` package,
raise that package's floor here. Do not pin one of our packages to an exact version without a
reason on the same line or in `[tool.ship.pins]` (`pyproject.toml`). Never commit a `link:` or
`file:` dependency, or a `path`/`editable` entry in `[tool.uv.sources]`.

Run `uv run ship deps check` before you finish. The `ship-release` and `ship-adopt` skills under
`.agents/skills/` (mirrored at `.claude/skills/`) are written by `uv run ship skills sync`; do not
edit them.

## Development

```sh
pnpm install
pnpm build       # Vite library build + tsc .d.ts, per package
pnpm test        # Vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # Biome (also enforced in CI)
pnpm new-package <name> [--private]
uv run ship packages   # every package, its manifest version and its last tag
uv run ship changed    # packages with commits since their last release
```

## Architecture

- pnpm workspace; every `packages/*` is an independent npm package under `@habemus-papadum`,
  released on its own.
- Dependencies between packages are **peer dependencies** with floors (`workspace:>=0.8.0`,
  published as `>=0.8.0`) plus a `workspace:*` devDependency so each package builds and tests
  alone. The credential kit's classes (`CredentialManager`, `AccessLoginRequired`) and source
  types cross every package's public API, so an application must hold one copy; a peer range
  that excludes the application's copy would make pnpm install a second one. Never `workspace:^`
  in `peerDependencies`.
- Build: Vite library mode (ESM) + `tsc --emitDeclarationOnly` for `.d.ts`.
