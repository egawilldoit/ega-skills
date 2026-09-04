import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageNames = ["schema", "hashing", "registry", "router", "project", "mcp", "cli"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("root exposes the EGA-547 workspace toolchain contract", () => {
  const pkg = readJson(join(root, "package.json"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.packageManager, "pnpm@10.0.0");
  assert.equal(pkg.engines?.node, "24");
  assert.equal(pkg.scripts?.build, "tsc -b");
  assert.equal(pkg.scripts?.typecheck, "tsc -b --pretty false --force");
  assert.equal(pkg.scripts?.test, "node --test");
  assert.equal(pkg.scripts?.["specs:check"], "node scripts/specs/check-specs.mjs");
  assert.equal(typeof pkg.devDependencies?.typescript, "string");
});

test("strict TypeScript configuration and project references cover every package", () => {
  const base = readJson(join(root, "tsconfig.base.json"));
  assert.equal(base.compilerOptions?.strict, true);
  assert.equal(base.compilerOptions?.exactOptionalPropertyTypes, true);
  assert.equal(base.compilerOptions?.noUncheckedIndexedAccess, true);

  const rootConfig = readJson(join(root, "tsconfig.json"));
  const references = rootConfig.references?.map(({ path }) => path) ?? [];
  assert.deepEqual(references, packageNames.map((name) => `./packages/${name}`));
});

test("all seven package boundaries are real buildable ESM packages", () => {
  for (const name of packageNames) {
    const dir = join(root, "packages", name);
    const manifestPath = join(dir, "package.json");
    const tsconfigPath = join(dir, "tsconfig.json");
    const entrypointPath = join(dir, "src", "index.ts");

    assert.ok(existsSync(manifestPath), `${name}: package.json is missing`);
    assert.ok(existsSync(tsconfigPath), `${name}: tsconfig.json is missing`);
    assert.ok(existsSync(entrypointPath), `${name}: src/index.ts is missing`);

    const manifest = readJson(manifestPath);
    assert.equal(manifest.name, `@ega-skills/${name}`);
    assert.equal(manifest.private, true);
    assert.equal(manifest.type, "module");
    assert.equal(manifest.main, "./dist/index.js");
    assert.equal(manifest.types, "./dist/index.d.ts");
    assert.deepEqual(manifest.exports, {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    });

    const config = readJson(tsconfigPath);
    assert.equal(config.extends, "../../tsconfig.base.json");
    assert.equal(config.compilerOptions?.composite, true);
    assert.equal(config.compilerOptions?.rootDir, "src");
    assert.equal(config.compilerOptions?.outDir, "dist");
    assert.deepEqual(config.include, ["src/**/*.ts"]);
  }
});

test("workspace package dependency graph is acyclic", () => {
  const workspaceNames = new Set(packageNames.map((name) => `@ega-skills/${name}`));
  const graph = new Map();

  for (const name of packageNames) {
    const manifest = readJson(join(root, "packages", name, "package.json"));
    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    graph.set(
      manifest.name,
      Object.keys(deps).filter((dependency) => workspaceNames.has(dependency)),
    );
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (name) => {
    if (visiting.has(name)) assert.fail(`workspace dependency cycle detected at ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };

  for (const name of graph.keys()) visit(name);
  assert.equal(visited.size, packageNames.length);
});
