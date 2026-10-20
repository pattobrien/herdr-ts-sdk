/** Generated from schema/herdr-api.schema.json by ajv standalone; do not edit. */
import type { ValidateFunction } from "ajv";
import type { SuccessResponse } from "./wire-success-response.ts";
import type { ErrorResponse } from "./wire-error-response.ts";
import type { EventEnvelope } from "./wire-event.ts";
import type { SubscriptionEventEnvelope } from "./wire-subscription-event.ts";

export declare const parseSuccessResponse: ValidateFunction<SuccessResponse>;
export declare const parseErrorResponse: ValidateFunction<ErrorResponse>;
export declare const parseLifecycleEvent: ValidateFunction<EventEnvelope>;
export declare const parseSubscriptionEvent: ValidateFunction<SubscriptionEventEnvelope>;
