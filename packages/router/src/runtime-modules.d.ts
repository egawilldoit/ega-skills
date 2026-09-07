declare module "node:fs" {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export interface Stats {
    readonly size: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function lstatSync(path: string): Stats;
  export function openSync(path: string, flags: string | number): number;
  export function fstatSync(fd: number): Stats;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  export function closeSync(fd: number): void;
  export const constants: { readonly O_RDONLY: number; readonly O_NOFOLLOW?: number };
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readFileSync(path: string): Uint8Array;
  export function realpathSync(path: string): string;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options: { encoding: "utf8"; stdio?: unknown },
  ): string;
}

declare module "node:path" {
  export const sep: "\\" | "/";
  export function dirname(path: string): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
