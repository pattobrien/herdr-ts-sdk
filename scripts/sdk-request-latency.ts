/**
 * Measures `workspaces.list` latency through the SDK under Node and Bun, against the in-repo test server and a separate `herdr --session perf-sdk` server.
 *
 * Usage: `node scripts/sdk-request-latency.ts [--processes 10] [--requests 20] [--herdr path/to/herdr] [--out file.json]`.
 *
 * @since 0.9.1
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node-shared";
import { Effect, Schedule } from "effect";
import { HerdrSdk } from "../src/herdr-sdk.ts";
import { herdrSdkLayerFromOptions, makeHerdrConfig } from "../src/herdr-node.ts";
import { HerdrAbsolutePath } from "../src/herdr-domain.ts";
import { startHerdrTestServer } from "../src/herdr-test-server.ts";
import { makeHerdrSuccessResponse } from "../src/herdr-wire-fixtures.ts";

const root = join(import.meta.dirname, "..");
const script = join(import.meta.dirname, "sdk-request-latency.ts");
const herdrSession = "perf-sdk";
const runtimes = { node: process.execPath, bun: "bun" } as const;

interface ChildResult {
  readonly samples: readonly number[];
  readonly workspaces: number;
}

const measureRequests = (socketPath: string, requests: number) =>
  Effect.gen(function* () {
    const herdr = yield* HerdrSdk;
    const samples: number[] = [];
    let workspaces = 0;
    for (let index = 0; index < requests; index++) {
      const started = performance.now();
      const listed = yield* herdr.workspaces.list();
      samples.push(performance.now() - started);
      workspaces = listed.length;
    }
    const result: ChildResult = { samples, workspaces };
    console.log(JSON.stringify(result));
  }).pipe(
    Effect.provide(herdrSdkLayerFromOptions({ socketPath: HerdrAbsolutePath.make(socketPath) })),
  );

function runChild(runtime: keyof typeof runtimes, socketPath: string, requests: number) {
  return Effect.callback<ChildResult, Error>((resume) => {
    const child = execFile(
      runtimes[runtime],
      [script, "--child", socketPath, "--requests", String(requests)],
      { cwd: root, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error !== null) {
          resume(Effect.fail(new Error(`${runtime} child failed\n${stdout}${stderr}`)));
          return;
        }
        resume(Effect.succeed(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")));
      },
    );
    return Effect.sync(() => child.kill());
  });
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? Number.NaN;
}

const startHerdrSession = Effect.fn("startHerdrSession")(function* (herdrBinary: string) {
  const config = yield* makeHerdrConfig({ session: herdrSession });
  if (existsSync(config.socketPath))
    return yield* Effect.fail(
      new Error(`${config.socketPath} already exists; stop the ${herdrSession} session first`),
    );
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn(herdrBinary, ["--session", herdrSession, "server"], { cwd: root, stdio: "ignore" }),
    ),
    (child) =>
      Effect.callback<void>((resume) => {
        execFile(herdrBinary, ["--session", herdrSession, "server", "stop"], () => {
          child.kill();
          resume(Effect.void);
        });
      }),
  );
  yield* Effect.suspend(() =>
    existsSync(config.socketPath) ? Effect.void : Effect.fail(new Error("herdr socket missing")),
  ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }));
  return config.socketPath;
});

const benchmark = (
  processes: number,
  requests: number,
  herdrBinary: string,
  out: string | undefined,
) =>
  Effect.gen(function* () {
    const fixture = yield* startHerdrTestServer((request) =>
      Effect.succeed(makeHerdrSuccessResponse(request)),
    );
    const targets = {
      "test server": fixture.socketPath,
      herdr: yield* startHerdrSession(herdrBinary),
    };
    const results: Record<string, Record<string, ChildResult[]>> = {};
    for (let round = 0; round < processes; round++) {
      for (const [target, socketPath] of Object.entries(targets)) {
        for (const runtime of round % 2 === 0
          ? (["node", "bun"] as const)
          : (["bun", "node"] as const)) {
          const result = yield* runChild(runtime, socketPath, requests);
          ((results[target] ??= {})[runtime] ??= []).push(result);
        }
      }
    }
    const pings = fixture.requests.filter((request) => request.method === "ping").length;
    const lists = fixture.requests.filter((request) => request.method === "workspace.list").length;
    console.log(`test server requests: ${pings} ping, ${lists} workspace.list`);
    console.log(
      "| target | runtime | first request p50 / p90 ms | later requests p50 / p90 ms | processes | workspaces listed |",
    );
    console.log("| --- | --- | --- | --- | --- | --- |");
    const cell = (values: readonly number[]) =>
      `${percentile(values, 0.5).toFixed(1)} / ${percentile(values, 0.9).toFixed(1)}`;
    for (const [target, byRuntime] of Object.entries(results)) {
      for (const [runtime, runs] of Object.entries(byRuntime)) {
        const first = runs.map((run) => run.samples[0] ?? Number.NaN);
        const later = runs.flatMap((run) => run.samples.slice(1));
        console.log(
          `| ${target} | ${runtime} | ${cell(first)} | ${cell(later)} | ${runs.length} | ${runs[0]?.workspaces} |`,
        );
      }
    }
    if (out !== undefined) yield* Effect.promise(() => writeFile(out, JSON.stringify(results)));
  });

const { values } = parseArgs({
  options: {
    child: { type: "string" },
    processes: { type: "string", default: "10" },
    requests: { type: "string", default: "20" },
    herdr: { type: "string", default: "herdr" },
    out: { type: "string" },
  },
});

NodeRuntime.runMain(
  values.child === undefined
    ? Effect.scoped(
        benchmark(Number(values.processes), Number(values.requests), values.herdr, values.out),
      ).pipe(Effect.provide(NodeFileSystem.layer))
    : measureRequests(values.child, Number(values.requests)),
);
