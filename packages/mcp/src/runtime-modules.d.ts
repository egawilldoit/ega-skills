// Minimal ambient declarations for the node: builtins the MCP server uses,
// matching the project/registry/router/cli runtime-modules.d.ts pattern (the
// repo pins its own stdlib surface instead of depending on @types/node).

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
    exit(code?: number): never;
  };
  export default process;
}