import { Deferred, Duration, Effect, Exit, Fiber, Option, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import {
  acquireSdkTelemetryTestServer,
  sdkTelemetryRecordedSpans,
} from "../scripts/sdk-telemetry-test-server.ts";
import { traceSdkExecution } from "../scripts/sdk-telemetry.mjs";
import packageJson from "../package.json" with { type: "json" };
import { HerdrConfig, HerdrProtocolVersion, HerdrRequestDeadline } from "./herdr-config.ts";
import { parseHerdrAbsolutePath } from "./herdr-domain.ts";
import { HerdrTransport, herdrTransportLayerWithoutDependencies } from "./herdr-transport.ts";
import { herdrNodeSocketConnectorLayer } from "./herdr-node.ts";
import { HerdrRawTestResponse, startHerdrTestServer } from "./herdr-test-server.ts";
import { makeHerdrSuccessResponse } from "./herdr-wire-fixtures.ts";

const parseTracingProtocol = Schema.decodeUnknownEffect(HerdrProtocolVersion);

/** Uses only the local fixture endpoint; ambient Herdr configuration never enters trace tests. */
function withTracingTransport<A, E, R>(
  socketPath: string,
  effect: Effect.Effect<A, E, R | HerdrTransport>,
) {
  return Effect.gen(function* () {
    const absolutePath = yield* parseHerdrAbsolutePath(socketPath);
    const supportedProtocol = yield* parseTracingProtocol(packageJson.herdr.protocol);
    return yield* effect.pipe(
      Effect.provide(herdrTransportLayerWithoutDependencies),
      Effect.provide(herdrNodeSocketConnectorLayer),
      Effect.provideService(
        HerdrConfig,
        HerdrConfig.of({
          socketPath: absolutePath,
          session: Option.none(),
          requestTimeout: HerdrRequestDeadline.make(Duration.seconds(1)),
          application: Option.none(),
          supportedProtocol,
        }),
      ),
    );
  });
}

const spanAttribute = (span: ReturnType<typeof sdkTelemetryRecordedSpans>[number], key: string) =>
  span.attributes.find((attribute) => attribute.key === key)?.value;

test("transport deadline remains a timeout while its unfinished socket wait is interrupted", (context) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const recorder = yield* acquireSdkTelemetryTestServer();
        const server = yield* startHerdrTestServer(() => Effect.void);
        const run = yield* traceSdkExecution(
          { enabled: true, endpoint: recorder.endpoint, kind: "test", name: "transport deadline" },
          withTracingTransport(
            server.socketPath,
            Effect.gen(function* () {
              return yield* (yield* HerdrTransport).request(
                "ping",
                {},
                { requestTimeout: Duration.millis(100) },
              );
            }),
          ),
        );
        expect(Exit.isFailure(run.tracedExit)).toBe(true);
        const spans = sdkTelemetryRecordedSpans(recorder.requests);
        const request = spans.find((span) => span.name === "HerdrTransport.request");
        const wait = spans.find((span) => span.name === "herdr.socket.response.wait");
        expect(request && spanAttribute(request, "herdr.error_tag")?.stringValue).toBe(
          "HerdrRequestTimeout",
        );
        expect(request && spanAttribute(request, "herdr.outcome")?.stringValue).toBe("failure");
        expect(Number(request && spanAttribute(request, "herdr.deadline_ms")?.intValue)).toBe(100);
        expect(wait && spanAttribute(wait, "herdr.outcome")?.stringValue).toBe("interrupted");
        expect(spans.filter((span) => span.name === "herdr.socket.close")).toHaveLength(1);
      }),
    ),
    { signal: context.signal },
  ));

test("transport exports a compatibility check only under the request whose method was unknown", (context) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const recorder = yield* acquireSdkTelemetryTestServer();
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(
            request.method === "ping"
              ? { id: request.id, result: { type: "pong", version: "0.8.2", protocol: 21 } }
              : request.method === "workspace.get"
                ? { id: request.id, error: { code: "unknown_method", message: "private-message" } }
                : makeHerdrSuccessResponse(request),
          ),
        );
        const run = yield* traceSdkExecution(
          {
            enabled: true,
            endpoint: recorder.endpoint,
            kind: "test",
            name: "transport lazy compatibility",
          },
          withTracingTransport(
            server.socketPath,
            Effect.gen(function* () {
              const transport = yield* HerdrTransport;
              yield* transport.request("server.stop", {}, { requestId: "private-ok-request" });
              return yield* transport
                .request(
                  "workspace.get",
                  { workspaceId: "workspace-1" },
                  { requestId: "private-failing-request" },
                )
                .pipe(Effect.flip);
            }),
          ),
        );
        expect(run.tracedExit).toMatchObject({
          _tag: "Success",
          value: { _tag: "HerdrUnsupportedProtocol", actualProtocol: 21 },
        });
        const spans = sdkTelemetryRecordedSpans(recorder.requests);
        const checks = spans.filter((span) => span.name === "herdr.compatibility.check");
        const failedRequests = spans.filter(
          (span) =>
            span.name === "HerdrTransport.request" &&
            spanAttribute(span, "herdr.error_tag")?.stringValue === "HerdrUnsupportedProtocol",
        );
        expect(checks).toHaveLength(1);
        expect(failedRequests).toHaveLength(1);
        expect(spans.filter((span) => span.name === "herdr.compatibility.wait")).toHaveLength(0);
        expect(checks[0]?.parentSpanId).toBe(failedRequests[0]?.spanId);
        expect(checks[0]?.traceId).toBe(run.traceId);
        expect(checks[0] && spanAttribute(checks[0], "herdr.outcome")?.stringValue).toBe("success");
        const connections = spans
          .filter((span) => span.name === "herdr.socket.connect")
          .map((span) => spanAttribute(span, "herdr.connection_id")?.stringValue);
        expect(new Set(connections).size).toBe(3);
        const encoded = JSON.stringify(recorder.requests);
        for (const privateValue of [
          server.socketPath,
          "private-ok-request",
          "private-failing-request",
          "private-message",
        ]) {
          expect(encoded).not.toContain(privateValue);
        }
      }),
    ),
    { signal: context.signal },
  ));

test("transport exports tagged response failures without raw response or cause text", (context) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const recorder = yield* acquireSdkTelemetryTestServer();
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(
            request.method === "ping"
              ? makeHerdrSuccessResponse(request)
              : {
                  id: request.id,
                  error: { code: "private-code", message: "private-server-message" },
                },
          ),
        );
        const run = yield* traceSdkExecution(
          {
            enabled: true,
            endpoint: recorder.endpoint,
            kind: "test",
            name: "transport response failure",
          },
          withTracingTransport(
            server.socketPath,
            Effect.gen(function* () {
              const transport = yield* HerdrTransport;
              return yield* transport.request("server.stop", {}, { requestId: "private-wire-id" });
            }),
          ),
        );
        expect(run.tracedExit).toMatchObject({ _tag: "Failure" });
        const spans = sdkTelemetryRecordedSpans(recorder.requests);
        const failure = spans.find(
          (span) =>
            span.name === "herdr.response.decode" &&
            spanAttribute(span, "herdr.error_tag")?.stringValue === "HerdrServerError",
        );
        expect(failure?.status.code).toBe(2);
        expect(failure && spanAttribute(failure, "herdr.outcome")?.stringValue).toBe("failure");
        for (const privateValue of [
          server.socketPath,
          "private-wire-id",
          "private-code",
          "private-server-message",
        ]) {
          expect(JSON.stringify(recorder.requests)).not.toContain(privateValue);
        }
      }),
    ),
    { signal: context.signal },
  ));

test("transport exports interrupted response wait and completed cleanup without altering interruption", (context) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const recorder = yield* acquireSdkTelemetryTestServer();
        const received = yield* Deferred.make<void>();
        const server = yield* startHerdrTestServer(() =>
          Deferred.succeed(received, undefined).pipe(Effect.asVoid),
        );
        const run = yield* traceSdkExecution(
          {
            enabled: true,
            endpoint: recorder.endpoint,
            kind: "test",
            name: "transport interruption",
          },
          withTracingTransport(
            server.socketPath,
            Effect.gen(function* () {
              const transport = yield* HerdrTransport;
              const request = yield* transport.request("ping", {}).pipe(Effect.forkScoped);
              yield* Deferred.await(received);
              yield* Fiber.interrupt(request);
              return yield* Fiber.await(request);
            }),
          ),
        );
        expect(run.tracedExit).toMatchObject({ _tag: "Success", value: { _tag: "Failure" } });
        const spans = sdkTelemetryRecordedSpans(recorder.requests);
        const wait = spans.find((span) => span.name === "herdr.socket.response.wait");
        const close = spans.find((span) => span.name === "herdr.socket.close");
        expect(wait && spanAttribute(wait, "herdr.outcome")?.stringValue).toBe("interrupted");
        expect(close && spanAttribute(close, "herdr.outcome")?.stringValue).toBe("success");
        expect(
          close && wait && BigInt(close.startTimeUnixNano) >= BigInt(wait.endTimeUnixNano),
        ).toBe(true);
      }),
    ),
    { signal: context.signal },
  ));

test("transport malformed framing retains its tagged reason in exported wait diagnostics", (context) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const recorder = yield* acquireSdkTelemetryTestServer();
        const server = yield* startHerdrTestServer(() =>
          Effect.succeed(new HerdrRawTestResponse("private-invalid-json\n")),
        );
        const run = yield* traceSdkExecution(
          {
            enabled: true,
            endpoint: recorder.endpoint,
            kind: "test",
            name: "transport malformed response",
          },
          withTracingTransport(
            server.socketPath,
            Effect.gen(function* () {
              return yield* (yield* HerdrTransport).request("ping", {});
            }),
          ),
        );
        expect(Exit.isFailure(run.tracedExit)).toBe(true);
        const wait = sdkTelemetryRecordedSpans(recorder.requests).find(
          (span) => span.name === "herdr.socket.response.wait",
        );
        expect(wait && spanAttribute(wait, "herdr.error_tag")?.stringValue).toBe(
          "HerdrInvalidResponse",
        );
        expect(wait && spanAttribute(wait, "herdr.reason")?.stringValue).toBe("malformed_json");
        expect(JSON.stringify(recorder.requests)).not.toContain("private-invalid-json");
      }),
    ),
    { signal: context.signal },
  ));
