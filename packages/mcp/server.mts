import { createServer } from "node:http";

const server = createServer((incoming, outgoing) => {
  outgoing.writeHead(200, { "content-type": "application/json" });
  outgoing.end(JSON.stringify({ status: "probe-ok" }));
});

server.listen(Number(process.env.PORT ?? 3000), () => {
  process.stderr.write("probe listening\n");
});
