/**
 * Owns the platform seam that opens Herdr socket connections.
 *
 * The transports depend on `HerdrSocketConnector` instead of a runtime's socket module, so Node, Bun, and browser programs each provide their own connector Layer.
 *
 * @since 0.9.1
 */
import { Context, type Effect, type Scope, type Stream } from "effect";
import type { Socket } from "effect/socket";

/**
 * One open byte connection to a Herdr endpoint.
 *
 * @category models
 * @since 0.9.1
 */
export interface HerdrSocketConnection {
  /** Pulls received bytes on demand; each run resumes where the previous run stopped, and ending a run early leaves the connection open. */
  readonly read: Stream.Stream<Uint8Array, Socket.SocketError>;
  /** Writes bytes; interrupting a write that may have sent part of a frame closes the connection, because the peer may hold the partial frame. A WebSocket send is a whole message, so it never leaves one. */
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, Socket.SocketError>;
  /** Releases the connection immediately, never as a half-close. */
  readonly close: Effect.Effect<void>;
}

/**
 * Opens scope-owned connections to a Herdr socket endpoint.
 *
 * @category services
 * @since 0.9.1
 */
export interface IHerdrSocketConnector {
  /** Connects to the configured endpoint path; closing the scope releases the connection. */
  readonly connect: (
    endpoint: string,
  ) => Effect.Effect<HerdrSocketConnection, Socket.SocketError, Scope.Scope>;
}

/**
 * Yieldable Effect service supplying the runtime's socket implementation.
 *
 * @category services
 * @since 0.9.1
 */
export class HerdrSocketConnector extends Context.Service<
  HerdrSocketConnector,
  IHerdrSocketConnector
>()("@herdr/sdk/HerdrSocketConnector") {}
