import { expect, test } from "vite-plus/test";
import { sweepHerdrServerErrorCodes } from "./sweep-herdr-server-error-codes.mjs";

const responses = `
pub(crate) fn encode_error(id: String, code: &str, message: impl Into<String>) -> String {
    serde_json::to_string(&ErrorResponse { id, error: ErrorBody { code: code.into(), message: message.into() } })
}
const BUSY: &str = r#"{"id":"","error":{"code":"ui_busy","message":"busy"}}"#;
`;

const panes = `
struct ApiFailure { code: &'static str }
impl ApiFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self { todo!() }
    fn missing() -> Self { Self::new("worktree_not_found", "missing") }
}
impl App {
    fn reject(&mut self, id: String, code: &str) -> String { encode_error(id, code, "rejected") }
    fn handle(&mut self, id: String) -> String {
        if busy { return crate::app::api::responses::encode_error(
            id,
            "pane_not_found",
            format!("pane not found: {}", id),
        ); }
        let fallback = ApiFailure::new("stale_worktree_operation", "stale");
        let status = match state {
            Stalled => {
                let status = current.status();
                (
                    "agent_prompt_stalled",
                    format!("no progress; status is {status}"),
                )
            }
            _ => ("timeout", "timed out waiting".to_string()),
        };
        let parsed = value.parse().map_err(|err| ("invalid_ratio", err.to_string()))?;
        if empty { return Err(("invalid_env".into(), message)); }
        let pair = ("catppuccin", "catppuccin-latte".to_string());
        lookup("not_a_code", id);
        self.reject(id, "tab_not_found")
    }
}
#[cfg(test)]
mod tests {
    fn fixture() -> String { encode_error("id".into(), "test_only_code", "unused") }
}
#[cfg(all(test, unix))]
mod unix_tests {
    fn fixture() -> String { encode_error("id".into(), "unix_test_only_code", "unused") }
}
`;

const transport = `
fn write_endpoint_rejection(stream: &mut LocalStream, code: &str, message: impl Into<String>) {
    let welcome = EndpointServerWelcome::incompatible(code, message);
}
fn accept_hello(stream: &mut LocalStream, hello: Hello) {
    if hello.invalid() { return write_endpoint_rejection(stream, "invalid_hello", "bad hello"); }
    if let Some((code, reason)) = hello.surface().map(|reason| ("invalid_surface", reason.to_owned())) {
        write_endpoint_rejection(stream, code, reason);
    }
}
fn decode(head: Head) -> Decoded {
    Decoded::Error { code: "unsupported_method", message: format!("method {} is unavailable", head.method) }
}
`;

test("sweep collects request error codes and skips tests, handshake rejections, CLI, and client sources", () => {
  expect(
    sweepHerdrServerErrorCodes([
      { path: "app/api/responses.rs", source: responses },
      { path: "app/api/panes.rs", source: panes },
      { path: "server/client_transport.rs", source: transport },
      { path: "app/api/tests.rs", source: 'encode_error(id, "tests_file_code", "x")' },
      { path: "cli/server.rs", source: 'ErrorBody { code: "cli_only_code".into() }' },
      { path: "client/shell/actions.rs", source: 'ErrorBody { code: "client_only_code" }' },
      { path: "main.rs", source: '("herdr", "Launch or attach to the session")' },
    ]),
  ).toEqual([
    "agent_prompt_stalled",
    "invalid_env",
    "invalid_ratio",
    "pane_not_found",
    "stale_worktree_operation",
    "tab_not_found",
    "timeout",
    "ui_busy",
    "unsupported_method",
    "worktree_not_found",
  ]);
});
