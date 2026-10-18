import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(here, "scripts", "web", "stage-artifact.mjs"),
  join(here, "..", "..", "scripts", "web", "stage-artifact.mjs"),
  join(here, "stage-artifact.mjs"),
];
const script = candidates.find(existsSync);
if (!script) {
  process.stderr.write("stage-artifact.mjs not found\n");
  process.exit(1);
}
const res = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(res.status ?? 0);
