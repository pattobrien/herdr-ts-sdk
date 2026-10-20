/// <reference lib="dom" />
import { Duration, Effect, Layer, Option } from "effect";
import { Socket } from "effect/socket";
import {
  HerdrAbsolutePath,
  HerdrRequestDeadline,
  HerdrSdk,
  herdrConfigLayerFromValue,
  herdrSdkLayerWithoutPlatform,
  herdrWebSocketConnectorLayer,
} from "@herdr/sdk/core";

const search = new URLSearchParams(location.search);
const url = search.get("ws");
const socketPath = search.get("socket");
if (url === null || socketPath === null) throw new Error("expected ?ws=<bridge-url>&socket=<path>");

const herdrLayer = herdrSdkLayerWithoutPlatform.pipe(
  Layer.provide([
    herdrConfigLayerFromValue({
      socketPath: HerdrAbsolutePath.make(socketPath),
      session: Option.none(),
      requestTimeout: HerdrRequestDeadline.make(Duration.seconds(5)),
      application: Option.none(),
      supportedProtocol: 22,
    }),
    herdrWebSocketConnectorLayer(url),
  ]),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
);

const pingAbandonPing = Effect.gen(function* () {
  const herdr = yield* HerdrSdk;
  const first = yield* herdr.server.ping();
  const abandoned = yield* herdr.server
    .ping({ requestId: "abandon", requestTimeout: Duration.millis(300) })
    .pipe(Effect.flip);
  yield* Effect.sleep(Duration.millis(300));
  const afterAbandon = yield* herdr.server.ping();
  return {
    runtime: navigator.userAgent,
    first: first.version,
    abandoned: abandoned._tag,
    afterAbandon: afterAbandon.version,
  };
});

document.body.dataset.result = JSON.stringify(
  await Effect.runPromise(
    pingAbandonPing.pipe(
      Effect.provide(herdrLayer),
      Effect.catchCause((cause) => Effect.succeed({ failure: String(cause) })),
    ),
  ),
);
