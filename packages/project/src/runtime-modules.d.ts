// Ambient type stubs for the node builtins used by this package. There is no
// @types/node dependency and no runtime shim: TypeScript resolves these
// declarations at compile time while the emitted code imports the real Node
// builtin modules at runtime (same convention as packages/registry and
// packages/router).

declare module "node:fs" {
  export interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export function lstatSync(path: string): Stats;
  export function realpathSync(path: string): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:process" {
  const process: {
    cwd(): string;
  };
  export default process;
}