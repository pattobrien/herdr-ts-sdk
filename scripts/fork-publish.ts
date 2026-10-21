/**
 * Publishes the fork to GitHub Packages as `@pattobrien/herdr-sdk` at `<version>-fork.N`, restoring package.json afterwards.
 *
 * @since 0.9.0
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [version, ...publishArgs] = process.argv.slice(2);
const manifestPath = new URL("../package.json", import.meta.url);
const original = readFileSync(manifestPath, "utf8");
const manifest: { version: string } = JSON.parse(original);

if (/^(.+)-fork\.\d+$/.exec(version ?? "")?.[1] !== manifest.version) {
  throw new Error(`${version} is not ${manifest.version}-fork.N`);
}

const forkManifest = {
  ...manifest,
  name: "@pattobrien/herdr-sdk",
  version,
  repository: { type: "git", url: "git+https://github.com/pattobrien/herdr-ts-sdk.git" },
  publishConfig: { registry: "https://npm.pkg.github.com", access: "restricted" },
};

writeFileSync(manifestPath, `${JSON.stringify(forkManifest, null, 2)}\n`);
try {
  execFileSync("pnpm", ["publish", "--no-git-checks", ...publishArgs], { stdio: "inherit" });
} finally {
  writeFileSync(manifestPath, original);
}
