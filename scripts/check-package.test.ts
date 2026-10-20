import { Effect, FileSystem } from "effect";
import { NodeFileSystem } from "@effect/platform-node-shared";
import { expect, test } from "vite-plus/test";
import { runHerdrTest } from "../src/herdr-test-runtime.ts";
import { checkPackedPackage } from "./check-package.mjs";

test(
  "packed consumer builds current source without mutating package metadata and cleans up",
  (context) =>
    runHerdrTest(
      context,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const before = yield* fs.readFileString("package.json");
        const result = yield* checkPackedPackage();
        expect(result.runtimeOutput).toBe(
          `Packed runtime socket round trip passed on Node ${process.version}`,
        );
        expect(yield* fs.exists(result.temporaryDirectory)).toBe(false);
        expect(yield* fs.readFileString("package.json")).toBe(before);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    ),
  120_000,
);

test(
  "packed consumer reports an unavailable runtime instead of silently using the development Node",
  (context) =>
    runHerdrTest(
      context,
      Effect.gen(function* () {
        const failure = yield* checkPackedPackage({
          runtime: "herdr-package-missing-node-executable",
        }).pipe(Effect.flip);
        expect(String(failure)).toContain("herdr-package-missing-node-executable");
      }),
    ),
  120_000,
);
