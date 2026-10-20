/**
 * Decodes generated Herdr wire envelopes into normalized protocol values.
 *
 * Response and event parsers keep generated snake-case contracts at the transport boundary and report malformed JSON as typed SDK failures.
 *
 * @since 0.8.2
 */
import type { ErrorObject } from "ajv/dist/2020.js";
import type { ErrorResponse } from "./generated/wire-error-response.ts";
import type { EventEnvelope } from "./generated/wire-event.ts";
import type { SubscriptionEventEnvelope } from "./generated/wire-subscription-event.ts";
import type { SuccessResponse, ResponseResult } from "./generated/wire-success-response.ts";
import {
  wireResultTypesByMethod,
  type WireMethod,
  type WireMethodMap,
} from "./generated/wire-method-map.ts";
import {
  parseErrorResponse,
  parseLifecycleEvent,
  parseSubscriptionEvent,
  parseSuccessResponse,
} from "./generated/wire-validators.mjs";

/** Narrows a schema-validated result using the exhaustively generated method contract. @category decoding @since 0.9.0 */
export function isExpectedWireResult<Method extends WireMethod>(
  method: Method,
  result: ResponseResult,
): result is WireMethodMap[Method]["result"] {
  const acceptedTypes: readonly string[] = wireResultTypesByMethod[method];
  return acceptedTypes.includes(result.type);
}

/**
 * Parses an untrusted wire response into the generated success or error contract.
 *
 * @category decoding
 * @since 0.8.2
 */
export function parseHerdrWireResponse(
  value: unknown,
  requestId: string,
): SuccessResponse | ErrorResponse {
  if (parseSuccessResponse(value) || parseErrorResponse(value)) return value;
  throw invalidWireValue("response", requestId, [
    ...(parseSuccessResponse.errors ?? []),
    ...(parseErrorResponse.errors ?? []),
  ]);
}

/**
 * Parses an untrusted event line into one generated Herdr envelope family.
 *
 * @category decoding
 * @since 0.8.2
 */
export function parseHerdrWireEvent(
  value: unknown,
  requestId: string,
): EventEnvelope | SubscriptionEventEnvelope {
  if (parseLifecycleEvent(value) || parseSubscriptionEvent(value)) return value;
  throw invalidWireValue("event", requestId, [
    ...(parseLifecycleEvent.errors ?? []),
    ...(parseSubscriptionEvent.errors ?? []),
  ]);
}

function invalidWireValue(
  kind: "response" | "event",
  requestId: string,
  errors: readonly ErrorObject[],
): Error {
  const detail = errors
    .slice(0, 5)
    .map((error) => `data${error.instancePath} ${error.message}`)
    .join("; ");
  return new Error(`Herdr wire ${kind} failed schema parsing for request ${requestId}: ${detail}`);
}
