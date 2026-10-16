import { DataProtectionScope, FilePersistenceWithDataProtection } from "@azure/msal-node-extensions";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

export function createDpapiSecretStore(dataDir: string, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): SecretStore {
  // A Linux server (docs/beta-launch.md §10, the hosted beta) has no DPAPI: with a master key it uses AES-256-GCM instead.
  const masterKey = env.CROSSLINE_SECRET_KEY?.trim();
  if (platform !== "win32" && masterKey) return createKeyFileSecretStore(dataDir, masterKey);
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

/**
 * Off Windows, one AES-256-GCM file per secret at `<dataDir>/secrets/<workspaceId>/<name>.enc` (mode 0600), under a 32-byte master
 * key given base64 in `CROSSLINE_SECRET_KEY` — kept in the server's environment file, never in the data folder, so a copy of the data
 * (a backup) does not carry what opens it. Layout: 12-byte IV, 16-byte tag, ciphertext; the path is bound in as associated data, so a
 * file moved to another workspace's slot does not open.
 */
export function createKeyFileSecretStore(dataDir: string, masterKeyBase64: string): SecretStore {
  const key = Buffer.from(masterKeyBase64, "base64");
  if (key.length !== 32) throw new Error("SECRET_KEY_INVALID");
  const slot = (workspaceId: string, name: string) => `${safe(workspaceId)}/${safe(name)}`;
  const fileOf = (workspaceId: string, name: string) => path.join(dataDir, "secrets", safe(workspaceId), `${safe(name)}.enc`);
  return {
    async read(workspaceId, name) {
      const file = fileOf(workspaceId, name);
      if (!existsSync(file)) return undefined;
      const bytes = readFileSync(file);
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(slot(workspaceId, name)));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    },
    async write(workspaceId, name, value) {
      const file = fileOf(workspaceId, name);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(slot(workspaceId, name)));
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      writeFileSync(file, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
    },
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
