#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

function usage() {
  console.error("usage: debug-server.mjs [--host HOST] [--port PORT] --output PATH");
}

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 8765,
    output: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--host") {
      args.host = argv[++i] ?? "";
    } else if (arg === "--port") {
      args.port = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg === "--output") {
      args.output = argv[++i] ?? "";
    } else {
      console.error(`unknown argument: ${arg}`);
      usage();
      process.exit(2);
    }
  }

  if (!args.output || !Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    usage();
    process.exit(2);
  }

  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

function normalizeEvent(payload) {
  return {
    timestamp: nowIso(),
    hypothesis_id: "unknown",
    event: "debug_event",
    ...payload,
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const args = parseArgs(process.argv.slice(2));
const output = path.resolve(args.output);
fs.mkdirSync(path.dirname(output), { recursive: true });

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/log") {
    response.writeHead(404);
    response.end();
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("invalid json\n");
    return;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("json body must be an object\n");
    return;
  }

  fs.appendFileSync(output, `${JSON.stringify(sortValue(normalizeEvent(payload)))}\n`);
  response.writeHead(204);
  response.end();
});

server.listen(args.port, args.host, () => {
  console.log(`debug server listening on http://${args.host}:${args.port}/log`);
  console.log(`writing events to ${output}`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
