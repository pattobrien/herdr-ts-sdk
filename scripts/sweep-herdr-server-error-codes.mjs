/**
 * Prints the sorted error codes a Herdr server source tree emits on the wire.
 * `--check` compares them with `HerdrServerErrorCode` and fails on any difference.
 */
import { Console, Effect, FileSystem, Schema } from "effect";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SweepError = Schema.TaggedStruct("SweepError", { message: Schema.String });

const codeLiteral = String.raw`"([a-z][a-z0-9]*(?:_[a-z0-9]+)*)"`;
const fieldPattern = new RegExp(String.raw`(?:\bcode|"code")\s*:\s*${codeLiteral}`, "g");
const codeExpression = String.raw`\(\s*${codeLiteral}(?:\.(?:into|to_string|to_owned)\(\))?\s*,`;
const resultTuplePattern = new RegExp(
  String.raw`(?:Err\(|ok_or\(|=>\s*|\|[^|\n]*\|\s*)${codeExpression}`,
  "g",
);
const messageTuplePattern = new RegExp(
  String.raw`(?<![\w!>\]?)])${codeExpression}\s*(?:format!\(|"[^"\n]* [^"\n]*"|(?:err|error|e)\.to_string\(\))`,
  "g",
);
const codeParameterFunctionPattern = /\bfn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
const stringCodeParameterPattern = /^code:\s*(?:&(?:'static\s+)?str|String|impl\s+Into<String>)$/;
const functionPattern = /\bfn\s+(\w+)[^{;]*\{/g;
const handshakeRejectionPattern = /\bEndpointServerWelcome\b/;
const implPattern = /\bimpl(?:\s*<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?(\w+)/g;

/** @param {string} path */
function isServerSource(path) {
  return (
    path.endsWith(".rs") &&
    !/(^|\/)tests?(\/|\.rs$)|_tests?\.rs$/.test(path) &&
    !/^(cli|client)(\/|\.rs$)|^main\.rs$/.test(path)
  );
}

/** @param {string} source @param {number} open */
function blockEnd(source, open) {
  let index = open + 1;
  for (let depth = 1; depth > 0 && index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
  }
  return index;
}

/** @param {string} source */
function withoutTestModules(source) {
  let remaining = source;
  for (;;) {
    const match =
      /#\[cfg\((?:test|all\(test\b[^\]]*\))\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/.exec(
        remaining,
      );
    if (match === null) return remaining;
    const end = blockEnd(remaining, match.index + match[0].length - 1);
    remaining = remaining.slice(0, match.index) + remaining.slice(end);
  }
}

/** @param {string} source @param {number} open */
function callArguments(source, open) {
  const values = [];
  let depth = 0;
  let start = open + 1;
  let quoted = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source.charAt(index);
    if (quoted) {
      if (character === "\\") index += 1;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) {
      depth -= 1;
      if (depth === 0) {
        values.push(source.slice(start, index).trim());
        return values;
      }
    } else if (character === "," && depth === 1) {
      values.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  return values;
}

/** @param {string} source */
function codeHelpers(source) {
  const impls = [...source.matchAll(implPattern)].map((impl) => {
    const open = source.indexOf("{", impl.index);
    return { owner: impl[1], start: open, end: blockEnd(source, open) };
  });
  return [...source.matchAll(codeParameterFunctionPattern)].flatMap((match) => {
    const all = (match[2] ?? "")
      .split(",")
      .map((parameter) => parameter.trim())
      .filter((parameter) => parameter.length > 0);
    const method = all.some((parameter) => /^&?(?:mut\s+)?self$/.test(parameter));
    const parameters = method ? all.slice(1) : all;
    const position = parameters.findIndex((parameter) =>
      stringCodeParameterPattern.test(parameter),
    );
    if (position === -1) return [];
    const owner = impls.findLast(
      (impl) => impl.start < match.index && match.index < impl.end,
    )?.owner;
    return [{ name: match[1] ?? "", owner: method ? undefined : owner, method, position }];
  });
}

/** @param {string} source */
function functionBodies(source) {
  return [...source.matchAll(functionPattern)].map((match) => ({
    name: match[1] ?? "",
    start: match.index,
    end: blockEnd(source, match.index + match[0].length - 1),
  }));
}

/**
 * Collects wire error codes from Herdr Rust sources keyed by path relative to `src/`.
 * @param {ReadonlyArray<{ readonly path: string; readonly source: string }>} files
 */
export function sweepHerdrServerErrorCodes(files) {
  const serverFiles = files
    .filter((file) => isServerSource(file.path))
    .map((file) => ({ path: file.path, source: withoutTestModules(file.source) }));
  const bodies = serverFiles.map((file) => functionBodies(file.source));
  const handshakeRejecters = new Set(
    serverFiles.flatMap((file, index) =>
      (bodies[index] ?? [])
        .filter((body) => handshakeRejectionPattern.test(file.source.slice(body.start, body.end)))
        .map((body) => body.name),
    ),
  );
  const handshakeCalls = [...handshakeRejecters].map(
    (name) => new RegExp(String.raw`\b${name}\s*\(`),
  );
  const helpers = serverFiles.flatMap((file) =>
    codeHelpers(file.source)
      .filter((helper) => !handshakeRejecters.has(helper.name))
      .map((helper) => ({ ...helper, path: file.path })),
  );
  /** @type {Set<string>} */
  const codes = new Set();
  const codeArgument = new RegExp(`^${codeLiteral}$`);
  for (const [index, file] of serverFiles.entries()) {
    const handshakeBodies = (bodies[index] ?? []).filter((body) => {
      const text = file.source.slice(body.start, body.end);
      return handshakeRejectionPattern.test(text) || handshakeCalls.some((call) => call.test(text));
    });
    /** @param {number} position @param {string | undefined} code */
    const add = (position, code) => {
      if (code && !handshakeBodies.some((body) => body.start <= position && position < body.end))
        codes.add(code);
    };
    for (const pattern of [fieldPattern, resultTuplePattern, messageTuplePattern])
      for (const match of file.source.matchAll(pattern)) add(match.index, match[1]);
    for (const helper of helpers) {
      const receivers = helper.method
        ? String.raw`\.`
        : helper.owner === undefined
          ? String.raw`(?<!\w|fn\s)`
          : String.raw`\b(?:${helper.owner}${helper.path === file.path ? "|Self" : ""})::`;
      const pattern = new RegExp(String.raw`${receivers}${helper.name}\s*\(`, "g");
      for (const call of file.source.matchAll(pattern)) {
        const argument = callArguments(file.source, call.index + call[0].length - 1)[
          helper.position
        ];
        add(call.index, argument === undefined ? undefined : codeArgument.exec(argument)?.[1]);
      }
    }
  }
  return [...codes].sort((left, right) => left.localeCompare(right));
}

const sweep = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const [root, flag, ...extra] = process.argv.slice(2);
  if (root === undefined || (flag !== undefined && flag !== "--check") || extra.length > 0) {
    process.exitCode = 2;
    return yield* Effect.fail(
      SweepError.make({
        message: "Usage: node scripts/sweep-herdr-server-error-codes.mjs HERDR_CHECKOUT [--check]",
      }),
    );
  }
  const sourceRoot = join(root, "src");
  const paths = yield* fs.readDirectory(sourceRoot, { recursive: true });
  const files = yield* Effect.forEach(
    paths.filter((path) => path.endsWith(".rs")),
    (path) =>
      fs.readFileString(join(sourceRoot, path)).pipe(Effect.map((source) => ({ path, source }))),
  );
  const codes = sweepHerdrServerErrorCodes(files);
  if (flag === undefined) {
    yield* Console.log(codes.join("\n"));
    return;
  }
  const { HerdrServerErrorCode } = yield* Effect.promise(
    () => import(new URL("../src/herdr-errors.ts", import.meta.url).href),
  );
  const catalogue = new Set(Object.values(HerdrServerErrorCode));
  const missing = codes.filter((code) => !catalogue.has(code));
  const stale = [...catalogue]
    .filter((code) => !codes.includes(code))
    .sort((left, right) => left.localeCompare(right));
  for (const code of missing) yield* Console.log(`+ ${code}`);
  for (const code of stale) yield* Console.log(`- ${code}`);
  if (missing.length + stale.length > 0)
    return yield* Effect.fail(
      SweepError.make({
        message: `HerdrServerErrorCode differs from ${root}: ${missing.length} missing, ${stale.length} stale`,
      }),
    );
  yield* Console.log(`HerdrServerErrorCode matches all ${codes.length} codes in ${root}`);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  NodeRuntime.runMain(
    sweep.pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(
            error._tag === "SweepError" ? error.message : `Sweep failed (${error._tag})`,
          );
          process.exitCode ||= 1;
        }),
      ),
    ),
  );
