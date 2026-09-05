declare module "node:crypto" {
  export interface Hash {
    update(data: Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:fs" {
  export function mkdirSync(path: string, options: { recursive: true }): string | undefined;
  export function closeSync(fd: number): void;
  export function existsSync(path: string): boolean;
  export function fsyncSync(fd: number): void;
  export function openSync(path: string, flags: string): number;
  export function readFileSync(path: string): Uint8Array;
  export function renameSync(oldPath: string, newPath: string): void;
  export function unlinkSync(path: string): void;
  export function writeSync(fd: number, data: Uint8Array): number;
}

declare module "node:fs/promises" {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function lstat(path: string): Promise<Stats>;
  export function readlink(path: string): Promise<string>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function realpath(path: string): Promise<string>;
  export function stat(path: string): Promise<Stats>;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:process" {
  const process: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly pid: number;
  };
  export default process;
}

declare module "better-sqlite3" {
  export interface RunResult {
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
  }

  export interface Statement {
    run(...params: unknown[]): RunResult;
    get<T = unknown>(...params: unknown[]): T;
    all<T = unknown>(...params: unknown[]): T[];
  }

  export interface DatabaseConnection {
    exec(sql: string): this;
    prepare(sql: string): Statement;
    pragma<T = unknown>(source: string, options?: { simple?: boolean }): T;
    close(): void;
  }

  interface DatabaseOpenOptions {
    readonly readonly?: boolean;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: DatabaseOpenOptions): DatabaseConnection;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
