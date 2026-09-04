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

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
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

  interface DatabaseConstructor {
    new (filename: string): DatabaseConnection;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
