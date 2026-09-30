import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";

test("fixture launches, works, and cleans up every owned resource", async (t) => {
  const root = process.env.EGA_LIFECYCLE_FIXTURE_ROOT;
  if (!root) throw new Error("EGA_LIFECYCLE_FIXTURE_ROOT is required");

  const server = createServer((_request, response) => {
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const body = await response.text();
  if (body !== "ok") throw new Error(`fixture server answered ${JSON.stringify(body)}`);

  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 25)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(`fixture child exited code=${String(exit.code)} signal=${String(exit.signal)}`);
  }

  mkdirSync(join(root, "artifact"), { recursive: true });
  writeFileSync(join(root, "artifact", "done.txt"), "done\n");
});
