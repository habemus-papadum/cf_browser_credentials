#!/usr/bin/env node
// Lockstep version engine for this pnpm monorepo. Zero dependencies — run with the
// repo's own Node. Versions are managed by CI (.github/workflows/release.yml);
// humans and agents should NOT run `set` by hand (see AGENTS.md).
//
// Subcommands:
//   current                  print the single shared version; exit 1 if packages disagree
//   latest-tag               print the highest vX.Y.Z git tag as X.Y.Z (or empty)
//   compute-release <bump>   print bump(latest-tag or 0.0.0, patch|minor|major)
//   set <version>            write <version> into every package.json's "version" field

import { execFileSync } from "node:child_process";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class VersionError extends Error {}

// --- workspace discovery ---------------------------------------------------

/** Parse the `packages:` globs out of pnpm-workspace.yaml (list form only). */
function workspaceGlobs() {
  let text;
  try {
    text = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const globs = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const match = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
    if (match) {
      globs.push(match[1]);
    } else if (line.trim() !== "" && !/^\s/.test(line)) {
      inPackages = false;
    }
  }
  return globs;
}

/** Every package.json that carries the shared version: the root + each member. */
function versionFiles() {
  const files = [join(repoRoot, "package.json")];
  for (const glob of workspaceGlobs()) {
    for (const dir of globSync(glob, { cwd: repoRoot })) {
      const pkg = join(repoRoot, dir, "package.json");
      try {
        readFileSync(pkg);
        files.push(pkg);
      } catch {
        // directory without a package.json — skip it
      }
    }
  }
  return [...new Set(files)];
}

// --- read / write ----------------------------------------------------------

function readVersion(file) {
  return JSON.parse(readFileSync(file, "utf8")).version;
}

/** The single shared version; throws VersionError if the tree disagrees. */
function currentVersion() {
  const seen = new Map();
  for (const file of versionFiles()) {
    seen.set(file, readVersion(file));
  }
  const distinct = new Set(seen.values());
  if (distinct.size !== 1) {
    const detail = [...seen]
      .map(([file, version]) => `  ${file.replace(`${repoRoot}/`, "")}: ${version}`)
      .join("\n");
    throw new VersionError(`packages are not in lockstep:\n${detail}`);
  }
  return [...distinct][0];
}

/** Write `version` into every discovered package.json — and nothing else. */
function setVersion(version) {
  for (const file of versionFiles()) {
    const text = readFileSync(file, "utf8");
    const pkg = JSON.parse(text);
    pkg.version = version;
    const trailing = text.endsWith("\n") ? "\n" : "";
    writeFileSync(file, JSON.stringify(pkg, null, 2) + trailing);
  }
}

// --- semver (hand-rolled, X.Y.Z only) --------------------------------------

function bump(version, level) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new VersionError(`cannot bump non-release version "${version}" (expected X.Y.Z)`);
  }
  let [major, minor, patch] = match.slice(1).map(Number);
  if (level === "major") {
    [major, minor, patch] = [major + 1, 0, 0];
  } else if (level === "minor") {
    [minor, patch] = [minor + 1, 0];
  } else if (level === "patch") {
    patch += 1;
  } else {
    throw new VersionError(`unknown bump level "${level}" (expected patch|minor|major)`);
  }
  return `${major}.${minor}.${patch}`;
}

// --- git tag as truth ------------------------------------------------------

function latestTag() {
  let out;
  try {
    out = execFileSync("git", ["tag", "--list", "v[0-9]*", "--sort=-version:refname"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"], // don't leak git's stderr when there's no repo yet
    });
  } catch {
    return "";
  }
  for (const line of out.split(/\r?\n/)) {
    const match = /^v(\d+\.\d+\.\d+)$/.exec(line.trim());
    if (match) {
      return match[1];
    }
  }
  return "";
}

// --- CLI -------------------------------------------------------------------

function main(argv) {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "current":
      process.stdout.write(`${currentVersion()}\n`);
      break;
    case "latest-tag":
      process.stdout.write(`${latestTag()}\n`);
      break;
    case "compute-release":
      if (!arg) {
        throw new VersionError("compute-release needs a bump level (patch|minor|major)");
      }
      process.stdout.write(`${bump(latestTag() || "0.0.0", arg)}\n`);
      break;
    case "set":
      if (!arg) {
        throw new VersionError("set needs a version");
      }
      setVersion(arg);
      process.stdout.write(`${arg}\n`);
      break;
    default:
      process.stderr.write(
        "usage: versioning.mjs <current | latest-tag | compute-release <bump> | set <version>>\n",
      );
      process.exit(2);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof VersionError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
