/**
 * Guarded macOS adapters for the QWA-140 handoff.
 *
 * They are intentionally inert by default: a caller must provide the exact
 * customer-approved Desktop vault path and opt in to creation/opening. Tests
 * inject their filesystem and `open` seams, so this module never needs to
 * touch the host during simulated verification.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OFFICIAL_OBSIDIAN_DOWNLOAD_URL = "https://obsidian.md/download";
const OFFICIAL_BUNDLE_IDENTIFIER = "md.obsidian";

const nodeFileSystem = Object.freeze({ mkdir, mkdtemp, readFile, rm, stat, writeFile });
const INSTALL_MARKER = ".qwave-second-brain-install.json";

function isMissingPath(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function pathExists(fileSystem, targetPath) {
  try {
    await fileSystem.stat(targetPath);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function parseBundleIdentifier(infoPlist) {
  const match = String(infoPlist).match(
    /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/i
  );
  return match?.[1]?.trim() ?? null;
}

function parseVaultRegistry(serializedRegistry) {
  try {
    const registry = JSON.parse(serializedRegistry);
    return Object.values(registry?.vaults ?? {})
      .filter((vault) => typeof vault?.path === "string")
      .map((vault) => ({ path: vault.path, open: vault.open === true }));
  } catch {
    // A corrupt or unavailable registry must never become a reason to alter it.
    return [];
  }
}

async function defaultRunOpenCommand({ appPath, vaultPath }) {
  try {
    await execFileAsync("open", ["-a", appPath, vaultPath]);
    return { started: true };
  } catch (error) {
    return { started: false, errorCode: error?.code ?? "OPEN_COMMAND_FAILED" };
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function normalizeDesktopPath(desktopRoot, name) {
  const normalizedRoot = resolve(desktopRoot);
  const targetPath = resolve(normalizedRoot, name);
  if (dirname(targetPath) !== normalizedRoot) {
    throw new Error("The requested vault path is outside the approved Desktop root.");
  }
  return targetPath;
}

/**
 * Read-only Obsidian detection and exact-vault open verification.
 *
 * `allowVaultOpen` and `approvedVaultPath` intentionally default to false/null.
 * An integration must set both only after the customer approves that exact path.
 */
export class MacOSObsidianAdapter {
  constructor({
    appPath = "/Applications/Obsidian.app",
    vaultRegistryPath = join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json"),
    approvedVaultPath = null,
    allowVaultOpen = false,
    fileSystem = nodeFileSystem,
    runOpenCommand = defaultRunOpenCommand,
    readOpenVaultPath = null,
    sleep = defaultSleep,
    openVerificationAttempts = 5,
    openVerificationDelayMs = 200,
    simulated = false
  } = {}) {
    this.appPath = resolve(appPath);
    this.vaultRegistryPath = vaultRegistryPath;
    this.approvedVaultPath = approvedVaultPath ? resolve(approvedVaultPath) : null;
    this.allowVaultOpen = allowVaultOpen;
    this.fileSystem = fileSystem;
    this.runOpenCommand = runOpenCommand;
    this.readOpenVaultPath = readOpenVaultPath;
    this.sleep = sleep;
    this.openVerificationAttempts = Math.max(1, openVerificationAttempts);
    this.openVerificationDelayMs = Math.max(0, openVerificationDelayMs);
    this.simulated = simulated;
  }

  async #readVaults() {
    try {
      return parseVaultRegistry(await this.fileSystem.readFile(this.vaultRegistryPath, "utf8"));
    } catch (error) {
      if (isMissingPath(error)) return [];
      throw error;
    }
  }

  async #readCurrentlyOpenVaultPath() {
    if (this.readOpenVaultPath) {
      return this.readOpenVaultPath();
    }
    return (await this.#readVaults()).find((vault) => vault.open)?.path ?? null;
  }

  async inspect() {
    const existingVaults = await this.#readVaults();
    if (!(await pathExists(this.fileSystem, this.appPath))) {
      return { installed: false, official: false, appPath: null, existingVaults, simulated: this.simulated };
    }

    let bundleIdentifier = null;
    try {
      const infoPlist = await this.fileSystem.readFile(join(this.appPath, "Contents", "Info.plist"), "utf8");
      bundleIdentifier = parseBundleIdentifier(infoPlist);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }

    return {
      installed: true,
      official: bundleIdentifier === OFFICIAL_BUNDLE_IDENTIFIER,
      appPath: this.appPath,
      existingVaults,
      simulated: this.simulated
    };
  }

  async createOfficialInstallAction({ downloadUrl }) {
    if (downloadUrl !== OFFICIAL_OBSIDIAN_DOWNLOAD_URL) {
      throw new Error("Only the official Obsidian download URL may be presented.");
    }
    return {
      kind: "official-download-and-install",
      label: "Install Obsidian from the official page",
      url: OFFICIAL_OBSIDIAN_DOWNLOAD_URL,
      simulated: this.simulated
    };
  }

  async verifyVaultOpen({ path }) {
    const requestedPath = resolve(path);
    if (!this.allowVaultOpen || this.approvedVaultPath !== requestedPath) {
      return {
        opened: false,
        path: null,
        code: "VAULT_OPEN_APPROVAL_REQUIRED",
        simulated: this.simulated
      };
    }

    const app = await this.inspect();
    if (!app.installed || !app.official) {
      return { opened: false, path: null, code: "OFFICIAL_OBSIDIAN_NOT_READY", simulated: this.simulated };
    }

    const openResult = await this.runOpenCommand({ appPath: this.appPath, vaultPath: requestedPath });
    if (!openResult?.started) {
      return { opened: false, path: null, code: openResult?.errorCode ?? "OPEN_COMMAND_FAILED", simulated: this.simulated };
    }

    let openedPath = null;
    for (let attempt = 0; attempt < this.openVerificationAttempts; attempt += 1) {
      openedPath = await this.#readCurrentlyOpenVaultPath();
      if (openedPath && resolve(openedPath) === requestedPath) {
        return { opened: true, path: requestedPath, simulated: this.simulated };
      }
      if (attempt < this.openVerificationAttempts - 1) {
        await this.sleep(this.openVerificationDelayMs);
      }
    }

    return {
      opened: false,
      path: openedPath ? resolve(openedPath) : null,
      code: "EXACT_VAULT_NOT_OPEN",
      simulated: this.simulated
    };
  }
}

/**
 * Narrow writer for one pre-approved Desktop vault. It stages content before
 * reserving the final path, then uses an installation-owned marker to resume a
 * partial write. It never overwrites an existing customer folder.
 */
export class MacOSDesktopVaultAdapter {
  constructor({
    desktopRoot = join(homedir(), "Desktop"),
    approvedVaultPath = null,
    allowCreate = false,
    fileSystem = nodeFileSystem,
    simulated = false
  } = {}) {
    this.desktopRoot = resolve(desktopRoot);
    this.approvedVaultPath = approvedVaultPath ? resolve(approvedVaultPath) : null;
    this.allowCreate = allowCreate;
    this.fileSystem = fileSystem;
    this.simulated = simulated;
    this.knownStagingPaths = new Map();
  }

  #markerPath(vaultPath) {
    return join(vaultPath, INSTALL_MARKER);
  }

  #ownerRecord({ targetPath, installationId, state }) {
    return {
      product: "qwave-second-brain",
      version: 1,
      targetPath,
      installationId,
      state
    };
  }

  async #readMarker(vaultPath) {
    try {
      return JSON.parse(await this.fileSystem.readFile(this.#markerPath(vaultPath), "utf8"));
    } catch (error) {
      if (isMissingPath(error) || error instanceof SyntaxError) return null;
      return null;
    }
  }

  async #isOwnedVault(vaultPath, installationId) {
    const marker = await this.#readMarker(vaultPath);
    return marker?.product === "qwave-second-brain"
      && marker?.targetPath === vaultPath
      && marker?.installationId === installationId;
  }

  async #ensureDirectory(directoryPath) {
    try {
      await this.fileSystem.mkdir(directoryPath, { recursive: false });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await this.fileSystem.stat(directoryPath);
      if (typeof existing?.isDirectory === "function" && !existing.isDirectory()) {
        throw new Error("An installer-owned vault path contains an unexpected file.");
      }
    }
  }

  async #writeOwnedFile(filePath, content) {
    try {
      await this.fileSystem.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existingContent = await this.fileSystem.readFile(filePath, "utf8");
      if (existingContent !== content) {
        throw new Error("An installer-owned vault file changed while setup was paused, so it will not be overwritten.");
      }
    }
  }

  async #writeMarker(vaultPath, owner, flag) {
    await this.fileSystem.writeFile(this.#markerPath(vaultPath), `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      flag
    });
  }

  async #buildStagingVault({ targetPath, installationId, homeContent, statusContent }) {
    const stagingPath = await this.fileSystem.mkdtemp(`${targetPath}.qwave-second-brain-staging-`);
    const stagingOwner = this.#ownerRecord({ targetPath, installationId, state: "staging" });
    this.knownStagingPaths.set(stagingPath, stagingOwner);
    try {
      await this.#writeMarker(stagingPath, stagingOwner, "wx");
      await this.#ensureDirectory(join(stagingPath, "System"));
      await this.#writeOwnedFile(join(stagingPath, "Home.md"), homeContent);
      await this.#writeOwnedFile(join(stagingPath, "System", "Status.md"), statusContent);

      const requiredFiles = [join(stagingPath, "Home.md"), join(stagingPath, "System", "Status.md")];
      for (const requiredFile of requiredFiles) {
        if (!(await pathExists(this.fileSystem, requiredFile))) {
          throw new Error("The staged vault is incomplete, so the customer Desktop path was not touched.");
        }
      }
      return stagingPath;
    } catch (error) {
      // The path came from this adapter's fresh mkdtemp call. If its marker was
      // not written, this in-memory ownership record is the only safe cleanup
      // authority; no pre-existing customer path can be selected here.
      await this.#cleanOwnedStaging(stagingPath, targetPath, installationId);
      throw error;
    }
  }

  async #cleanOwnedStaging(stagingPath, targetPath, installationId) {
    if (!stagingPath || !stagingPath.startsWith(`${targetPath}.qwave-second-brain-staging-`)) return;
    const marker = await this.#readMarker(stagingPath);
    const expected = this.#ownerRecord({ targetPath, installationId, state: "staging" });
    const markerMatches = marker?.product === expected.product
      && marker?.targetPath === expected.targetPath
      && marker?.installationId === expected.installationId
      && marker?.state === expected.state;
    const knownOwner = this.knownStagingPaths.get(stagingPath);
    const knownOwnerMatches = knownOwner?.product === expected.product
      && knownOwner?.targetPath === expected.targetPath
      && knownOwner?.installationId === expected.installationId
      && knownOwner?.state === expected.state;
    if (!markerMatches && !knownOwnerMatches) {
      return;
    }
    try {
      await this.fileSystem.rm(stagingPath, { recursive: true, force: false });
      this.knownStagingPaths.delete(stagingPath);
    } catch {
      // A leftover verified staging directory is harmless and must not block a safe retry.
    }
  }

  async #completeOwnedVault({ targetPath, installationId, homeContent, statusContent }) {
    if (!(await this.#isOwnedVault(targetPath, installationId))) {
      throw new Error("The existing Desktop path is not owned by this setup session and will not be modified.");
    }
    await this.#ensureDirectory(join(targetPath, "System"));
    await this.#writeOwnedFile(join(targetPath, "Home.md"), homeContent);
    await this.#writeOwnedFile(join(targetPath, "System", "Status.md"), statusContent);
    await this.#writeMarker(
      targetPath,
      this.#ownerRecord({ targetPath, installationId, state: "complete" }),
      "w"
    );
  }

  async planDesktopVault({ name, installationId }) {
    const path = normalizeDesktopPath(this.desktopRoot, name);
    const exists = await pathExists(this.fileSystem, path);
    return {
      path,
      exists,
      existingOwnedByInstallation: exists && typeof installationId === "string"
        ? await this.#isOwnedVault(path, installationId)
        : false,
      simulated: this.simulated
    };
  }

  async ensureVault({ name, homeContent, statusContent, installationId }) {
    if (typeof installationId !== "string" || installationId.length === 0) {
      throw new Error("A persisted setup installation ID is required before creating a vault.");
    }
    const plannedVault = await this.planDesktopVault({ name, installationId });
    if (!this.allowCreate || this.approvedVaultPath !== plannedVault.path) {
      throw new Error("The exact Desktop vault path needs explicit customer approval before creation.");
    }

    if (plannedVault.exists) {
      if (!plannedVault.existingOwnedByInstallation) {
        throw new Error("The requested Desktop vault already exists and will not be modified.");
      }
      await this.#completeOwnedVault({
        targetPath: plannedVault.path,
        installationId,
        homeContent,
        statusContent
      });
      return { path: plannedVault.path, files: ["Home.md", "System/Status.md"], simulated: this.simulated };
    }

    let stagingPath = null;
    try {
      stagingPath = await this.#buildStagingVault({
        targetPath: plannedVault.path,
        installationId,
        homeContent,
        statusContent
      });
      await this.fileSystem.mkdir(plannedVault.path, { recursive: false });
    } catch (error) {
      await this.#cleanOwnedStaging(stagingPath, plannedVault.path, installationId);
      if (error?.code === "EEXIST" && await this.#isOwnedVault(plannedVault.path, installationId)) {
        await this.#completeOwnedVault({
          targetPath: plannedVault.path,
          installationId,
          homeContent,
          statusContent
        });
        return { path: plannedVault.path, files: ["Home.md", "System/Status.md"], simulated: this.simulated };
      }
      throw error;
    }

    try {
      await this.#writeMarker(
        plannedVault.path,
        this.#ownerRecord({ targetPath: plannedVault.path, installationId, state: "creating" }),
        "wx"
      );
      await this.#completeOwnedVault({
        targetPath: plannedVault.path,
        installationId,
        homeContent,
        statusContent
      });
    } finally {
      await this.#cleanOwnedStaging(stagingPath, plannedVault.path, installationId);
    }

    return {
      path: plannedVault.path,
      files: ["Home.md", "System/Status.md"],
      simulated: this.simulated
    };
  }

  async inspect({ path }) {
    const targetPath = resolve(path);
    if (!(await pathExists(this.fileSystem, targetPath))) {
      return { exists: false, files: [], simulated: this.simulated };
    }

    const files = [];
    for (const relativePath of ["Home.md", "System/Status.md"]) {
      if (await pathExists(this.fileSystem, join(targetPath, relativePath))) {
        files.push(relativePath);
      }
    }
    return { exists: true, files, simulated: this.simulated };
  }
}
