declare module "node:fs" {
  export function mkdirSync(path: string, options: { recursive: true }): string | undefined;
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
