/**
 * Defines immutable Herdr SDK configuration.
 *
 * Configuration names the socket, request deadline, and caller identity; the Node Layers in `herdr-node.ts` resolve it from explicit options or ambient inputs.
 *
 * @since 0.8.2
 */
import { Context, Duration, Layer, Option, Schema } from "effect";
import {
  HerdrAbsolutePath,
  type HerdrAbsolutePath as HerdrAbsolutePathValue,
  HerdrSessionName,
  type HerdrSessionName as HerdrSessionNameValue,
} from "./herdr-domain.ts";

const SUPPORTED_HERDR_PROTOCOL = 22 as const;

/**
 * Finite, non-negative deadline for ordinary Herdr transport requests.
 *
 * @category schemas
 * @since 0.8.2
 */
export const HerdrRequestDeadline = Schema.Duration.check(
  Schema.makeFilter((value) =>
    Duration.isFinite(value) && !Duration.isNegative(value)
      ? undefined
      : "must be a finite, non-negative duration",
  ),
).pipe(Schema.brand("HerdrRequestDeadline"));

/**
 * Parsed deadline for ordinary Herdr transport requests.
 *
 * @category models
 * @since 0.8.2
 */
export type HerdrRequestDeadline = typeof HerdrRequestDeadline.Type;

/**
 * Application identity sent during the Herdr compatibility handshake.
 *
 * @category schemas
 * @since 0.8.2
 */
export const HerdrApplication = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
});

/**
 * Parsed application identity sent during the Herdr compatibility handshake.
 *
 * @category models
 * @since 0.8.2
 */
export interface HerdrApplication extends Schema.Schema.Type<typeof HerdrApplication> {}

/**
 * Supported Herdr wire protocol version.
 *
 * @category schemas
 * @since 0.8.2
 */
export const HerdrProtocolVersion = Schema.Literal(SUPPORTED_HERDR_PROTOCOL);

/**
 * Supported Herdr wire protocol version.
 *
 * @category models
 * @since 0.8.2
 */
export type HerdrProtocolVersion = typeof HerdrProtocolVersion.Type;

/**
 * Explicit SDK configuration accepted by {@link makeHerdrConfig}.
 *
 * @category schemas
 * @since 0.8.2
 */
export const HerdrConfigOptions = Schema.Struct({
  socketPath: Schema.optionalKey(HerdrAbsolutePath),
  session: Schema.optionalKey(HerdrSessionName),
  requestTimeout: Schema.optionalKey(HerdrRequestDeadline),
  application: Schema.optionalKey(HerdrApplication),
}).pipe(
  Schema.refine(
    (
      value,
    ): value is typeof value & ({ readonly socketPath?: never } | { readonly session?: never }) =>
      value.socketPath === undefined || value.session === undefined,
    { expected: "socketPath and session are mutually exclusive" },
  ),
);

/**
 * External representation of explicit Herdr SDK configuration.
 *
 * @category models
 * @since 0.8.2
 */
export interface HerdrConfigOptions extends Schema.Codec.Encoded<typeof HerdrConfigOptions> {}

/**
 * Immutable configuration consumed by Herdr SDK services.
 *
 * @category services
 * @since 0.8.2
 */
export interface IHerdrConfig {
  /** Resolved local socket used for every Herdr request. */
  readonly socketPath: HerdrAbsolutePathValue;
  /** Named session that selected the socket, or `None` for an exact/default socket. */
  readonly session: Option.Option<HerdrSessionNameValue>;
  /** Default local deadline for ordinary transport requests. */
  readonly requestTimeout: HerdrRequestDeadline;
  /** Optional application identity included in the compatibility handshake. */
  readonly application: Option.Option<HerdrApplication>;
  /** Herdr protocol version accepted by this SDK build. */
  readonly supportedProtocol: HerdrProtocolVersion;
}

/**
 * Yieldable Effect service containing resolved Herdr SDK configuration.
 *
 * @category services
 * @since 0.8.2
 */
export class HerdrConfig extends Context.Service<HerdrConfig, IHerdrConfig>()(
  "@herdr/sdk/HerdrConfig",
) {}

/**
 * Provides an already parsed Herdr configuration value.
 *
 * @category layers
 * @since 0.8.2
 */
export function herdrConfigLayerFromValue(config: IHerdrConfig): Layer.Layer<HerdrConfig> {
  return Layer.succeed(HerdrConfig, HerdrConfig.of(config));
}
