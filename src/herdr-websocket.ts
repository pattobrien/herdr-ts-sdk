/**
 * Connects to Herdr through a WebSocket bridge using `effect/socket`.
 *
 * A bridge such as `websocat --binary -E ws-l:127.0.0.1:PORT unix:$HERDR_SOCKET_PATH` maps each WebSocket to one Unix socket connection, so browsers and other runtimes without Unix sockets can reach Herdr.
 *
 * @since 0.9.1
 */
import { Cause, Effect, Exit, Layer, Scope, Stream } from "effect";
import { Socket } from "effect/socket";
import { HerdrSocketConnector } from "./herdr-socket.ts";

/**
 * Opens one WebSocket per Herdr connection to `url`, whatever endpoint the SDK requests.
 *
 * Each connection gets its own `Socket.makeWebSocket`, because one `Socket` writes only to its most recently opened WebSocket.
 *
 * @category layers
 * @since 0.9.1
 */
export function herdrWebSocketConnectorLayer(
  url: string,
): Layer.Layer<HerdrSocketConnector, never, Socket.WebSocketConstructor> {
  return Layer.effect(
    HerdrSocketConnector,
    Effect.gen(function* () {
      const makeWebSocket = yield* Socket.WebSocketConstructor;
      return HerdrSocketConnector.of({
        connect: () =>
          Effect.gen(function* () {
            const socket = yield* Socket.makeWebSocket(url).pipe(
              Effect.provideService(Socket.WebSocketConstructor, makeWebSocket),
            );
            const scope = yield* Scope.fork(yield* Effect.scope);
            const pull = yield* Socket.readerBytes(socket).pipe(
              Scope.provide(scope),
              Effect.onError(() => Scope.close(scope, Exit.void)),
            );
            const writer = yield* socket.writer.pipe(Scope.provide(scope));
            return {
              read: Stream.fromPull(
                Effect.succeed(
                  pull.pipe(
                    Effect.catchIf(
                      (error) =>
                        error.reason._tag === "SocketCloseError" && error.reason.code === 1000,
                      () => Cause.done(),
                    ),
                  ),
                ),
              ),
              write: writer.write,
              close: Scope.close(scope, Exit.void),
            };
          }),
      });
    }),
  );
}
