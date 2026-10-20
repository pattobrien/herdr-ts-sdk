/**
 * Defines the typed failures exposed by Herdr SDK operations.
 *
 * Schema-backed tagged errors distinguish configuration, input, transport, timeout, compatibility, server, response, event, and graphics failures for targeted recovery.
 *
 * @since 0.8.2
 */
import { Option, Schema } from "effect";
import { HerdrByteLength } from "./herdr-domain.ts";

/**
 * Failure to decode or resolve Herdr SDK configuration.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrConfigurationError extends Schema.TaggedError<HerdrConfigurationError>()(
  "HerdrConfigurationError",
  {
    operation: Schema.Literal("loadHerdrConfig"),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {
  /** Creates a safe configuration failure while retaining the diagnostic cause. */
  constructor(cause: unknown) {
    super({
      operation: "loadHerdrConfig",
      message:
        "Herdr configuration loading failed. Correct the SDK options or Herdr environment configuration and try again.",
      cause,
    });
  }
}

/**
 * Failure to parse caller input into the domain value required by one SDK operation.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrInvalidInput extends Schema.TaggedError<HerdrInvalidInput>()(
  "HerdrInvalidInput",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {
  /** Creates an input parse failure at a named public operation boundary. */
  constructor(operation: string, cause: unknown) {
    super({
      operation,
      message: `Herdr input parsing failed for ${operation}. Correct the supplied value and try again.`,
      cause,
    });
  }
}

/**
 * Local Unix-socket connection, read, write, or premature-close failure.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrTransportError extends Schema.TaggedError<HerdrTransportError>()(
  "HerdrTransportError",
  {
    operation: Schema.Literals([
      "request",
      "compatibility_check",
      "event_subscription",
      "graphics_stream",
      "graphics_write",
    ]),
    reason: Schema.Literals(["connect", "read", "write", "premature_close"]),
    requestId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {
  /** Creates a classified transport failure with its wire correlation identifier. */
  constructor(
    operation: HerdrTransportError["operation"],
    reason: HerdrTransportError["reason"],
    requestId: string,
    cause: unknown,
  ) {
    super({
      operation,
      reason,
      requestId,
      message: `Herdr transport failed during ${operation}: ${reason}. The server outcome may be uncertain; inspect the affected resources before retrying.`,
      cause,
    });
  }
}

/**
 * Local deadline elapsed before a Herdr operation completed.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrRequestTimeout extends Schema.TaggedError<HerdrRequestTimeout>()(
  "HerdrRequestTimeout",
  {
    operation: Schema.Literals([
      "request",
      "compatibility_check",
      "event_subscription",
      "graphics_stream",
      "graphics_write",
    ]),
    requestId: Schema.String,
    timeoutMilliseconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    message: Schema.String,
  },
) {
  /** Creates a local deadline failure without classifying fiber interruption as a timeout. */
  constructor(
    operation: HerdrRequestTimeout["operation"],
    requestId: string,
    timeoutMilliseconds: number,
  ) {
    super({
      operation,
      requestId,
      timeoutMilliseconds,
      message: `Herdr request timed out during ${operation} after ${timeoutMilliseconds} milliseconds. The server outcome may be uncertain; inspect the affected resources before retrying with a longer deadline.`,
    });
  }
}

/**
 * Malformed, oversized, mismatched, or schema-invalid Herdr response.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrInvalidResponse extends Schema.TaggedError<HerdrInvalidResponse>()(
  "HerdrInvalidResponse",
  {
    reason: Schema.Literals([
      "malformed_json",
      "oversized_frame",
      "correlation_mismatch",
      "schema_mismatch",
      "missing_result",
      "unsupported_value",
    ]),
    requestId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {
  /** Creates a classified response-boundary failure. */
  constructor(reason: HerdrInvalidResponse["reason"], requestId: string, cause: unknown) {
    super({
      reason,
      requestId,
      message: `Herdr response parsing failed: ${reason}. The server response is incompatible with this SDK build.`,
      cause,
    });
  }
}

/**
 * Server protocol version differs from protocol 22 supported by this SDK.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrUnsupportedProtocol extends Schema.TaggedError<HerdrUnsupportedProtocol>()(
  "HerdrUnsupportedProtocol",
  {
    actualProtocol: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    supportedProtocol: Schema.Literal(22),
    requestId: Schema.String,
    message: Schema.String,
  },
) {
  /** Creates a protocol compatibility failure from the ping handshake. */
  constructor(actualProtocol: number, supportedProtocol: 22, requestId: string) {
    super({
      actualProtocol,
      supportedProtocol,
      requestId,
      message: `Herdr protocol is unsupported: server uses ${actualProtocol}, SDK requires ${supportedProtocol}. Install compatible Herdr and SDK versions.`,
    });
  }
}

/**
 * Success result discriminant is not supported for the requested operation.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrUnsupportedResult extends Schema.TaggedError<HerdrUnsupportedResult>()(
  "HerdrUnsupportedResult",
  {
    operation: Schema.String,
    actualType: Schema.String,
    expectedType: Schema.String,
    requestId: Schema.String,
    message: Schema.String,
  },
) {
  /** Creates an unsupported success-result failure. */
  constructor(operation: string, actualType: string, expectedType: string, requestId: string) {
    super({
      operation,
      actualType,
      expectedType,
      requestId,
      message: `Herdr result is unsupported for ${operation}: received ${actualType}, expected ${expectedType}. Update the SDK or use a compatible server.`,
    });
  }
}

/**
 * Event discriminant is not supported by this SDK build.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrUnsupportedEvent extends Schema.TaggedError<HerdrUnsupportedEvent>()(
  "HerdrUnsupportedEvent",
  {
    eventType: Schema.String,
    requestId: Schema.String,
    message: Schema.String,
  },
) {
  /** Creates an unsupported event failure from a subscription or wait boundary. */
  constructor(eventType: string, requestId: string) {
    super({
      eventType,
      requestId,
      message: `Herdr event is unsupported: ${eventType}. Update the SDK or narrow the subscription to supported events.`,
    });
  }
}

/**
 * Open-code server-returned failure correlated to one request.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrServerError extends Schema.TaggedError<HerdrServerError>()("HerdrServerError", {
  serverCode: Schema.String,
  serverMessage: Schema.String,
  requestId: Schema.String,
  method: Schema.String,
  message: Schema.String,
}) {
  /** Creates a typed boundary error while preserving the server's open code space. */
  constructor(serverCode: string, serverMessage: string, requestId: string, method: string) {
    super({
      serverCode,
      serverMessage,
      requestId,
      method,
      message: `Herdr server rejected ${method} with ${serverCode}: ${serverMessage}`,
    });
  }
}

/**
 * Error codes Herdr returns in `HerdrServerError.serverCode`, which stays an open string.
 *
 * @category errors
 * @since 0.9.1
 */
export const HerdrServerErrorCode = {
  AgentBlocked: "agent_blocked",
  AgentExplainUnavailable: "agent_explain_unavailable",
  AgentLaunchPending: "agent_launch_pending",
  AgentNameTaken: "agent_name_taken",
  AgentNotFound: "agent_not_found",
  AgentNotIdle: "agent_not_idle",
  AgentNotReady: "agent_not_ready",
  AgentNotRunning: "agent_not_running",
  AgentPaneBusy: "agent_pane_busy",
  AgentPaneNotFound: "agent_pane_not_found",
  AgentPaneUnavailable: "agent_pane_unavailable",
  AgentPromptFailed: "agent_prompt_failed",
  AgentPromptStalled: "agent_prompt_stalled",
  AgentSendKeysFailed: "agent_send_keys_failed",
  AgentStartInputFailed: "agent_start_input_failed",
  AgentTargetAmbiguous: "agent_target_ambiguous",
  AmbiguousPluginAction: "ambiguous_plugin_action",
  AmbiguousWorktreeBranch: "ambiguous_worktree_branch",
  CellSizeUnavailable: "cell_size_unavailable",
  CommandFailed: "command_failed",
  CommandNotFound: "command_not_found",
  CommandTargetMismatch: "command_target_mismatch",
  ConfirmationRequired: "confirmation_required",
  ConnectionLocalOnly: "connection_local_only",
  CopyMotionUnavailable: "copy_motion_unavailable",
  DirtyWorktreeRequiresForce: "dirty_worktree_requires_force",
  DuplicatePluginActionId: "duplicate_plugin_action_id",
  DuplicatePluginLinkHandlerId: "duplicate_plugin_link_handler_id",
  DuplicatePluginPaneId: "duplicate_plugin_pane_id",
  EmptyAgentPrompt: "empty_agent_prompt",
  EndpointBusy: "endpoint_busy",
  FeatureDisabled: "feature_disabled",
  GraphicsBudgetExceeded: "graphics_budget_exceeded",
  HandoffFailed: "handoff_failed",
  ImageTooLarge: "image_too_large",
  IntegrationInstallFailed: "integration_install_failed",
  IntegrationUninstallFailed: "integration_uninstall_failed",
  InternalError: "internal_error",
  InvalidAgent: "invalid_agent",
  InvalidAgentArgument: "invalid_agent_argument",
  InvalidAgentName: "invalid_agent_name",
  InvalidAgentTimeout: "invalid_agent_timeout",
  InvalidAgentView: "invalid_agent_view",
  InvalidEnv: "invalid_env",
  InvalidFrame: "invalid_frame",
  InvalidFrameFile: "invalid_frame_file",
  InvalidImage: "invalid_image",
  InvalidKey: "invalid_key",
  InvalidLayerId: "invalid_layer_id",
  InvalidLayout: "invalid_layout",
  InvalidMetadataRequest: "invalid_metadata_request",
  InvalidMetadataSource: "invalid_metadata_source",
  InvalidMetadataToken: "invalid_metadata_token",
  InvalidMetadataTtl: "invalid_metadata_ttl",
  InvalidPaneSwap: "invalid_pane_swap",
  InvalidParams: "invalid_params",
  InvalidPluginActionId: "invalid_plugin_action_id",
  InvalidPluginActionTitle: "invalid_plugin_action_title",
  InvalidPluginCommand: "invalid_plugin_command",
  InvalidPluginContext: "invalid_plugin_context",
  InvalidPluginEntrypoint: "invalid_plugin_entrypoint",
  InvalidPluginEvent: "invalid_plugin_event",
  InvalidPluginId: "invalid_plugin_id",
  InvalidPluginLinkHandlerAction: "invalid_plugin_link_handler_action",
  InvalidPluginLinkHandlerId: "invalid_plugin_link_handler_id",
  InvalidPluginLinkHandlerPattern: "invalid_plugin_link_handler_pattern",
  InvalidPluginLinkHandlerTitle: "invalid_plugin_link_handler_title",
  InvalidPluginManifestPath: "invalid_plugin_manifest_path",
  InvalidPluginMinHerdrVersion: "invalid_plugin_min_herdr_version",
  InvalidPluginName: "invalid_plugin_name",
  InvalidPluginPaneId: "invalid_plugin_pane_id",
  InvalidPluginPaneSize: "invalid_plugin_pane_size",
  InvalidPluginPaneTitle: "invalid_plugin_pane_title",
  InvalidPluginPlatform: "invalid_plugin_platform",
  InvalidPluginSource: "invalid_plugin_source",
  InvalidPluginVersion: "invalid_plugin_version",
  InvalidRatio: "invalid_ratio",
  InvalidRegex: "invalid_regex",
  InvalidRequest: "invalid_request",
  InvalidStateLabel: "invalid_state_label",
  InvalidStream: "invalid_stream",
  InvalidTarget: "invalid_target",
  LayerLimit: "layer_limit",
  LayoutApplyFailed: "layout_apply_failed",
  LayoutNotFound: "layout_not_found",
  LinkedWorktreeSource: "linked_worktree_source",
  MetadataSequenceSourceLimit: "metadata_sequence_source_limit",
  MetadataTokenLimit: "metadata_token_limit",
  NoActivePane: "no_active_pane",
  NoActiveWorkspace: "no_active_workspace",
  NotGitWorktree: "not_git_worktree",
  NotImplemented: "not_implemented",
  NotLinkedWorktree: "not_linked_worktree",
  PaneLayoutUnavailable: "pane_layout_unavailable",
  PaneMoveFailed: "pane_move_failed",
  PaneNotFound: "pane_not_found",
  PaneSendFailed: "pane_send_failed",
  PaneSplitFailed: "pane_split_failed",
  PlatformUnsupported: "platform_unsupported",
  PluginActionNotFound: "plugin_action_not_found",
  PluginCommandLimitReached: "plugin_command_limit_reached",
  PluginDisabled: "plugin_disabled",
  PluginManifestNotFound: "plugin_manifest_not_found",
  PluginManifestParseFailed: "plugin_manifest_parse_failed",
  PluginManifestReadFailed: "plugin_manifest_read_failed",
  PluginManifestUnavailable: "plugin_manifest_unavailable",
  PluginNotFound: "plugin_not_found",
  PluginPaneNotFound: "plugin_pane_not_found",
  PluginPaneOpenFailed: "plugin_pane_open_failed",
  PluginRegistryLoadFailed: "plugin_registry_load_failed",
  PluginRegistrySaveFailed: "plugin_registry_save_failed",
  PluginRequiresNewerHerdr: "plugin_requires_newer_herdr",
  PluginUserDirCreateFailed: "plugin_user_dir_create_failed",
  PopupNotOpen: "popup_not_open",
  QueryTooLarge: "query_too_large",
  ScrollbackEditorFailed: "scrollback_editor_failed",
  SelectionUnavailable: "selection_unavailable",
  SerializationError: "serialization_error",
  ServerUnavailable: "server_unavailable",
  SplitNotFound: "split_not_found",
  StaleAnnouncement: "stale_announcement",
  StaleBoot: "stale_boot",
  StaleContent: "stale_content",
  StalePaneTarget: "stale_pane_target",
  StaleReleaseNotes: "stale_release_notes",
  StaleTarget: "stale_target",
  StaleWorktreeOperation: "stale_worktree_operation",
  StreamClosed: "stream_closed",
  StreamConflict: "stream_conflict",
  StreamTransportRequired: "stream_transport_required",
  SurfaceInactive: "surface_inactive",
  TabCloseFailed: "tab_close_failed",
  TabCreateFailed: "tab_create_failed",
  TabMoveFailed: "tab_move_failed",
  TabNotFound: "tab_not_found",
  TargetPaneNotFound: "target_pane_not_found",
  Timeout: "timeout",
  UiBusy: "ui_busy",
  UnsupportedAgentKind: "unsupported_agent_kind",
  UnsupportedEndpointCommand: "unsupported_endpoint_command",
  UnsupportedEventWaitMatch: "unsupported_event_wait_match",
  UnsupportedInAppMode: "unsupported_in_app_mode",
  UnsupportedMethod: "unsupported_method",
  WorkspaceCreateFailed: "workspace_create_failed",
  WorkspaceGroupCloseRequired: "workspace_group_close_required",
  WorkspaceMoveBlockFailed: "workspace_move_block_failed",
  WorkspaceMoveFailed: "workspace_move_failed",
  WorkspaceNotFound: "workspace_not_found",
  WorktreeCreateFailed: "worktree_create_failed",
  WorktreeListFailed: "worktree_list_failed",
  WorktreeNotFound: "worktree_not_found",
  WorktreeOpenFailed: "worktree_open_failed",
  WorktreeOperationInProgress: "worktree_operation_in_progress",
  WorktreeRemoveFailed: "worktree_remove_failed",
} as const;

/**
 * Error code catalogued in `HerdrServerErrorCode`.
 *
 * @category errors
 * @since 0.9.1
 */
export type HerdrServerErrorCode = (typeof HerdrServerErrorCode)[keyof typeof HerdrServerErrorCode];

/**
 * Graphics frame has invalid data or dimensions.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrInvalidFrame extends Schema.TaggedError<HerdrInvalidFrame>()(
  "HerdrInvalidFrame",
  {
    operation: Schema.Literals(["graphics_set", "graphics_stream"]),
    reason: Schema.Literals(["empty_data", "schema_mismatch"]),
    requestId: Schema.Option(Schema.String),
    message: Schema.String,
  },
) {
  /** Creates a graphics frame parse failure before bytes are written. */
  constructor(
    operation: HerdrInvalidFrame["operation"],
    reason: HerdrInvalidFrame["reason"],
    requestId?: string,
  ) {
    super({
      operation,
      reason,
      requestId: Option.fromNullishOr(requestId),
      message: `Herdr graphics frame is invalid during ${operation}: ${reason}. Supply non-empty data with positive integer dimensions.`,
    });
  }
}

/**
 * Graphics image exceeds the byte limit for its write mode.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrImageTooLarge extends Schema.TaggedError<HerdrImageTooLarge>()(
  "HerdrImageTooLarge",
  {
    operation: Schema.Literals(["graphics_set", "graphics_stream"]),
    actualBytes: HerdrByteLength,
    maximumBytes: HerdrByteLength,
    requestId: Schema.Option(Schema.String),
    message: Schema.String,
  },
) {
  /** Creates an oversized graphics image failure before socket I/O. */
  constructor(
    operation: HerdrImageTooLarge["operation"],
    actualBytes: number,
    maximumBytes: number,
    requestId?: string,
  ) {
    super({
      operation,
      actualBytes: HerdrByteLength.make(actualBytes),
      maximumBytes: HerdrByteLength.make(maximumBytes),
      requestId: Option.fromNullishOr(requestId),
      message: `Herdr graphics image is too large during ${operation}: received ${actualBytes} bytes, maximum ${maximumBytes} bytes. Reduce the image size and try again.`,
    });
  }
}

/**
 * Graphics writer was used after its owning scope closed.
 *
 * @category errors
 * @since 0.8.2
 */
export class HerdrGraphicsStreamClosed extends Schema.TaggedError<HerdrGraphicsStreamClosed>()(
  "HerdrGraphicsStreamClosed",
  {
    requestId: Schema.String,
    message: Schema.String,
  },
) {
  /** Creates a closed-resource failure for a graphics write. */
  constructor(requestId: string) {
    super({
      requestId,
      message:
        "Herdr graphics stream is closed. Acquire a new writer inside an active Effect scope.",
    });
  }
}
