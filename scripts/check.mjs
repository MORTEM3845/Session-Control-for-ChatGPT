import { readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = new URL("../extension/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", extension), "utf8"));
const required = ["background.js", "content.js", "sidepanel.html", "sidepanel.css", "sidepanel.js"];

if (manifest.manifest_version !== 3)
  throw new Error("manifest_version must be 3");
if (manifest.name !== "Session Control for ChatGPT")
  throw new Error("Unexpected extension name");
if (manifest.permissions.includes("tabs") || manifest.permissions.includes("windows"))
  throw new Error("Broad tabs/windows permissions must not be added");
if (manifest.host_permissions.some(value => !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\/\*$/.test(value)))
  throw new Error("Unexpected host permission");

for (const file of required)
  await access(new URL(file, extension));

for (const file of ["background.js", "content.js", "sidepanel.js"]) {
  const path = new URL(file, extension);
  const result = spawnSync(process.execPath, ["--check", fileURLToPath(path)], { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(result.stderr || `Syntax check failed: ${file}`);

  const source = await readFile(path, "utf8");
  if (/\beval\s*\(|new\s+Function\s*\(/.test(source))
    throw new Error(`Dynamic code execution is forbidden: ${file}`);
  if (/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(source))
    throw new Error(`Unexpected network API: ${file}`);
}

console.log(`Validated Session Control for ChatGPT ${manifest.version}`);
