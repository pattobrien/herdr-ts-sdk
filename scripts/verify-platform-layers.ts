/**
 * Proves the platform-neutral SDK entry runs in a headless browser over a WebSocket bridge without reaching Node-only modules.
 *
 * Requires `websocat` and `agent-browser` on `PATH`.
 *
 * @since 0.9.1
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { builtinModules } from "node:module";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime } from "@effect/platform-node-shared";
import { Effect, Schedule } from "effect";
import { build } from "vite";
import { type HerdrTestServer, startHerdrTestServer } from "../src/herdr-test-server.ts";

const root = join(import.meta.dirname, "..");
const browserEntry = join(root, "examples", "platform", "browser-ping.ts");
const rootEntry = "virtual:herdr-root-entry";
const browserSession = "herdr-platform-layers";
const nodeOnly = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function run(command: string, args: readonly string[]) {
  return Effect.callback<string, Error>((resume) => {
    const child = execFile(command, args, { cwd: root, timeout: 60_000 }, (error, stdout, stderr) =>
      resume(
        error === null
          ? Effect.succeed(stdout.trim())
          : Effect.fail(
              new Error(`${command} ${args.join(" ")} failed\n${stdout}${stderr}`, {
                cause: error,
              }),
            ),
      ),
    );
    return Effect.sync(() => child.kill());
  });
}

const bundleForBrowser = Effect.fn("bundleForBrowser")(function* (entry: string, outDir: string) {
  const offenders: string[] = [];
  let modules = 0;
  yield* Effect.promise(() =>
    build({
      configFile: false,
      logLevel: "silent",
      resolve: {
        alias: [
          { find: /^@herdr\/sdk\/core$/, replacement: join(root, "src", "core.ts") },
          { find: /^@herdr\/sdk$/, replacement: join(root, "src", "index.ts") },
        ],
      },
      plugins: [
        {
          name: "node-only-imports",
          enforce: "pre",
          resolveId(source, importer) {
            if (source === rootEntry) return source;
            if (!nodeOnly.has(source) && !source.startsWith("@effect/platform-node-shared"))
              return null;
            offenders.push(`${importer} -> ${source}`);
            return { id: source, external: true };
          },
          load(id) {
            return id === rootEntry ? 'export * from "@herdr/sdk";' : null;
          },
          buildEnd() {
            modules = [...this.getModuleIds()].length;
          },
        },
      ],
      build: {
        outDir,
        emptyOutDir: true,
        target: "esnext",
        minify: false,
        rollupOptions: { input: entry, output: { entryFileNames: "[name].js" } },
      },
    }),
  );
  console.log(`import graph ${entry}: ${modules} modules, ${offenders.length} Node-only imports`);
  return offenders;
});

function serveBrowserBundle(bundleDirectory: string) {
  return Effect.acquireRelease(
    Effect.callback<{ readonly port: number; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        if (request.url?.startsWith("/browser-ping.js")) {
          void readFile(join(bundleDirectory, "browser-ping.js")).then((body) => {
            response.writeHead(200, { "content-type": "text/javascript" }).end(body);
          });
          return;
        }
        response
          .writeHead(200, { "content-type": "text/html" })
          .end(
            '<!doctype html><body><script type="module" src="/browser-ping.js"></script></body>',
          );
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("unexpected address");
        resume(Effect.succeed({ port: address.port, close: () => server.close() }));
      });
    }),
    (server) => Effect.sync(server.close),
  );
}

const freePort = Effect.callback<number>((resume) => {
  const server = createNetServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("unexpected address");
    server.close(() => resume(Effect.succeed(address.port)));
  });
});

function acceptsConnections(port: number) {
  return Effect.callback<void, Error>((resume) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.void);
    });
    socket.once("error", (error) => resume(Effect.fail(error)));
  });
}

const startBridge = Effect.fn("startBridge")(function* (socketPath: string) {
  const port = yield* freePort;
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn("websocat", ["--binary", "-E", `ws-l:127.0.0.1:${port}`, `unix:${socketPath}`], {
        stdio: ["ignore", "inherit", "inherit"],
      }),
    ),
    (child) => Effect.sync(() => child.kill()),
  );
  const exited = Effect.callback<never, Error>((resume) => {
    child.once("error", (error) => resume(Effect.fail(error)));
    child.once("exit", (code) => resume(Effect.fail(new Error(`websocat exited with ${code}`))));
  });
  yield* Effect.raceFirst(
    exited,
    acceptsConnections(port).pipe(
      Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }),
    ),
  );
  return `ws://127.0.0.1:${port}`;
});

const verify = Effect.gen(function* () {
  const server: HerdrTestServer = yield* startHerdrTestServer((request) =>
    Effect.gen(function* () {
      if (request.method !== "ping")
        return { id: request.id, error: { code: "unexpected_method", message: request.method } };
      if (request.id === "abandon") return yield* Effect.never;
      return {
        id: request.id,
        result: {
          type: "pong" as const,
          version: `open-sockets=${server.openSocketCount()}`,
          protocol: 22,
        },
      };
    }),
  );
  const outDir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "herdr-platform-")));

  const rootOffenders = yield* bundleForBrowser(rootEntry, join(outDir, "root"));
  if (rootOffenders.length === 0)
    return yield* Effect.fail(new Error("expected the @herdr/sdk root entry to reach node:net"));
  const browserBundle = join(outDir, "browser");
  const offenders = yield* bundleForBrowser(browserEntry, browserBundle);
  if (offenders.length > 0) return yield* Effect.fail(new Error(offenders.join("\n")));

  const bridgeUrl = yield* startBridge(server.socketPath);
  const page = yield* serveBrowserBundle(browserBundle);
  const url = `http://127.0.0.1:${page.port}/?${new URLSearchParams({ ws: bridgeUrl, socket: server.socketPath }).toString()}`;
  yield* Effect.addFinalizer(() =>
    run("agent-browser", ["--session", browserSession, "close"]).pipe(Effect.ignore),
  );
  yield* run("agent-browser", ["--session", browserSession, "open", url]);
  yield* run("agent-browser", [
    "--session",
    browserSession,
    "wait",
    "--fn",
    "document.body.dataset.result",
  ]);
  const result = JSON.parse(
    JSON.parse(
      yield* run("agent-browser", [
        "--session",
        browserSession,
        "--json",
        "eval",
        "document.body.dataset.result",
      ]),
    ).data.result,
  );
  console.log("browser result", result);

  const expected = {
    first: "open-sockets=1",
    abandoned: "HerdrRequestTimeout",
    afterAbandon: "open-sockets=1",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (result[key] !== value)
      return yield* Effect.fail(new Error(`browser ${key}: expected ${value}, got ${result[key]}`));
  }
  console.log(
    `fixture pings answered: ${server.requests.filter((request) => request.method === "ping").length}`,
  );
  console.log("platform layers verified");
});

NodeRuntime.runMain(Effect.scoped(verify));
