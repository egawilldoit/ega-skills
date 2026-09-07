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
    isFIFO(): boolean;
    isSocket(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
  }
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export function lstatSync(path: string): Stats;
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function realpathSync(path: string): string;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function writeFileSync(path: string, data: Uint8Array | string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function existsSync(path: string): boolean;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function rmdirSync(path: string): void;
  export function openSync(path: string, flags: string): number;
  export function writeSync(fd: number, data: string): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
}

declare module "node:util" {
  export class TextDecoder {
    constructor(encoding?: string, options?: { fatal?: boolean });
    decode(input?: Uint8Array): string;
  }
}

declare module "node:path" {
  export const sep: string;
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options: { encoding: "utf8"; stdio?: unknown },
  ): string;
  export function execFileSync(file: string, args: readonly string[], options?: { stdio?: unknown }): Uint8Array;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: Uint8Array): { digest(encoding: string): string };
  };
}

declare module "node:process" {
  const process: {
    cwd(): string;
  };
  export default process;
}
