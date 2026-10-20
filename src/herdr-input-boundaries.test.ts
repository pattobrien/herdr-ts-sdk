import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { runHerdrTest } from "./herdr-test-runtime.ts";
import { HerdrAbsolutePath } from "./herdr-domain.ts";
import { HerdrInvalidInput } from "./herdr-errors.ts";
import { HerdrSdk } from "./herdr-sdk.ts";
import { herdrSdkLayerFromOptions } from "./herdr-node.ts";
import { startHerdrTestServer } from "./herdr-test-server.ts";
import { makeHerdrSuccessResponse } from "./herdr-wire-fixtures.ts";

test("plugin invocation accepts camel-case worktrees and preserves omitted context fields", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(makeHerdrSuccessResponse(request)),
        );
        yield* Effect.gen(function* () {
          const herdr = yield* HerdrSdk;
          const actionId = herdr.ids.pluginAction("action-1");
          yield* herdr.plugins.actions.invoke(actionId, {
            context: {
              worktree: {
                repoKey: "repo-1",
                repoName: "project",
                repoRoot: "/tmp/project",
                checkoutPath: "/tmp/project-feature",
                isLinkedWorktree: true,
              },
            },
          });
          yield* herdr.plugins.actions.invoke(actionId, { context: {} });
        }).pipe(
          Effect.provide(
            herdrSdkLayerFromOptions({
              socketPath: HerdrAbsolutePath.make(server.socketPath),
            }),
          ),
        );
        const invocations = server.requests.filter(
          (request) => request.method === "plugin.action.invoke",
        );
        expect(invocations[0]?.params.context?.worktree).toEqual({
          repo_key: "repo-1",
          repo_name: "project",
          repo_root: "/tmp/project",
          checkout_path: "/tmp/project-feature",
          is_linked_worktree: true,
        });
        expect(invocations[1]?.params.context?.worktree).toBeNull();
      }),
    ),
  ));

test("agent-view numeric filters preserve unsigned integers and reject invalid wire values", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(makeHerdrSuccessResponse(request)),
        );
        yield* Effect.gen(function* () {
          const herdr = yield* HerdrSdk;
          for (const value of [-1, 0.5]) {
            const failure = yield* herdr.agents.view
              .set({
                source: "schema-regression",
                filter: { op: "eq", field: "state_change_seq", value },
              })
              .pipe(Effect.flip);
            expect(failure).toBeInstanceOf(HerdrInvalidInput);
          }
          expect(server.requests).toEqual([]);
          yield* herdr.agents.view.set({
            source: "schema-regression",
            filter: {
              op: "not",
              filter: { op: "in", field: "state_change_seq", values: [0, 42] },
            },
          });
        }).pipe(
          Effect.provide(
            herdrSdkLayerFromOptions({
              socketPath: HerdrAbsolutePath.make(server.socketPath),
            }),
          ),
        );
        expect(
          server.requests.find((request) => request.method === "agent.view.set")?.params,
        ).toEqual({
          source: "schema-regression",
          filter: {
            op: "not",
            filter: { op: "in", field: "state_change_seq", values: [0, 42] },
          },
        });
      }),
    ),
  ));

test("encoded layout targets and pane ratios are parsed before transport", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(makeHerdrSuccessResponse(request)),
        );
        const failures = yield* Effect.gen(function* () {
          const herdr = yield* HerdrSdk;
          const paneId = herdr.ids.pane("pane-1");
          const invalidTarget = yield* herdr.layouts.export({ tabId: "" }).pipe(Effect.flip);
          const invalidRatio = yield* herdr.panes
            .move(paneId, {
              destination: {
                type: "tab",
                tabId: "tab-1",
                split: "right",
                ratio: 0,
              },
            })
            .pipe(Effect.flip);
          return { invalidRatio, invalidTarget };
        }).pipe(
          Effect.provide(
            herdrSdkLayerFromOptions({
              socketPath: HerdrAbsolutePath.make(server.socketPath),
            }),
          ),
        );
        expect(failures.invalidTarget).toBeInstanceOf(HerdrInvalidInput);
        expect(failures.invalidRatio).toBeInstanceOf(HerdrInvalidInput);
        expect(server.requests).toEqual([]);
      }),
    ),
  ));

test("pane run submits the command with Enter as one pane.send_input request", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(makeHerdrSuccessResponse(request)),
        );
        yield* Effect.gen(function* () {
          const herdr = yield* HerdrSdk;
          yield* herdr.panes.run(herdr.ids.pane("pane-1"), "pnpm test -- --run");
        }).pipe(
          Effect.provide(
            herdrSdkLayerFromOptions({
              socketPath: HerdrAbsolutePath.make(server.socketPath),
            }),
          ),
        );
        expect(
          server.requests
            .filter((request) => request.method !== "ping")
            .map(({ method, params }) => ({ method, params })),
        ).toEqual([
          {
            method: "pane.send_input",
            params: { pane_id: "pane-1", text: "pnpm test -- --run", keys: ["Enter"] },
          },
        ]);
      }),
    ),
  ));

test("pane run rejects an empty command before transport", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(makeHerdrSuccessResponse(request)),
        );
        const failure = yield* Effect.gen(function* () {
          const herdr = yield* HerdrSdk;
          return yield* herdr.panes.run(herdr.ids.pane("pane-1"), "").pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            herdrSdkLayerFromOptions({
              socketPath: HerdrAbsolutePath.make(server.socketPath),
            }),
          ),
        );
        expect(failure).toBeInstanceOf(HerdrInvalidInput);
        expect(failure).toMatchObject({ operation: "PaneService.run" });
        expect(server.requests).toEqual([]);
      }),
    ),
  ));
