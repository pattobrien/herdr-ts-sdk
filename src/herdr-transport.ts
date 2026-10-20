/**
 * Owns Herdr Unix-socket requests, compatibility, and stream handshakes.
 *
 * The transport correlates NDJSON responses, shares protocol compatibility checks, enforces deadlines and frame limits, translates server failures, and scopes socket cleanup.
 *
 * @since 0.8.2
 */
import {
  Cache,
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
  Tracer,
} from "effect";
import {
  type WireMethod,
  type WireMethodMap,
  wireResultTypesByMethod,
} from "./generated/wire-method-map.ts";
import type { ErrorResponse } from "./generated/wire-error-response.ts";
import herdrApiSchema from "../schema/herdr-api.schema.json" with { type: "json" };
import type { ResponseResult } from "./generated/wire-success-response.ts";
import { isExpectedWireResult, parseHerdrWireResponse } from "./herdr-wire-parser.ts";
import { encodeWireRequest, type HerdrWireParameters } from "./herdr-wire-encoder.ts";
import { HerdrConfig, HerdrRequestDeadline } from "./herdr-config.ts";
import type { HerdrAbsolutePath } from "./herdr-domain.ts";
import {
  HerdrInvalidInput,
  HerdrInvalidResponse,
  HerdrRequestTimeout,
  HerdrServerError,
  HerdrTransportError,
  HerdrUnsupportedEvent,
  HerdrUnsupportedProtocol,
  HerdrUnsupportedResult,
} from "./herdr-errors.ts";
import {
  type HerdrSocketLineBuffer,
  makeHerdrSocketLineBuffer,
  splitHerdrSocketLines,
} from "./herdr-socket-lines.ts";
import { type HerdrSocketConnection, HerdrSocketConnector } from "./herdr-socket.ts";

const MAX_RESPONSE_LINE_BYTES = 1024 * 1024;
const responseUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const requestUtf8Encoder = new TextEncoder();

/** Keeps wire parameter types available from the transport import path. */
export type { HerdrWireParameters } from "./herdr-wire-encoder.ts";

/**
 * Local request options applied by the transport rather than the Herdr server.
 *
 * @category schemas
 * @since 0.8.2
 */
export const HerdrTransportRequestOptions = Schema.Struct({
  requestId: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
  requestTimeout: Schema.OptionFromOptionalKey(HerdrRequestDeadline),
});

/**
 * Normalized local request options consumed by transport internals.
 *
 * @category models
 * @since 0.8.2
 */
export interface HerdrTransportRequestOptions extends Schema.Schema.Type<
  typeof HerdrTransportRequestOptions
> {}

/**
 * Ergonomic request options accepted by public SDK operations.
 *
 * @category models
 * @since 0.8.2
 */
export interface HerdrTransportRequestOptionsEncoded extends Schema.Codec.Encoded<
  typeof HerdrTransportRequestOptions
> {}

/**
 * Expected failures shared by ordinary Herdr transport requests.
 *
 * @category errors
 * @since 0.8.2
 */
export type HerdrTransportRequestError =
  | HerdrTransportError
  | HerdrInvalidInput
  | HerdrRequestTimeout
  | HerdrInvalidResponse
  | HerdrUnsupportedProtocol
  | HerdrUnsupportedResult
  | HerdrServerError;

/**
 * Expected request failures for a specific generated Herdr method.
 *
 * @category errors
 * @since 0.8.2
 */
export type HerdrTransportMethodError<Method extends WireMethod> =
  | HerdrTransportRequestError
  | (Method extends "events.wait" ? HerdrUnsupportedEvent : never);

type HerdrOrdinaryWireMethod = Exclude<WireMethod, "events.wait">;

/**
 * Correlated success returned after the generated method result contract is checked.
 *
 * @category models
 * @since 0.8.2
 */
export interface HerdrTransportSuccess<Method extends WireMethod> {
  /** Wire request identifier echoed by the server. */
  readonly requestId: string;
  /** Generated result variant associated with the requested method. */
  readonly result: WireMethodMap[Method]["result"];
}

/**
 * Scoped stream handshake retaining the socket until the owning scope closes.
 *
 * @category models
 * @since 0.8.2
 */
export interface HerdrTransportStream<
  Method extends "events.subscribe" | "pane.graphics.stream",
> extends HerdrTransportSuccess<Method> {
  /** Pulls ordered socket bytes on demand with scoped cleanup. */
  readonly readBytes: Stream.Stream<Uint8Array, HerdrTransportError>;
  /** Writes bytes through the acquired stream resource. */
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, HerdrTransportError>;
}

/**
 * Deep Unix-socket and protocol capability shared by every Herdr namespace service.
 *
 * @category services
 * @since 0.8.2
 */
export interface IHerdrTransport {
  /** Sends one request after the shared protocol compatibility check. */
  readonly request: {
    <Method extends HerdrOrdinaryWireMethod>(
      method: Method,
      params: HerdrWireParameters<Method>,
      options?: HerdrTransportRequestOptionsEncoded,
    ): Effect.Effect<HerdrTransportSuccess<Method>, HerdrTransportRequestError>;
    (
      method: "events.wait",
      params: HerdrWireParameters<"events.wait">,
      options?: HerdrTransportRequestOptionsEncoded,
    ): Effect.Effect<
      HerdrTransportSuccess<"events.wait">,
      HerdrTransportRequestError | HerdrUnsupportedEvent
    >;
  };
  /** Acquires a long-lived subscription or graphics socket in the current scope. */
  readonly openStream: <Method extends "events.subscribe" | "pane.graphics.stream">(
    method: Method,
    params: HerdrWireParameters<Method>,
    options?: HerdrTransportRequestOptionsEncoded,
  ) => Effect.Effect<HerdrTransportStream<Method>, HerdrTransportRequestError, Scope.Scope>;
  /** Applies one deadline to a stream write and its optional acknowledgement; the caller owns acknowledgement failure cleanup. */
  readonly writeStreamBytes: {
    (
      stream: HerdrTransportStream<"pane.graphics.stream">,
      bytes: Uint8Array,
      options?: HerdrTransportRequestOptionsEncoded,
    ): Effect.Effect<void, HerdrInvalidInput | HerdrTransportError | HerdrRequestTimeout>;
    <A, E, R>(
      stream: HerdrTransportStream<"pane.graphics.stream">,
      bytes: Uint8Array,
      options: HerdrTransportRequestOptionsEncoded | undefined,
      acknowledgement: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, HerdrInvalidInput | HerdrTransportError | HerdrRequestTimeout | E, R>;
  };
}

/**
 * Yieldable Effect service owning Herdr Unix-socket and protocol operations.
 *
 * @category services
 * @since 0.8.2
 */
export class HerdrTransport extends Context.Service<HerdrTransport, IHerdrTransport>()(
  "@herdr/sdk/HerdrTransport",
) {}

const parseHerdrTransportRequestOptions = Schema.decodeEffect(HerdrTransportRequestOptions);

const HerdrWaitEventProbe = Schema.Struct({
  result: Schema.Struct({
    type: Schema.Literal("wait_matched"),
    event: Schema.Struct({ event: Schema.String }),
  }),
});

const parseHerdrWaitEventProbe = Schema.decodeUnknownOption(HerdrWaitEventProbe);
const supportedWaitEventKinds = new Set<string>(herdrApiSchema.schemas.event.$defs.EventKind.enum);

type TransportOperation = HerdrTransportError["operation"];

/** Socket identity is generated locally and never derived from a path or wire request ID. */
const herdrSocketConnectionIds = new WeakMap<HerdrSocketConnection, string>();

/** Annotates diagnostics without recovering, replacing, or stringifying the original exit. */
function annotateHerdrTransportExit<
  A,
  E extends HerdrTransportRequestError | HerdrUnsupportedEvent,
>(exit: Exit.Exit<A, E>): Effect.Effect<void> {
  if (Exit.isSuccess(exit)) return Effect.annotateCurrentSpan("herdr.outcome", "success");
  const error = Cause.findErrorOption(exit.cause);
  return Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan(
      "herdr.outcome",
      Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failure",
    );
    if (Option.isNone(error)) return;
    yield* Effect.annotateCurrentSpan("herdr.error_tag", error.value._tag);
    if (error.value._tag === "HerdrTransportError" || error.value._tag === "HerdrInvalidResponse") {
      yield* Effect.annotateCurrentSpan("herdr.reason", error.value.reason);
    }
  });
}

/** Keeps finite transport phase spans and their exit classification in the same boundary. */
function traceHerdrTransportPhase<
  A,
  E extends HerdrTransportRequestError | HerdrUnsupportedEvent,
  R,
>(
  effect: Effect.Effect<A, E, R>,
  name:
    | "herdr.compatibility.wait"
    | "herdr.compatibility.check"
    | "herdr.socket.connect"
    | "herdr.socket.write"
    | "herdr.socket.response.wait"
    | "herdr.response.decode"
    | "herdr.socket.close",
  options?: Tracer.SpanOptions,
): Effect.Effect<A, E, R> {
  return effect.pipe(Effect.onExit(annotateHerdrTransportExit), Effect.withSpan(name, options));
}

/**
 * Constructs the transport while preserving its Herdr configuration requirement.
 *
 * @category constructors
 * @since 0.8.2
 */
export const makeHerdrTransport = Effect.gen(function* () {
  const config = yield* HerdrConfig;
  const connector = yield* HerdrSocketConnector;

  const requestWithoutCompatibility = <Method extends WireMethod>(
    operation: TransportOperation,
    method: Method,
    params: HerdrWireParameters<Method>,
    requestId: string,
    deadline: HerdrRequestDeadline,
  ): Effect.Effect<
    HerdrTransportSuccess<Method>,
    HerdrTransportRequestError | HerdrUnsupportedEvent
  > => {
    return Effect.gen(function* () {
      const payload = encodeWireRequest(requestId, method, params);
      yield* Effect.annotateCurrentSpan({
        "herdr.method": method,
        "herdr.operation": operation,
        "herdr.deadline_ms": Duration.toMillis(deadline),
      });
      const value = yield* exchangeWireLine(
        connector,
        config.socketPath,
        payload,
        operation,
        requestId,
        deadline,
      );
      return yield* traceHerdrTransportPhase(
        Effect.gen(function* () {
          const response = yield* Effect.try({
            try: () => parseHerdrWireResponse(value, requestId),
            catch: (cause) => {
              const eventProbe = parseHerdrWaitEventProbe(value);
              return method === "events.wait" &&
                Option.isSome(eventProbe) &&
                !supportedWaitEventKinds.has(eventProbe.value.result.event.event)
                ? new HerdrUnsupportedEvent(eventProbe.value.result.event.event, requestId)
                : new HerdrInvalidResponse("schema_mismatch", requestId, cause);
            },
          });

          if (response.id !== requestId) {
            return yield* new HerdrInvalidResponse(
              "correlation_mismatch",
              requestId,
              new Error(`Herdr returned response ID ${response.id}`),
            );
          }
          if (isWireErrorResponse(response)) {
            return yield* new HerdrServerError(
              response.error.code,
              response.error.message,
              requestId,
            );
          }
          if (
            response.result.type === "wait_matched" &&
            response.result.event.event !== response.result.event.data.type
          ) {
            return yield* new HerdrInvalidResponse(
              "schema_mismatch",
              requestId,
              new Error("Herdr wait event envelope disagrees with its data type"),
            );
          }
          if (!isExpectedWireResult(method, response.result)) {
            return yield* new HerdrUnsupportedResult(
              method,
              response.result.type,
              wireResultTypesByMethod[method].join(" or "),
              requestId,
            );
          }
          yield* Effect.annotateCurrentSpan("herdr.result_type", response.result.type);
          return { requestId, result: response.result };
        }),
        "herdr.response.decode",
        { attributes: { "herdr.method": method, "herdr.operation": operation } },
      ).pipe(
        Effect.tap((response) =>
          Effect.annotateCurrentSpan("herdr.result_type", response.result.type),
        ),
      );
    });
  };

  const pingParameters: HerdrWireParameters<"ping"> = Option.match(config.application, {
    onNone: () => ({}),
    onSome: (application) => ({
      application: {
        name: application.name,
        ...(Option.isSome(application.version) ? { version: application.version.value } : {}),
      },
    }),
  });

  const compatibilityCache = yield* Cache.makeWith(
    (_key: "compatibility") =>
      Effect.gen(function* () {
        const { requestId, result } = yield* requestWithoutCompatibility(
          "compatibility_check",
          "ping",
          pingParameters,
          crypto.randomUUID(),
          config.requestTimeout,
        ).pipe(Effect.catchTag("HerdrUnsupportedEvent", Effect.die));
        if (result.protocol !== config.supportedProtocol) {
          return yield* new HerdrUnsupportedProtocol(
            result.protocol,
            config.supportedProtocol,
            requestId,
          );
        }
        const checkSpan = yield* Effect.serviceOption(Tracer.ParentSpan);
        // Cache only immutable trace identity, never the root's attributes, events, or mutable status.
        return Option.map(checkSpan, (span) =>
          Tracer.externalSpan({
            traceId: span.traceId,
            spanId: span.spanId,
            sampled: span.sampled,
          }),
        );
      }).pipe(
        Effect.onExit(annotateHerdrTransportExit),
        // A shared lookup belongs to all waiters, not whichever request happened to win the cache race.
        Effect.withSpan("herdr.compatibility.check", { root: true }),
      ),
    {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );
  const compatibilityCheck = traceHerdrTransportPhase(
    Effect.gen(function* () {
      const checkSpan = yield* Cache.get(compatibilityCache, "compatibility");
      const waiterSpan = yield* Effect.serviceOption(Tracer.ParentSpan);
      if (
        Option.isSome(checkSpan) &&
        Option.isSome(waiterSpan) &&
        waiterSpan.value._tag === "Span"
      ) {
        waiterSpan.value.addLinks([{ span: checkSpan.value, attributes: {} }]);
      }
    }),
    "herdr.compatibility.wait",
  );

  const openStream = <Method extends "events.subscribe" | "pane.graphics.stream">(
    method: Method,
    params: HerdrWireParameters<Method>,
    options: HerdrTransportRequestOptionsEncoded = {},
  ): Effect.Effect<HerdrTransportStream<Method>, HerdrTransportRequestError, Scope.Scope> => {
    const operation = method === "events.subscribe" ? "event_subscription" : "graphics_stream";

    return Effect.fn("HerdrTransport.openStream")(function* () {
      const parsedOptions = yield* parseHerdrTransportRequestOptions(options).pipe(
        Effect.mapError((cause) => new HerdrInvalidInput("transport.requestOptions", cause)),
      );
      const requestId = Option.getOrElse(parsedOptions.requestId, () => crypto.randomUUID());
      const deadline = Option.getOrElse(parsedOptions.requestTimeout, () => config.requestTimeout);
      const payload = encodeWireRequest(requestId, method, params);
      yield* Effect.annotateCurrentSpan({
        "herdr.method": method,
        "herdr.operation": operation,
        "herdr.deadline_ms": Duration.toMillis(deadline),
      });
      return yield* Effect.gen(function* () {
        yield* compatibilityCheck;
        const socket = yield* Effect.acquireRelease(
          connectSocket(connector, config.socketPath, operation, requestId),
          closeSocket,
          { interruptible: true },
        );
        return yield* Effect.gen(function* () {
          yield* writeSocketPayload(socket, payload, operation, requestId);
          const handshake = yield* readSocketLine(socket, operation, requestId);
          const result = yield* traceHerdrTransportPhase(
            Effect.gen(function* () {
              const response = yield* Effect.try({
                try: () => parseHerdrWireResponse(handshake.value, requestId),
                catch: (cause) => new HerdrInvalidResponse("schema_mismatch", requestId, cause),
              });
              if (response.id !== requestId) {
                return yield* new HerdrInvalidResponse(
                  "correlation_mismatch",
                  requestId,
                  new Error(`Herdr returned response ID ${response.id}`),
                );
              }
              if (isWireErrorResponse(response)) {
                return yield* new HerdrServerError(
                  response.error.code,
                  response.error.message,
                  requestId,
                );
              }
              if (!isExpectedWireResult(method, response.result)) {
                return yield* new HerdrUnsupportedResult(
                  method,
                  response.result.type,
                  wireResultTypesByMethod[method].join(" or "),
                  requestId,
                );
              }
              yield* Effect.annotateCurrentSpan("herdr.result_type", response.result.type);
              return response.result;
            }),
            "herdr.response.decode",
            { attributes: { "herdr.method": method, "herdr.operation": operation } },
          );
          yield* Effect.annotateCurrentSpan("herdr.result_type", result.type);
          const writeSemaphore = yield* Semaphore.make(1);
          return {
            requestId,
            result,
            readBytes: makeHerdrSocketByteStream(socket, handshake.remainder, operation, requestId),
            write: (bytes: Uint8Array) =>
              writeSemaphore
                .withPermit(writeSocketPayload(socket, bytes, "graphics_write", requestId))
                .pipe(Effect.onInterrupt(() => closeSocket(socket))),
          };
        }).pipe(Effect.onError(() => closeSocket(socket)));
      }).pipe(
        Effect.timeoutOrElse({
          duration: deadline,
          orElse: () =>
            Effect.fail(new HerdrRequestTimeout(operation, requestId, Duration.toMillis(deadline))),
        }),
      );
    }, Effect.onExit(annotateHerdrTransportExit))();
  };

  function request<Method extends HerdrOrdinaryWireMethod>(
    method: Method,
    params: HerdrWireParameters<Method>,
    options?: HerdrTransportRequestOptionsEncoded,
  ): Effect.Effect<HerdrTransportSuccess<Method>, HerdrTransportRequestError>;
  function request(
    method: "events.wait",
    params: HerdrWireParameters<"events.wait">,
    options?: HerdrTransportRequestOptionsEncoded,
  ): Effect.Effect<
    HerdrTransportSuccess<"events.wait">,
    HerdrTransportRequestError | HerdrUnsupportedEvent
  >;
  function request<Method extends WireMethod>(
    method: Method,
    params: HerdrWireParameters<Method>,
    options: HerdrTransportRequestOptionsEncoded = {},
  ): Effect.Effect<
    HerdrTransportSuccess<Method>,
    HerdrTransportRequestError | HerdrUnsupportedEvent
  > {
    return Effect.fn("HerdrTransport.request")(function* () {
      const parsedOptions = yield* parseHerdrTransportRequestOptions(options).pipe(
        Effect.mapError((cause) => new HerdrInvalidInput("transport.requestOptions", cause)),
      );
      const requestId = Option.getOrElse(parsedOptions.requestId, () => crypto.randomUUID());
      const deadline = Option.getOrElse(parsedOptions.requestTimeout, () => config.requestTimeout);
      yield* Effect.annotateCurrentSpan({
        "herdr.method": method,
        "herdr.operation": method === "ping" ? "compatibility_check" : "request",
        "herdr.deadline_ms": Duration.toMillis(deadline),
      });
      return yield* Effect.gen(function* () {
        if (method === "ping") {
          return yield* traceHerdrTransportPhase(
            Effect.gen(function* () {
              const response = yield* requestWithoutCompatibility(
                "compatibility_check",
                method,
                params,
                requestId,
                deadline,
              );
              yield* verifyProtocolCompatibility(
                response.result,
                response.requestId,
                config.supportedProtocol,
              );
              return response;
            }),
            "herdr.compatibility.check",
          );
        }
        yield* compatibilityCheck;
        return yield* requestWithoutCompatibility("request", method, params, requestId, deadline);
      }).pipe(
        Effect.timeoutOrElse({
          duration: deadline,
          orElse: () =>
            Effect.fail(
              new HerdrRequestTimeout(
                method === "ping" ? "compatibility_check" : "request",
                requestId,
                Duration.toMillis(deadline),
              ),
            ),
        }),
      );
    }, Effect.onExit(annotateHerdrTransportExit))();
  }

  function writeStreamBytes(
    stream: HerdrTransportStream<"pane.graphics.stream">,
    bytes: Uint8Array,
    options?: HerdrTransportRequestOptionsEncoded,
  ): Effect.Effect<void, HerdrInvalidInput | HerdrTransportError | HerdrRequestTimeout>;
  function writeStreamBytes<A, E, R>(
    stream: HerdrTransportStream<"pane.graphics.stream">,
    bytes: Uint8Array,
    options: HerdrTransportRequestOptionsEncoded | undefined,
    acknowledgement: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, HerdrInvalidInput | HerdrTransportError | HerdrRequestTimeout | E, R>;
  function writeStreamBytes<A, E, R>(
    stream: HerdrTransportStream<"pane.graphics.stream">,
    bytes: Uint8Array,
    options: HerdrTransportRequestOptionsEncoded = {},
    acknowledgement?: Effect.Effect<A, E, R>,
  ): Effect.Effect<void | A, HerdrInvalidInput | HerdrTransportError | HerdrRequestTimeout | E, R> {
    return Effect.fn("HerdrTransport.writeStreamBytes")(function* () {
      const parsedOptions = yield* parseHerdrTransportRequestOptions(options).pipe(
        Effect.mapError((cause) => new HerdrInvalidInput("transport.requestOptions", cause)),
      );
      const deadline = Option.getOrElse(parsedOptions.requestTimeout, () => config.requestTimeout);
      yield* Effect.annotateCurrentSpan({
        "herdr.method": "pane.graphics.stream",
        "herdr.operation": "graphics_write",
        "herdr.deadline_ms": Duration.toMillis(deadline),
      });
      return yield* Effect.gen(function* () {
        yield* stream.write(bytes);
        if (acknowledgement !== undefined) return yield* acknowledgement;
      }).pipe(
        Effect.timeoutOrElse({
          duration: deadline,
          orElse: () =>
            Effect.fail(
              new HerdrRequestTimeout(
                "graphics_write",
                stream.requestId,
                Duration.toMillis(deadline),
              ),
            ),
        }),
      );
    })();
  }

  return HerdrTransport.of({ openStream, request, writeStreamBytes });
});

/**
 * Provides the transport while retaining its Herdr configuration requirement.
 *
 * @category layers
 * @since 0.8.2
 */
export const herdrTransportLayerWithoutDependencies: Layer.Layer<
  HerdrTransport,
  never,
  HerdrConfig | HerdrSocketConnector
> = Layer.effect(HerdrTransport, makeHerdrTransport);

function connectSocket(
  connector: HerdrSocketConnector["Service"],
  socketPath: HerdrAbsolutePath,
  operation: TransportOperation,
  requestId: string,
): Effect.Effect<HerdrSocketConnection, HerdrTransportError, Scope.Scope> {
  return Effect.suspend(() => {
    const connectionId = crypto.randomUUID();
    return traceHerdrTransportPhase(
      connector.connect(socketPath).pipe(
        Effect.tap((connection) =>
          Effect.sync(() => herdrSocketConnectionIds.set(connection, connectionId)),
        ),
        Effect.mapError((cause) => new HerdrTransportError(operation, "connect", requestId, cause)),
      ),
      "herdr.socket.connect",
      { attributes: { "herdr.operation": operation, "herdr.connection_id": connectionId } },
    );
  });
}

/** Measures the connector's immediate release, not a later platform close notification. */
function closeSocket(connection: HerdrSocketConnection): Effect.Effect<void> {
  return traceHerdrTransportPhase(connection.close, "herdr.socket.close", {
    attributes: { "herdr.connection_id": herdrSocketConnectionIds.get(connection) },
  });
}

function makeHerdrSocketByteStream(
  connection: HerdrSocketConnection,
  initialBytes: readonly Uint8Array[],
  operation: TransportOperation,
  requestId: string,
): Stream.Stream<Uint8Array, HerdrTransportError> {
  const socketBytes = connection.read.pipe(
    Stream.mapError((cause) => new HerdrTransportError(operation, "read", requestId, cause)),
  );
  return (
    initialBytes.length === 0
      ? socketBytes
      : Stream.concat(Stream.fromIterable(initialBytes), socketBytes)
  ).pipe(Stream.ensuring(connection.close));
}

function writeSocketPayload(
  connection: HerdrSocketConnection,
  payload: string | Uint8Array,
  operation: TransportOperation,
  requestId: string,
): Effect.Effect<void, HerdrTransportError> {
  const bytes = typeof payload === "string" ? requestUtf8Encoder.encode(payload) : payload;
  return traceHerdrTransportPhase(
    connection.write(bytes).pipe(
      Effect.mapError((cause) => new HerdrTransportError(operation, "write", requestId, cause)),
      Effect.tap(() => Effect.annotateCurrentSpan("herdr.bytes_written", bytes.byteLength)),
    ),
    "herdr.socket.write",
    {
      attributes: {
        "herdr.operation": operation,
        "herdr.connection_id": herdrSocketConnectionIds.get(connection),
      },
    },
  );
}

interface HerdrSocketLine {
  readonly value: unknown;
  readonly remainder: readonly Uint8Array[];
  /** Complete framed response bytes, including newline but excluding retained stream remainder. */
  readonly bytesRead: number;
}

function readSocketLine(
  connection: HerdrSocketConnection,
  operation: TransportOperation,
  requestId: string,
): Effect.Effect<HerdrSocketLine, HerdrTransportError | HerdrInvalidResponse> {
  return traceHerdrTransportPhase(
    Effect.gen(function* () {
      const line = yield* connection.read.pipe(
        Stream.mapError((cause) => new HerdrTransportError(operation, "read", requestId, cause)),
        Stream.mapAccumArrayEffect(makeHerdrSocketLineBuffer, (state, chunks) =>
          parseFirstHerdrSocketLine(state, chunks, requestId),
        ),
        Stream.runHead,
      );
      if (Option.isSome(line)) {
        yield* Effect.annotateCurrentSpan("herdr.bytes_read", line.value.bytesRead);
        return line.value;
      }
      return yield* new HerdrTransportError(
        operation,
        "premature_close",
        requestId,
        new Error("Herdr closed the socket before sending a complete response line"),
      );
    }),
    "herdr.socket.response.wait",
    {
      attributes: {
        "herdr.operation": operation,
        "herdr.connection_id": herdrSocketConnectionIds.get(connection),
      },
    },
  );
}

function parseFirstHerdrSocketLine(
  state: HerdrSocketLineBuffer,
  chunks: readonly Uint8Array[],
  requestId: string,
): Effect.Effect<
  readonly [HerdrSocketLineBuffer, readonly HerdrSocketLine[]],
  HerdrInvalidResponse
> {
  return Effect.gen(function* () {
    const split = splitHerdrSocketLines(state, chunks, MAX_RESPONSE_LINE_BYTES, requestId, 1);
    if (Result.isFailure(split)) return yield* split.failure;

    const lineBytes = split.success.lines.at(0);
    if (lineBytes === undefined) return [split.success.buffer, []];

    const value = yield* Effect.try({
      try: () => JSON.parse(responseUtf8Decoder.decode(lineBytes)),
      catch: (cause) => new HerdrInvalidResponse("malformed_json", requestId, cause),
    });
    return [
      split.success.buffer,
      [{ value, remainder: split.success.remainder, bytesRead: lineBytes.byteLength + 1 }],
    ];
  });
}

function isWireErrorResponse(
  response: ReturnType<typeof parseHerdrWireResponse>,
): response is ErrorResponse {
  return "error" in response && !("result" in response);
}

function verifyProtocolCompatibility(
  result: ResponseResult,
  requestId: string,
  supportedProtocol: 22,
): Effect.Effect<void, HerdrUnsupportedProtocol | HerdrUnsupportedResult> {
  if (result.type !== "pong") {
    return Effect.fail(new HerdrUnsupportedResult("ping", result.type, "pong", requestId));
  }
  return result.protocol === supportedProtocol
    ? Effect.void
    : Effect.fail(new HerdrUnsupportedProtocol(result.protocol, supportedProtocol, requestId));
}

function exchangeWireLine(
  connector: HerdrSocketConnector["Service"],
  socketPath: HerdrAbsolutePath,
  payload: string,
  operation: TransportOperation,
  requestId: string,
  deadline: HerdrRequestDeadline,
): Effect.Effect<unknown, HerdrTransportError | HerdrRequestTimeout | HerdrInvalidResponse> {
  const exchange = Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* Effect.acquireRelease(
        connectSocket(connector, socketPath, operation, requestId),
        closeSocket,
        { interruptible: true },
      );
      yield* writeSocketPayload(connection, payload, operation, requestId);
      const response = yield* readSocketLine(connection, operation, requestId);
      return response.value;
    }),
  );

  return exchange.pipe(
    Effect.timeoutOrElse({
      duration: deadline,
      orElse: () =>
        Effect.fail(new HerdrRequestTimeout(operation, requestId, Duration.toMillis(deadline))),
    }),
  );
}
