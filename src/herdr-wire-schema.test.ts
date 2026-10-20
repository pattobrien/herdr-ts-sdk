import { Result, SchemaParser } from "effect";
import { expect, test } from "vite-plus/test";
import { importHerdrWireSchema, parseHerdrWireResponse } from "./herdr-wire-parser.ts";

interface WireSchemaCase {
  readonly root: Parameters<typeof importHerdrWireSchema>[0];
  readonly name: string;
  readonly value: unknown;
  readonly accepts: boolean;
}

const workspace = {
  workspace_id: "workspace-1",
  active_tab_id: "workspace-1:tab-1",
  agent_status: "idle",
  focused: false,
  label: "repo",
  number: 2,
  pane_count: 0,
  tab_count: 1,
};
const workspaceList = (overrides: object) => ({
  id: "request-1",
  result: { type: "workspace_list", workspaces: [{ ...workspace, ...overrides }] },
});
const { label: _label, ...workspaceWithoutLabel } = workspace;
const pluginPaneOpen = (params: object) => ({
  id: "request-1",
  method: "plugin.pane.open",
  params: { plugin_id: "plugin", entrypoint: "main", ...params },
});
const paneReportMetadata = (params: object) => ({
  id: "request-1",
  method: "pane.report_metadata",
  params: { pane_id: "pane-1", source: "fixture", ...params },
});
const agentStatusChanged = (agentStatus: string) => ({
  event: "pane.agent_status_changed",
  data: { pane_id: "pane-1", workspace_id: "workspace-1", agent_status: agentStatus },
});

const cases: readonly WireSchemaCase[] = [
  { root: "success_response", name: "workspace list", value: workspaceList({}), accepts: true },
  {
    root: "success_response",
    name: "unknown keys on open objects",
    value: workspaceList({ unexpected_wire_key: "fixture" }),
    accepts: true,
  },
  {
    root: "success_response",
    name: "null in a nullable union",
    value: workspaceList({ worktree: null }),
    accepts: true,
  },
  {
    root: "success_response",
    name: "missing required key",
    value: {
      id: "request-1",
      result: { type: "workspace_list", workspaces: [workspaceWithoutLabel] },
    },
    accepts: false,
  },
  {
    root: "success_response",
    name: "negative unsigned integer",
    value: workspaceList({ number: -1 }),
    accepts: false,
  },
  {
    root: "success_response",
    name: "fractional integer",
    value: workspaceList({ number: 1.5 }),
    accepts: false,
  },
  {
    root: "success_response",
    name: "enum mismatch",
    value: workspaceList({ agent_status: "sleeping" }),
    accepts: false,
  },
  {
    root: "success_response",
    name: "token names matching the property-name pattern",
    value: workspaceList({ tokens: { branch_name: "main" } }),
    accepts: true,
  },
  {
    root: "success_response",
    name: "token name violating the property-name pattern",
    value: workspaceList({ tokens: { "branch name": "main" } }),
    accepts: false,
  },
  {
    root: "success_response",
    name: "more tokens than maxProperties",
    value: workspaceList({
      tokens: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`t${index}`, "v"])),
    }),
    accepts: false,
  },
  {
    root: "success_response",
    name: "unknown result discriminator",
    value: { id: "request-1", result: { type: "workspace_lists", workspaces: [] } },
    accepts: false,
  },
  {
    root: "success_response",
    name: "non-string id",
    value: { ...workspaceList({}), id: 7 },
    accepts: false,
  },
  {
    root: "error_response",
    name: "error body",
    value: { id: "request-1", error: { code: "not_found", message: "missing" } },
    accepts: true,
  },
  {
    root: "error_response",
    name: "error body without message",
    value: { id: "request-1", error: { code: "not_found" } },
    accepts: false,
  },
  {
    root: "event",
    name: "lifecycle event",
    value: {
      event: "workspace_renamed",
      data: { type: "workspace_renamed", workspace_id: "workspace-1", label: "repo" },
    },
    accepts: true,
  },
  {
    root: "event",
    name: "lifecycle event with nullable payload",
    value: {
      event: "workspace_closed",
      data: { type: "workspace_closed", workspace_id: "workspace-1", workspace: null },
    },
    accepts: true,
  },
  {
    root: "event",
    name: "unknown event kind",
    value: {
      event: "workspace_exploded",
      data: { type: "workspace_renamed", workspace_id: "workspace-1", label: "repo" },
    },
    accepts: false,
  },
  {
    root: "subscription_event",
    name: "subscription event",
    value: agentStatusChanged("working"),
    accepts: true,
  },
  {
    root: "subscription_event",
    name: "subscription event with unknown status",
    value: agentStatusChanged("sleeping"),
    accepts: false,
  },
  {
    root: "request",
    name: "integer popup size",
    value: pluginPaneOpen({ width: 65535 }),
    accepts: true,
  },
  {
    root: "request",
    name: "percentage popup size",
    value: pluginPaneOpen({ height: "80%" }),
    accepts: true,
  },
  {
    root: "request",
    name: "null popup size",
    value: pluginPaneOpen({ width: null }),
    accepts: true,
  },
  {
    root: "request",
    name: "popup size above maximum",
    value: pluginPaneOpen({ width: 65536 }),
    accepts: false,
  },
  {
    root: "request",
    name: "percentage outside the pattern",
    value: pluginPaneOpen({ height: "101%" }),
    accepts: false,
  },
  {
    root: "request",
    name: "zero percentage",
    value: pluginPaneOpen({ height: "0%" }),
    accepts: false,
  },
  {
    root: "request",
    name: "ttl at its maximum",
    value: paneReportMetadata({ ttl_ms: 86_400_000 }),
    accepts: true,
  },
  {
    root: "request",
    name: "ttl below its minimum",
    value: paneReportMetadata({ ttl_ms: 0 }),
    accepts: false,
  },
  {
    root: "request",
    name: "request without id",
    value: { method: "plugin.pane.open", params: { plugin_id: "plugin", entrypoint: "main" } },
    accepts: false,
  },
  {
    root: "request",
    name: "unknown method",
    value: { id: "request-1", method: "plugin.pane.explode", params: {} },
    accepts: false,
  },
];

test.each(cases)("$root decoding of $name matches the JSON Schema", ({ root, value, accepts }) => {
  const decoded = SchemaParser.decodeUnknownResult(importHerdrWireSchema<unknown>(root))(value);
  expect(Result.isSuccess(decoded)).toBe(accepts);
  if (Result.isSuccess(decoded)) expect(decoded.success).toStrictEqual(value);
});

test("uint64 values beyond Number.MAX_SAFE_INTEGER fail response parsing", () => {
  expect(() => parseHerdrWireResponse(workspaceList({ number: 2 ** 60 }), "request-1")).toThrow(
    /Herdr wire response failed schema parsing for request request-1/,
  );
});
