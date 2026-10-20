/**
 * Public entrypoint for the Effect-native Herdr SDK.
 *
 * Re-exports the platform-neutral SDK from `core.ts` plus the Node.js runtime: ambient configuration, `node:net` sockets, and ready-to-use Layers. Generated wire contracts and socket implementation details remain private.
 *
 * @since 0.8.2
 */
export * from "./core.ts";
export * from "./herdr-node.ts";
