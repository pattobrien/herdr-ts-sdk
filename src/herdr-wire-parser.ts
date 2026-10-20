/**
 * Decodes generated Herdr wire envelopes into normalized protocol values.
 *
 * Response and event parsers keep generated snake-case contracts at the transport boundary and report malformed JSON as typed SDK failures.
 *
 * @since 0.8.2
 */
import { Result, Schema, SchemaIssue, SchemaParser, SchemaRepresentation } from "effect";
import herdrApiSchema from "../schema/herdr-api.schema.json" with { type: "json" };
import type { ErrorResponse } from "./generated/wire-error-response.ts";
import type { EventEnvelope } from "./generated/wire-event.ts";
import type { SubscriptionEventEnvelope } from "./generated/wire-subscription-event.ts";
import type { SuccessResponse, ResponseResult } from "./generated/wire-success-response.ts";
import {
  wireResultTypesByMethod,
  type WireMethod,
  type WireMethodMap,
} from "./generated/wire-method-map.ts";

/** Narrows a schema-validated result using the exhaustively generated method contract. @category decoding @since 0.9.0 */
export function isExpectedWireResult<Method extends WireMethod>(
  method: Method,
  result: ResponseResult,
): result is WireMethodMap[Method]["result"] {
  const acceptedTypes: readonly string[] = wireResultTypesByMethod[method];
  return acceptedTypes.includes(result.type);
}

/** Imports one root of the Herdr wire JSON Schema as an Effect Schema codec. @category decoding @since 0.9.0 */
export function importHerdrWireSchema<Type>(
  root: keyof typeof herdrApiSchema.schemas,
): Schema.Codec<Type> {
  const { $defs, ...schema } = herdrApiSchema.schemas[root];
  const localDefinitionPrefix = `#/schemas/${root}/$defs/`;
  const imported = SchemaRepresentation.fromJsonSchemaDocument(
    { dialect: "draft-2020-12", schema, definitions: $defs },
    {
      patterns: "apply",
      onEnter: (node) =>
        typeof node.$ref === "string" && node.$ref.startsWith(localDefinitionPrefix)
          ? { ...node, $ref: `#/$defs/${node.$ref.slice(localDefinitionPrefix.length)}` }
          : node,
    },
  );
  return Schema.make<Schema.Codec<Type>>(imported.ast);
}

const decodeHerdrWireResponse = SchemaParser.decodeUnknownResult(
  Schema.suspend(() =>
    Schema.Union([
      importHerdrWireSchema<SuccessResponse>("success_response"),
      importHerdrWireSchema<ErrorResponse>("error_response"),
    ]),
  ),
);
const decodeHerdrWireEvent = SchemaParser.decodeUnknownResult(
  Schema.suspend(() =>
    Schema.Union([
      importHerdrWireSchema<EventEnvelope>("event"),
      importHerdrWireSchema<SubscriptionEventEnvelope>("subscription_event"),
    ]),
  ),
);

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
  const result = decodeHerdrWireResponse(value);
  if (Result.isSuccess(result)) return result.success;
  throw invalidWireValue("response", requestId, result.failure);
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
  const result = decodeHerdrWireEvent(value);
  if (Result.isSuccess(result)) return result.success;
  throw invalidWireValue("event", requestId, result.failure);
}

/** Formats a Herdr wire schema issue for diagnostics. @category decoding @since 0.9.0 */
export const formatHerdrWireIssue = SchemaIssue.makeFormatterDefault();

function invalidWireValue(
  kind: "response" | "event",
  requestId: string,
  issue: SchemaIssue.Issue,
): Error {
  const detail = formatHerdrWireIssue(issue);
  return new Error(`Herdr wire ${kind} failed schema parsing for request ${requestId}: ${detail}`);
}
