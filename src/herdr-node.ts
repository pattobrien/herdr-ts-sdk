/**
 * Provides the Node.js runtime for the Herdr SDK.
 *
 * Resolves configuration from explicit options or ambient inputs, opens Unix sockets and Windows named pipes with `node:net`, and assembles the ready-to-use Layers.
 *
 * @since 0.8.2
 */
import { homedir } from "node:os";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { NodeStream } from "@effect/platform-node-shared";
import { Config, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import {
  SocketError,
  SocketOpenError,
  SocketReadError,
  SocketWriteError,
} from "effect/socket/Socket";
import {
  HerdrConfig,
  HerdrConfigOptions,
  HerdrProtocolVersion,
  HerdrRequestDeadline,
  type IHerdrConfig,
} from "./herdr-config.ts";
import {
  HerdrAbsolutePath,
  type HerdrAbsolutePath as HerdrAbsolutePathValue,
  HerdrSessionName,
} from "./herdr-domain.ts";
import { HerdrConfigurationError } from "./herdr-errors.ts";
import { type HerdrSdk, herdrSdkLayerWithoutPlatform } from "./herdr-sdk.ts";
import { type HerdrSocketConnection, HerdrSocketConnector } from "./herdr-socket.ts";
import { type HerdrTransport, herdrTransportLayerWithoutDependencies } from "./herdr-transport.ts";
import { serverServiceLayerWithoutDependencies } from "./server-service.ts";
import { sessionServiceLayerWithoutDependencies } from "./session-service.ts";
import { notificationServiceLayerWithoutDependencies } from "./notification-service.ts";
import { clientServiceLayerWithoutDependencies } from "./client-service.ts";
import { commandServiceLayerWithoutDependencies } from "./command-service.ts";
import { clientShellServiceLayerWithoutDependencies } from "./client-shell-service.ts";
import { productAnnouncementServiceLayerWithoutDependencies } from "./product-announcement-service.ts";
import { releaseNotesServiceLayerWithoutDependencies } from "./release-notes-service.ts";
import { workspaceServiceLayerWithoutDependencies } from "./workspace-service.ts";
import { worktreeServiceLayerWithoutDependencies } from "./worktree-service.ts";
import { tabServiceLayerWithoutDependencies } from "./tab-service.ts";
import { paneServiceLayerWithoutDependencies } from "./pane-service.ts";
import { layoutServiceLayerWithoutDependencies } from "./layout-service.ts";
import { agentServiceLayerWithoutDependencies } from "./agent-service.ts";
import { eventServiceLayerWithoutDependencies } from "./event-service.ts";
import { integrationServiceLayerWithoutDependencies } from "./integration-service.ts";
import { pluginServiceLayerWithoutDependencies } from "./plugin-service.ts";
import { popupServiceLayerWithoutDependencies } from "./popup-service.ts";

const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(5);

const parseHerdrConfigOptions = Schema.decodeEffect(HerdrConfigOptions);
const parseHerdrRequestDeadlineFromString = Schema.decodeEffect(
  Schema.DurationFromString.pipe(Schema.decodeTo(HerdrRequestDeadline)),
);
const parseHerdrAbsolutePath = Schema.decodeEffect(HerdrAbsolutePath);
const parseHerdrSessionName = Schema.decodeEffect(HerdrSessionName);

const ambientHerdrConfig = Config.all({
  socketPath: Config.option(Config.String("HERDR_SOCKET_PATH")),
  session: Config.option(Config.String("HERDR_SESSION")),
  configDirectory: Config.option(Config.String("HERDR_CONFIG_DIR")),
  xdgConfigHome: Config.option(Config.String("XDG_CONFIG_HOME")),
  appData: Config.option(Config.String("APPDATA")),
  requestTimeout: Config.option(Config.String("HERDR_REQUEST_TIMEOUT")),
});

type AmbientHerdrConfig = Config.Success<typeof ambientHerdrConfig>;
type ParsedHerdrConfigOptions = typeof HerdrConfigOptions.Type;

/**
 * Effect Config recipe that resolves ambient Herdr SDK configuration.
 *
 * @category configuration
 * @since 0.8.2
 */
export const herdrConfigRecipe: Config.Config<IHerdrConfig> = ambientHerdrConfig.pipe(
  Config.mapEffect((ambient) =>
    resolveHerdrConfig({}, ambient).pipe(Effect.mapError((cause) => new Config.ConfigError(cause))),
  ),
);

const makeHerdrConfigEffect = Effect.fn("HerdrConfig.make")(
  function* (options: HerdrConfigOptions) {
    const parsedOptions = yield* parseHerdrConfigOptions(options);
    const ambient = yield* ambientHerdrConfig;
    const config = yield* resolveHerdrConfig(parsedOptions, ambient);
    return HerdrConfig.of(config);
  },
  Effect.mapError((cause) => new HerdrConfigurationError(cause)),
);

/**
 * Constructs Herdr configuration using explicit options before ambient configuration.
 *
 * @category constructors
 * @since 0.8.2
 */
export function makeHerdrConfig(
  options: HerdrConfigOptions = {},
): Effect.Effect<HerdrConfig["Service"], HerdrConfigurationError> {
  return makeHerdrConfigEffect(options);
}

/**
 * Provides Herdr configuration while preserving the active ConfigProvider.
 *
 * @category layers
 * @since 0.8.2
 */
export const herdrConfigLayerWithoutDependencies: Layer.Layer<
  HerdrConfig,
  HerdrConfigurationError
> = Layer.effect(HerdrConfig, makeHerdrConfig());

/**
 * Production Layer that loads Herdr configuration from the active ConfigProvider.
 *
 * @category layers
 * @since 0.8.2
 */
export const herdrConfigLayer: Layer.Layer<HerdrConfig, HerdrConfigurationError> =
  herdrConfigLayerWithoutDependencies;

/**
 * Provides Herdr configuration resolved from explicit and ambient options.
 *
 * @category layers
 * @since 0.8.2
 */
export function herdrConfigLayerFromOptions(
  options: HerdrConfigOptions,
): Layer.Layer<HerdrConfig, HerdrConfigurationError> {
  return Layer.effect(HerdrConfig, makeHerdrConfig(options));
}

function resolveHerdrConfig(
  options: ParsedHerdrConfigOptions,
  ambient: AmbientHerdrConfig,
): Effect.Effect<IHerdrConfig, Schema.SchemaError> {
  return Effect.gen(function* () {
    const selection = yield* resolveHerdrSocketSelection(options, ambient);
    const requestTimeout = yield* resolveHerdrRequestTimeout(options, ambient);

    return {
      ...selection,
      requestTimeout,
      application: Option.fromNullishOr(options.application),
      supportedProtocol: HerdrProtocolVersion.literal,
    };
  });
}

function resolveHerdrSocketSelection(
  options: ParsedHerdrConfigOptions,
  ambient: AmbientHerdrConfig,
): Effect.Effect<Pick<IHerdrConfig, "socketPath" | "session">, Schema.SchemaError> {
  return Effect.gen(function* () {
    if (options.socketPath !== undefined) {
      return { socketPath: options.socketPath, session: Option.none() };
    }

    if (options.session !== undefined) {
      const configDirectory = yield* resolveHerdrConfigDirectory(ambient);
      return {
        socketPath: HerdrAbsolutePath.make(
          join(configDirectory, "sessions", options.session, "herdr.sock"),
        ),
        session: Option.some(options.session),
      };
    }

    if (Option.isSome(ambient.socketPath)) {
      const socketPath = yield* parseHerdrAbsolutePath(ambient.socketPath.value);
      return { socketPath, session: Option.none() };
    }

    const configDirectory = yield* resolveHerdrConfigDirectory(ambient);
    if (Option.isSome(ambient.session)) {
      const session = yield* parseHerdrSessionName(ambient.session.value);
      return {
        socketPath: HerdrAbsolutePath.make(
          join(configDirectory, "sessions", session, "herdr.sock"),
        ),
        session: Option.some(session),
      };
    }

    return {
      socketPath: HerdrAbsolutePath.make(join(configDirectory, "herdr.sock")),
      session: Option.none(),
    };
  });
}

function resolveHerdrRequestTimeout(
  options: ParsedHerdrConfigOptions,
  ambient: AmbientHerdrConfig,
): Effect.Effect<HerdrRequestDeadline, Schema.SchemaError> {
  if (options.requestTimeout !== undefined) return Effect.succeed(options.requestTimeout);
  if (Option.isNone(ambient.requestTimeout)) {
    return Effect.succeed(HerdrRequestDeadline.make(DEFAULT_REQUEST_TIMEOUT));
  }

  return parseHerdrRequestDeadlineFromString(ambient.requestTimeout.value);
}

function resolveHerdrConfigDirectory(
  ambient: AmbientHerdrConfig,
): Effect.Effect<HerdrAbsolutePathValue, Schema.SchemaError> {
  if (Option.isSome(ambient.configDirectory)) {
    return parseHerdrAbsolutePath(ambient.configDirectory.value);
  }

  if (process.platform === "win32") {
    if (Option.isSome(ambient.appData)) {
      return parseHerdrAbsolutePath(ambient.appData.value).pipe(
        Effect.map((base) => HerdrAbsolutePath.make(join(base, "herdr"))),
      );
    }
    return Effect.succeed(HerdrAbsolutePath.make(join(homedir(), "herdr")));
  }

  if (Option.isSome(ambient.xdgConfigHome)) {
    return parseHerdrAbsolutePath(ambient.xdgConfigHome.value).pipe(
      Effect.map((base) => HerdrAbsolutePath.make(join(base, "herdr"))),
    );
  }
  return Effect.succeed(HerdrAbsolutePath.make(join(homedir(), ".config", "herdr")));
}

/**
 * Resolves Herdr's filesystem-shaped IPC name to Node's Windows named-pipe endpoint.
 *
 * @category configuration
 * @since 0.8.2
 */
export function resolveHerdrSocketEndpoint(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32" || socketPath.startsWith("\\\\")) return socketPath;
  return `\\\\.\\pipe\\${socketPath}`;
}

function openNodeSocket(endpoint: string): Effect.Effect<Socket, SocketError> {
  return Effect.callback<Socket, SocketError>((resume) => {
    const socket = createConnection(resolveHerdrSocketEndpoint(endpoint));
    let completed = false;
    const cleanup = (): void => {
      socket.off("connect", onConnect);
    };
    const onConnect = (): void => {
      completed = true;
      cleanup();
      resume(Effect.succeed(socket));
    };
    const onError = (cause: Error): void => {
      // Node also emits write callback failures as events. Keep a listener across
      // handshake/read gaps; writes report their callback error and reads inspect socket.errored.
      if (completed) return;
      completed = true;
      cleanup();
      socket.destroy();
      resume(
        Effect.fail(new SocketError({ reason: new SocketOpenError({ kind: "Unknown", cause }) })),
      );
    };
    socket.once("connect", onConnect);
    socket.on("error", onError);
    socket.once("close", () => socket.off("error", onError));
    return Effect.sync(() => {
      if (completed) return;
      completed = true;
      cleanup();
      socket.destroy();
    });
  });
}

const nodeReadError = (cause: unknown) =>
  new SocketError({ reason: new SocketReadError({ cause }) });

function makeNodeSocketConnection(socket: Socket): HerdrSocketConnection {
  return {
    read: Stream.unwrap(
      Effect.suspend(() =>
        socket.errored !== null
          ? Effect.fail(nodeReadError(socket.errored))
          : Effect.succeed(
              NodeStream.fromReadable<Uint8Array, SocketError>({
                evaluate: () => socket,
                closeOnDone: false,
                onError: nodeReadError,
              }),
            ),
      ),
    ),
    write: (bytes) =>
      Effect.callback<void, SocketError>((resume) => {
        let completed = false;
        socket.write(bytes, (cause) => {
          if (completed) return;
          completed = true;
          if (cause === undefined || cause === null) resume(Effect.void);
          else resume(Effect.fail(new SocketError({ reason: new SocketWriteError({ cause }) })));
        });
        return Effect.sync(() => {
          if (completed) return;
          completed = true;
          socket.destroy();
        });
      }),
    close: Effect.sync(() => socket.destroy()),
  };
}

/**
 * Opens Herdr connections with `node:net`, including Windows named pipes.
 *
 * @category layers
 * @since 0.9.1
 */
export const herdrNodeSocketConnectorLayer: Layer.Layer<HerdrSocketConnector> = Layer.succeed(
  HerdrSocketConnector,
  HerdrSocketConnector.of({
    connect: (endpoint) =>
      Effect.acquireRelease(
        openNodeSocket(endpoint),
        (socket) => Effect.sync(() => socket.destroy()),
        {
          interruptible: true,
        },
      ).pipe(Effect.map(makeNodeSocketConnection)),
  }),
);

/**
 * Production transport Layer using the ambient Herdr configuration Layer.
 *
 * @category layers
 * @since 0.8.2
 */
export const herdrTransportLayer: Layer.Layer<HerdrTransport, HerdrConfigurationError> =
  herdrTransportLayerWithoutDependencies.pipe(
    Layer.provide([herdrConfigLayer, herdrNodeSocketConnectorLayer]),
  );

/**
 * Production SDK Layer sharing one ambient configuration and transport instance.
 *
 * @category layers
 * @since 0.8.2
 */
export const herdrSdkLayer: Layer.Layer<HerdrSdk, HerdrConfigurationError> =
  herdrSdkLayerWithoutPlatform.pipe(
    Layer.provide([herdrConfigLayer, herdrNodeSocketConnectorLayer]),
  );

/**
 * Creates a production SDK Layer with explicit options ahead of ambient configuration.
 *
 * @category layers
 * @since 0.8.2
 */
export function herdrSdkLayerFromOptions(
  options: HerdrConfigOptions,
): Layer.Layer<HerdrSdk, HerdrConfigurationError> {
  return herdrSdkLayerWithoutPlatform.pipe(
    Layer.provide([herdrConfigLayerFromOptions(options), herdrNodeSocketConnectorLayer]),
  );
}

/**
 * Production server-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const serverServiceLayer = serverServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production session-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const sessionServiceLayer = sessionServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production notification-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const notificationServiceLayer = notificationServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production client-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const clientServiceLayer = clientServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/** Production custom-command service Layer. @category layers @since 0.9.0 */
export const commandServiceLayer = commandServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/** Production client-shell Layer; connections remain lazy and callback/stream owned. @category layers @since 0.9.0 */
export const clientShellServiceLayer = clientShellServiceLayerWithoutDependencies.pipe(
  Layer.provide([herdrTransportLayer, herdrConfigLayer, herdrNodeSocketConnectorLayer]),
);

/** Production announcement-service Layer. @category layers @since 0.9.0 */
export const productAnnouncementServiceLayer =
  productAnnouncementServiceLayerWithoutDependencies.pipe(Layer.provide(herdrTransportLayer));

/** Production release-notes Layer. @category layers @since 0.9.0 */
export const releaseNotesServiceLayer = releaseNotesServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production workspace-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const workspaceServiceLayer = workspaceServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production worktree-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const worktreeServiceLayer = worktreeServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production tab-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const tabServiceLayer = tabServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production pane-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const paneServiceLayer = paneServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production layout-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const layoutServiceLayer = layoutServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production agent-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const agentServiceLayer = agentServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production event-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const eventServiceLayer = eventServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production integration-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const integrationServiceLayer = integrationServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production plugin-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const pluginServiceLayer = pluginServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);

/**
 * Production popup-service Layer using the ambient Herdr transport graph.
 *
 * @category layers
 * @since 0.8.2
 */
export const popupServiceLayer = popupServiceLayerWithoutDependencies.pipe(
  Layer.provide(herdrTransportLayer),
);
