/**
 * Deterministic test/demonstration adapters. They never access a real Desktop,
 * install Obsidian, or access customer sources.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class FileStateStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

export class SimulatedEnvironmentAdapter {
  constructor({ supported = true, summary = "Simulated private Mac environment", customerMessage, sharedProfile = false } = {}) {
    this.supported = supported;
    this.summary = summary;
    this.customerMessage = customerMessage;
    this.sharedProfile = sharedProfile;
    this.inspectCalls = 0;
  }

  async inspect() {
    this.inspectCalls += 1;
    return {
      supported: this.supported,
      summary: this.summary,
      customerMessage: this.customerMessage,
      sharedProfile: this.sharedProfile
    };
  }
}

/**
 * Simulates only the observable macOS/Obsidian contract. It deliberately does
 * not install software, read a real vault, or open a real application. A test
 * may call simulateCustomerInstalledOfficialObsidian() between Setup Session
 * resumes to model the customer completing the one official install action.
 */
export class SimulatedObsidianAdapter {
  constructor({
    installed = true,
    official = true,
    appPath = "/Applications/Obsidian.app",
    existingVaults = [],
    openFailuresBeforeSuccess = 0
  } = {}) {
    this.installed = installed;
    this.official = official;
    this.appPath = appPath;
    this.existingVaults = structuredClone(existingVaults);
    this.openFailuresBeforeSuccess = openFailuresBeforeSuccess;
    this.inspectCalls = 0;
    this.officialInstallActionCalls = 0;
    this.installCalls = 0;
    this.openCalls = 0;
    this.openedVaultPaths = [];
  }

  async inspect() {
    this.inspectCalls += 1;
    return {
      installed: this.installed,
      official: this.official,
      appPath: this.installed ? this.appPath : null,
      existingVaults: structuredClone(this.existingVaults),
      simulated: true
    };
  }

  async createOfficialInstallAction({ downloadUrl }) {
    this.officialInstallActionCalls += 1;
    return {
      kind: "official-download-and-install",
      label: "Install Obsidian from the official page",
      url: downloadUrl,
      simulated: true
    };
  }

  async verifyVaultOpen({ path }) {
    this.openCalls += 1;
    if (!this.installed || !this.official || this.openFailuresBeforeSuccess > 0) {
      if (this.openFailuresBeforeSuccess > 0) this.openFailuresBeforeSuccess -= 1;
      return { opened: false, path: null, simulated: true };
    }
    this.openedVaultPaths.push(path);
    return { opened: true, path, simulated: true };
  }

  simulateCustomerInstalledOfficialObsidian() {
    this.installed = true;
    this.official = true;
  }

  getExistingVaults() {
    return structuredClone(this.existingVaults);
  }
}

export class SimulatedDesktopVaultAdapter {
  constructor({ desktopRoot = "/simulated/Desktop", failuresBeforeSuccess = 0 } = {}) {
    this.desktopRoot = desktopRoot;
    this.failuresBeforeSuccess = failuresBeforeSuccess;
    this.ensureCalls = 0;
    this.writeCalls = 0;
    this.planCalls = 0;
    this.createdVaults = 0;
    this.vaults = new Map();
  }

  async planDesktopVault({ name }) {
    this.planCalls += 1;
    const path = `${this.desktopRoot}/${name}`;
    return {
      path,
      exists: this.vaults.has(path),
      simulated: true
    };
  }

  async ensureVault({ name, homeContent, statusContent }) {
    this.ensureCalls += 1;
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess -= 1;
      throw new Error("Simulated vault adapter failed before creating a vault.");
    }

    const path = `${this.desktopRoot}/${name}`;
    let files = this.vaults.get(path);
    if (!files) {
      files = new Map();
      this.vaults.set(path, files);
      this.createdVaults += 1;
    }
    if (!files.has("Home.md")) files.set("Home.md", homeContent);
    if (!files.has("System/Status.md")) files.set("System/Status.md", statusContent);

    return {
      path,
      files: [...files.keys()],
      simulated: true
    };
  }

  async inspect({ path }) {
    const files = this.vaults.get(path);
    return {
      exists: Boolean(files),
      files: files ? [...files.keys()] : [],
      contents: files ? Object.fromEntries(files) : {},
      simulated: true
    };
  }

  async writeFiles({ path, files }) {
    this.writeCalls += 1;
    const vault = this.vaults.get(path);
    if (!vault) {
      throw new Error("Simulated vault does not exist.");
    }
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      throw new TypeError("files must be an object keyed by safe vault-relative paths.");
    }

    for (const [relativePath, content] of Object.entries(files)) {
      if (
        typeof relativePath !== "string"
        || relativePath.length === 0
        || relativePath.startsWith("/")
        || relativePath.split("/").includes("..")
      ) {
        throw new TypeError("Foundation files must stay inside the simulated vault.");
      }
      if (typeof content !== "string") {
        throw new TypeError("Foundation file content must be text.");
      }
      vault.set(relativePath, content);
    }

    return {
      path,
      files: [...vault.keys()],
      simulated: true
    };
  }
}
