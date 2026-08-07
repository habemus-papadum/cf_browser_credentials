#!/usr/bin/env node
// Scaffold a new package into packages/<slug> from scripts/_skeleton.
//
// Usage: pnpm new-package <name> [--private] [--description "..."]
//
// The new package joins version lockstep immediately (it adopts the current shared
// version). No other file needs editing — the packages/* glob picks it up everywhere.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const skeletonDir = join(scriptsDir, "_skeleton");
const packagesDir = join(repoRoot, "packages");

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { private: false, description: "A TypeScript library." };
  let name;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--private") {
      opts.private = true;
    } else if (arg === "--description") {
      opts.description = argv[++i] ?? opts.description;
    } else if (!arg.startsWith("--") && !name) {
      name = arg;
    } else {
      fail(`unexpected argument "${arg}"`);
    }
  }
  if (!name) {
    fail('usage: pnpm new-package <name> [--private] [--description "..."]');
  }
  return { name, ...opts };
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Infer the npm scope and repo URL from the first existing package. */
function deriveContext() {
  const dirs = existsSync(packagesDir)
    ? readdirSync(packagesDir).filter((d) => existsSync(join(packagesDir, d, "package.json")))
    : [];
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
    const scope = pkg.name?.startsWith("@") ? pkg.name.split("/")[0] : "";
    if (scope) {
      return { scope, repoUrl: pkg.repository?.url ?? "" };
    }
  }
  return fail("no existing package to infer the npm scope from — create packages/* first");
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

function main() {
  const { name, private: isPrivate, description } = parseArgs(process.argv.slice(2));
  const slug = slugify(name);
  if (!slug) {
    fail(`"${name}" slugifies to an empty string`);
  }
  const dest = join(packagesDir, slug);
  if (existsSync(dest)) {
    fail(`packages/${slug} already exists`);
  }

  const { scope, repoUrl } = deriveContext();
  const version = execFileSync("node", [join(scriptsDir, "versioning.mjs"), "current"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

  cpSync(skeletonDir, dest, { recursive: true });

  const tokens = {
    __NAME__: `${scope}/${slug}`,
    __VERSION__: version,
    __DESCRIPTION__: description,
    __DIRECTORY__: `packages/${slug}`,
    __REPO_URL__: repoUrl,
  };
  for (const file of walk(dest)) {
    let text = readFileSync(file, "utf8");
    for (const [token, value] of Object.entries(tokens)) {
      text = text.replaceAll(token, value);
    }
    writeFileSync(file, text);
  }

  const pkgPath = join(dest, "package.json");
  renameSync(join(dest, "package.json.tmpl"), pkgPath);

  if (isPrivate) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.private = true;
    pkg.publishConfig = undefined;
    pkg.files = undefined;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  process.stdout.write(
    `Created packages/${slug} (${scope}/${slug} @ ${version})${isPrivate ? " [private]" : ""}\n` +
      "Next: run `pnpm install` to link the new workspace member.\n",
  );
}

main();
