import { Ajv2020 } from "ajv/dist/2020.js";
import { Effect, Stream } from "effect";
import herdrApiSchema from "../schema/herdr-api.schema.json" with { type: "json" };
import { expect, test } from "vite-plus/test";
import { HerdrAbsolutePath } from "./herdr-domain.ts";
import {
  parseErrorResponse,
  parseLifecycleEvent,
  parseSubscriptionEvent,
  parseSuccessResponse,
} from "./generated/wire-validators.mjs";
import { HerdrInvalidResponse } from "./herdr-errors.ts";
import { herdrSdkLayerFromOptions } from "./herdr-node.ts";
import { HerdrSdk } from "./herdr-sdk.ts";
import { runHerdrTest } from "./herdr-test-runtime.ts";
import { HerdrRawTestResponse, startHerdrTestServer } from "./herdr-test-server.ts";
import { makeHerdrSuccessResponse } from "./herdr-wire-fixtures.ts";

test("schema-invalid responses fail with the ajv error detail", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(
            new HerdrRawTestResponse(
              `${JSON.stringify({ id: request.id, result: { type: "pong" } })}\n`,
            ),
          ),
        );
        const failure = yield* Effect.gen(function* () {
          const sdk = yield* HerdrSdk;
          return yield* sdk.workspaces.list().pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            herdrSdkLayerFromOptions({ socketPath: HerdrAbsolutePath.make(server.socketPath) }),
          ),
        );
        expect(failure).toBeInstanceOf(HerdrInvalidResponse);
        if (!(failure instanceof HerdrInvalidResponse)) return;
        expect(failure.reason).toBe("schema_mismatch");
        expect(String(failure.cause)).toBe(
          `Error: Herdr wire response failed schema parsing for request ${failure.requestId}: data/result must have required property 'version'; data/result must have required property 'protocol'; data/result must have required property 'snapshot'; data/result/type must be equal to constant; data/result must have required property 'workspace'`,
        );
        expect(server.requests.map((request) => request.method)).toStrictEqual(["ping"]);
      }),
    ),
  ));

test("schema-invalid subscription events fail with the ajv error detail", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startHerdrTestServer((request) =>
          Effect.sync(() => {
            const response = makeHerdrSuccessResponse(request);
            if (request.method !== "events.subscribe") return response;
            return new HerdrRawTestResponse(
              `${JSON.stringify(response)}\n${JSON.stringify({ event: "workspace_created", data: {} })}\n`,
            );
          }),
        );
        const failure = yield* Effect.gen(function* () {
          const sdk = yield* HerdrSdk;
          return yield* sdk.events
            .subscribe([{ type: "workspace.created" }])
            .pipe(Stream.runHead, Effect.flip);
        }).pipe(
          Effect.provide(
            herdrSdkLayerFromOptions({ socketPath: HerdrAbsolutePath.make(server.socketPath) }),
          ),
        );
        expect(failure).toBeInstanceOf(HerdrInvalidResponse);
        if (!(failure instanceof HerdrInvalidResponse)) return;
        expect(failure.reason).toBe("schema_mismatch");
        expect(String(failure.cause)).toBe(
          `Error: Herdr wire event failed schema parsing for request ${failure.requestId}: data/data must have required property 'type'; data/data must have required property 'workspace'; data/data must have required property 'type'; data/data must have required property 'workspace'; data/data must have required property 'type'`,
        );
      }),
    ),
  ));

const schemaId = "https://herdr.dev/herdr-api.schema.json";
const runtimeAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
runtimeAjv.addSchema({ ...herdrApiSchema, $id: schemaId });

const waitMatched = makeHerdrSuccessResponse({
  id: "fixture",
  method: "events.wait",
  params: { match_event: { event: "workspace_created", workspace_id: null }, timeout_ms: null },
});
const lifecycleEvent = waitMatched.result.type === "wait_matched" ? waitMatched.result.event : null;
const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
const wireSamples: readonly unknown[] = [
  makeHerdrSuccessResponse({ id: "fixture", method: "ping", params: {} }),
  makeHerdrSuccessResponse({ id: "fixture", method: "workspace.list", params: {} }),
  waitMatched,
  { id: "fixture", result: { type: "pong" } },
  { id: "fixture", result: { type: "workspace_list", workspaces: [{}] } },
  { id: 1, result: { type: "pong", version: "0.9.0", protocol: 22 } },
  { id: "fixture" },
  { id: "fixture", error: { code: "not_found", message: "missing" } },
  { id: "fixture", error: {} },
  lifecycleEvent,
  { event: "workspace_created", data: {} },
  { event: "workspace_created", data: { type: "workspace_updated" } },
  {
    event: "pane.scroll_changed",
    data: { pane_id: "pane-1", workspace_id: "workspace-1", scroll },
  },
  {
    event: "pane.scroll_changed",
    data: { pane_id: "pane-1", scroll: { ...scroll, viewport_rows: -1 } },
  },
  { event: "pane.future_state", data: {} },
  null,
  "text",
  42,
  [],
];

test.for([
  { schemaName: "success_response", generated: parseSuccessResponse, validCount: 3 },
  { schemaName: "error_response", generated: parseErrorResponse, validCount: 1 },
  { schemaName: "event", generated: parseLifecycleEvent, validCount: 1 },
  { schemaName: "subscription_event", generated: parseSubscriptionEvent, validCount: 1 },
])(
  "generated $schemaName validator matches ajv's runtime compile on wire fixtures",
  ({ schemaName, generated, validCount }) => {
    const runtime = runtimeAjv.compile({ $ref: `${schemaId}#/schemas/${schemaName}` });
    let valid = 0;
    for (const sample of wireSamples) {
      const generatedValid = generated(sample);
      expect({ valid: generatedValid, errors: generated.errors }).toStrictEqual({
        valid: runtime(sample),
        errors: runtime.errors,
      });
      if (generatedValid) valid++;
    }
    expect(valid).toBe(validCount);
  },
);
