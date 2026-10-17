import { createServer } from "node:http";
import test from "node:test";

test("leaky fixture leaves a listening server alive", async () => {
  const server = createServer((_request, response) => {
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});
