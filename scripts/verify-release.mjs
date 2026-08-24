import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const publicRoot = resolve("public");
const channelsRoot = join(publicRoot, "channels");
const errors = [];

for (const name of await readdir(channelsRoot)) {
  if (!name.endsWith(".json")) continue;
  const channel = JSON.parse(await readFile(join(channelsRoot, name), "utf8"));
  if (!channel.release_manifest) continue;
  const manifestPath = resolve(publicRoot, channel.release_manifest.replace(/^\.\//, ""));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.entrypoint) errors.push(`${name}: release manifest has no entrypoint`);
  const releaseRoot = resolve(manifestPath, "..");
  for (const file of manifest.files ?? []) {
    try {
      const info = await stat(join(releaseRoot, file.path));
      if (info.size !== file.size) errors.push(`${name}: size mismatch for ${file.path}`);
    } catch {
      errors.push(`${name}: missing ${file.path}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("Web release registry is structurally valid.");
