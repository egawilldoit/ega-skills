// Minimal ambient declarations for the node: builtins the CLI commands use,
// matching the project/registry/router runtime-modules.d.ts pattern (the
// repo pins its own stdlib surface instead of depending on @types/node).

declare module "node:fs" {
  export interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function existsSync(path: string): boolean;
  export function lstatSync(path: string): Stats;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string, options?: { force?: boolean }): void;
  export function statSync(path: string): Stats;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}