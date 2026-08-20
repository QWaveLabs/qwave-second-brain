import { readdir, readFile, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ignoredDirectories = new Set([".git", "node_modules", "coverage"]);
const forbiddenDirectories = new Set([
  ".qwave-second-brain",
  ".qwave-second-brain-staging",
  "customer-state",
  "customer-vaults",
  "generated-vaults",
  "private-state",
  "raw-staging",
  "staging"
]);
const forbiddenFileNames = new Set(["credentials.json", "secrets.json"]);
const forbiddenContent = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|ghp)_[A-Za-z0-9]{20,}\b/,
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)\s*=/,
  /\/Users\/rob\//
];

async function walk(root, directory = root) {
  const findings = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const entryPath = resolve(directory, entry.name);
    const safeRelativePath = relative(root, entryPath);
    if (entry.isDirectory()) {
      if (forbiddenDirectories.has(entry.name)) {
        findings.push({ kind: "forbidden-directory", path: safeRelativePath });
        continue;
      }
      findings.push(...await walk(root, entryPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === ".env" || entry.name.startsWith(".env.") || entry.name.endsWith(".local.json") || forbiddenFileNames.has(entry.name)) {
      findings.push({ kind: "forbidden-file", path: safeRelativePath });
      continue;
    }
    if ((await stat(entryPath)).size > 512 * 1024) {
      findings.push({ kind: "oversized-public-file", path: safeRelativePath });
      continue;
    }
    const content = await readFile(entryPath, "utf8");
    if (forbiddenContent.some((pattern) => pattern.test(content))) {
      findings.push({ kind: "forbidden-content", path: safeRelativePath });
    }
  }
  return findings;
}

export async function scanPublicTree(root) {
  return walk(resolve(root));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const findings = await scanPublicTree(root);
  if (findings.length > 0) {
    process.stderr.write(`${JSON.stringify(findings, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Public scrub passed: no excluded private artifact or credential signature found.\n");
  }
}
