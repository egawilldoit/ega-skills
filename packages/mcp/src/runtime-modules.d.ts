// Ambient type stubs for the node builtins + pinned native surface used by
// this package, following the project/registry/router runtime-modules.d.ts
// pattern: the repo pins its own stdlib surface instead of depending on
// @types/node. TypeScript resolves these declarations at compile time while
// the emitted code imports the real Node builtin modules at runtime.
//
// The MCP runtime touches ONLY: node:process (env/cwd), node:path, node:fs
// (pure presence/stat reads), and better-sqlite3 (read-only registry opens).

declare module "node:fs" {
  export interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export function existsSync(path: string): boolean;
  export function lstatSync(path: string): Stats;
  export function realpathSync(path: string): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:process" {
  interface Stdin {
    on(event: "end" | "close", listener: () => void): Stdin;
  }
  interface Stdout {
    write(chunk: string): boolean;
  }
  const process: {
    readonly stdin: Stdin;
    readonly stdout: Stdout;
    readonly stderr: Stdout;
    readonly env: Readonly<Record<string, string | undefined>>;
    cwd(): string;
    exit(code?: number): never;
  };
  export default process;
}

// Minimal pinned surface of better-sqlite3 (registry pins 13.0.3): the MCP
// runtime opens databases with `new Database(filename)` ONLY (no options —
// read-only is enforced with `query_only = ON` after open, never with open
// flags, matching the registry's pinned constructor surface).
declare module "better-sqlite3" {
  export interface Statement {
    get<T = unknown>(...params: unknown[]): T;
  }
  export interface DatabaseConnection {
    exec(sql: string): void;
    pragma<T = unknown>(source: string, options?: { simple?: boolean }): T;
    prepare(sql: string): Statement;
    close(): void;
  }
  interface DatabaseConstructor {
    new (filename: string): DatabaseConnection;
  }
  const Database: DatabaseConstructor;
  export default Database;
}
