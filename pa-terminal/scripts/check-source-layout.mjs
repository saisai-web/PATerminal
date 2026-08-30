import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");

const allowedSourceDirectories = new Set([
  "app",
  "features",
  "i18n",
  "platform",
  "shared",
  "styles",
  "terminal",
  "workspace",
]);
const allowedFeatureDirectories = new Set([
  "agents",
  "attachments",
  "broadcast",
  "explorer",
  "git",
  "history",
  "license",
  "pair",
  "quick-phrases",
  "settings",
  "sidebar",
  "update",
]);
const allowedRootFiles = new Set(["ARCHITECTURE.md", "main.ts", "styles.css"]);

async function unexpectedEntries(directory, allowedDirectories, allowedFiles = new Set()) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) =>
      entry.isDirectory()
        ? !allowedDirectories.has(entry.name)
        : !allowedFiles.has(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

const invalidSourceEntries = await unexpectedEntries(
  sourceRoot,
  allowedSourceDirectories,
  allowedRootFiles,
);
const invalidFeatureEntries = await unexpectedEntries(
  path.join(sourceRoot, "features"),
  allowedFeatureDirectories,
);

const errors = [];
if (invalidSourceEntries.length > 0) {
  errors.push(`unexpected src/ entries: ${invalidSourceEntries.join(", ")}`);
}
if (invalidFeatureEntries.length > 0) {
  errors.push(`unexpected src/features/ entries: ${invalidFeatureEntries.join(", ")}`);
}

if (errors.length > 0) {
  console.error("Source layout does not match src/ARCHITECTURE.md:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Source layout matches src/ARCHITECTURE.md");
}
