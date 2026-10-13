import { DataProtectionScope, FilePersistenceWithDataProtection } from "@azure/msal-node-extensions";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * A workspace's model-provider keys, one DPAPI-encrypted file each at `<dataDir>/secrets/<workspaceId>/<name>.bin` (decided
 * 2026-10-13). Only the Windows user that wrote one can read it. They are never in the ledger, an export or a backup: a restored
 * machine asks for the key again, which is safer than carrying it inside a backup. Off Windows there is no DPAPI, and a key is
 * refused rather than written in plain text.
 */
export type SecretStore = {
  read(workspaceId: string, name: string): Promise<string | undefined>;
  write(workspaceId: string, name: string, value: string): Promise<void>;
  remove(workspaceId: string, name: string): void;
};

const safe = (part: string) => part.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);

export function createDpapiSecretStore(dataDir: string, platform: string = process.platform): SecretStore {
  const fileOf = (workspaceId: string, name: string) => path.join(dataDir, "secrets", safe(workspaceId), `${safe(name)}.bin`);
  const open = async (file: string) => {
    if (platform !== "win32") throw new Error("SECRET_STORE_UNAVAILABLE");
    mkdirSync(path.dirname(file), { recursive: true });
    return FilePersistenceWithDataProtection.create(file, DataProtectionScope.CurrentUser);
  };
  return {
    async read(workspaceId, name) {
      const file = fileOf(workspaceId, name);
      if (!existsSync(file)) return undefined;
      return (await (await open(file)).load()) ?? undefined;
    },
    async write(workspaceId, name, value) { await (await open(fileOf(workspaceId, name))).save(value); },
    remove(workspaceId, name) { rmSync(fileOf(workspaceId, name), { force: true }); }
  };
}

/** For tests and for a machine without DPAPI where nothing may be written: held in memory only, gone with the process. */
export function createMemorySecretStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    read: async (workspaceId, name) => values.get(`${workspaceId}/${name}`),
    write: async (workspaceId, name, value) => { values.set(`${workspaceId}/${name}`, value); },
    remove: (workspaceId, name) => { values.delete(`${workspaceId}/${name}`); }
  };
}
