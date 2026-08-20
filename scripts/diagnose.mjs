import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);

export async function readInstallerDiagnostic() {
  const [packageText, manifestText] = await Promise.all([
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("installer/manifest.json", root), "utf8")
  ]);
  const packageJson = JSON.parse(packageText);
  const manifest = JSON.parse(manifestText);
  if (packageJson.version !== manifest.installerVersion) {
    throw new Error("Installer manifest version does not match package.json.");
  }
  return {
    installerVersion: manifest.installerVersion,
    setupStateSchemaVersion: manifest.setupStateSchemaVersion,
    supportedEnvironment: manifest.supportedEnvironment,
    customerOwnership: manifest.customerOwnership,
    distribution: manifest.distribution,
    migration: manifest.migration,
    releaseLimitations: manifest.releaseLimitations
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await readInstallerDiagnostic(), null, 2)}\n`);
}
