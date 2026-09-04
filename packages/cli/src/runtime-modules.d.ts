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
  export function statSync(path: string): Stats;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}