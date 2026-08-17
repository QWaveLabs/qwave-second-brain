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
  constructor({ supported = true, summary = "Simulated private Mac environment", customerMessage } = {}) {
    this.supported = supported;
    this.summary = summary;
    this.customerMessage = customerMessage;
    this.inspectCalls = 0;
  }

  async inspect() {
    this.inspectCalls += 1;
    return {
      supported: this.supported,
      summary: this.summary,
      customerMessage: this.customerMessage
    };
  }
}

export class SimulatedDesktopVaultAdapter {
  constructor({ desktopRoot = "/simulated/Desktop", failuresBeforeSuccess = 0 } = {}) {
    this.desktopRoot = desktopRoot;
    this.failuresBeforeSuccess = failuresBeforeSuccess;
    this.ensureCalls = 0;
    this.createdVaults = 0;
    this.vaults = new Map();
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
      simulated: true
    };
  }
}
