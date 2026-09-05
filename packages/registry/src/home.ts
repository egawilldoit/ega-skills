import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { RegistryError } from "./errors.js";

export interface RegistryPaths {
  readonly home: string;
  readonly database: string;
  readonly cacheSha256: string;
  readonly logs: string;
  readonly config: string;
}

export function resolveRegistryHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome: string = homedir(),
): string {
  const override = env["EGA_SKILLS_HOME"];
  if (override !== undefined) {
    if (override.length === 0) {
      throw new RegistryError("E_REGISTRY_HOME", "EGA_SKILLS_HOME must not be empty");
    }
    return resolve(override);
  }
  return join(userHome, ".ega-skills");
}

/**
 * Pure path resolution for the registry home: joins the standard layout
 * WITHOUT creating anything. Read-only opens use this so a mere resolve can
 * never materialize directories as a side effect (SPEC-006 §5.3).
 */
export function resolveRegistryPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome: string = homedir(),
): RegistryPaths {
  const home = resolveRegistryHome(env, userHome);
  return {
    home,
    database: join(home, "registry.sqlite"),
    cacheSha256: join(home, "cache", "sha256"),
    logs: join(home, "logs"),
    config: join(home, "config"),
  };
}

export function ensureRegistryHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome: string = homedir(),
): RegistryPaths {
  try {
    const paths = resolveRegistryPaths(env, userHome);
    mkdirSync(paths.home, { recursive: true });
    mkdirSync(paths.cacheSha256, { recursive: true });
    mkdirSync(paths.logs, { recursive: true });
    mkdirSync(paths.config, { recursive: true });
    return paths;
  } catch (error) {
    if (error instanceof RegistryError && error.code === "E_REGISTRY_HOME") throw error;
    throw new RegistryError("E_REGISTRY_HOME", "Failed to initialize the registry home", error);
  }
}
