// Credential storage that is WIRE-COMPATIBLE with the official dust-cli, so a
// session opened with `dust login` is transparently reused by this proxy (and
// vice-versa). Same keychain service name, same keys, same JSON file schema.
//
//   DUST_CREDENTIAL_STORE=auto|keychain|file  (default: auto)
//   DUST_CREDENTIAL_FILE=/custom/path.json     (file backend location)
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// keytar is a native module: load it lazily (and optionally) so the proxy still
// starts on hosts without it (e.g. Linux missing libsecret) when using the file
// backend. require() returns the CJS exports object directly and throws if the
// native binding can't load, which selectBackend() catches to fall back to file.
const requireCjs = createRequire(import.meta.url);
let keytarMod: typeof import("keytar") | null = null;
function loadKeytar(): typeof import("keytar") {
  if (!keytarMod) keytarMod = requireCjs("keytar") as typeof import("keytar");
  return keytarMod;
}

const SERVICE_NAME = "dust-cli";
export const KEYS = {
  ACCESS_TOKEN: "access_token",
  REFRESH_TOKEN: "refresh_token",
  WORKSPACE: "workspace_sid",
  REGION: "region",
} as const;

const DEFAULT_CREDENTIAL_FILE = join(homedir(), ".dust-cli", "credentials.json");

interface CredentialBackend {
  readonly name: "keychain" | "file";
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

class KeytarBackend implements CredentialBackend {
  readonly name = "keychain" as const;
  async get(key: string) { return loadKeytar().getPassword(SERVICE_NAME, key); }
  async set(key: string, value: string) { await loadKeytar().setPassword(SERVICE_NAME, key, value); }
  async delete(key: string) { await loadKeytar().deletePassword(SERVICE_NAME, key); }
}

interface CredentialFileShape {
  schema: "dust-cli.credentials.v1";
  service: string;
  credentials: Record<string, string>;
  updatedAt: string;
}

class FileBackend implements CredentialBackend {
  readonly name = "file" as const;
  constructor(private readonly path: string = DEFAULT_CREDENTIAL_FILE) {}

  // Re-read on every call so a token refreshed by another process (CLI, web)
  // is picked up immediately. The file is tiny.
  private async load(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as CredentialFileShape;
      if (parsed?.schema !== "dust-cli.credentials.v1") return {};
      return parsed.credentials || {};
    } catch (err: any) {
      if (err && err.code === "ENOENT") return {};
      if (err instanceof SyntaxError) {
        throw new Error(`Failed to parse credential file ${this.path}: ${err.message}`);
      }
      throw err;
    }
  }
  private async save(data: Record<string, string>): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const payload: CredentialFileShape = {
      schema: "dust-cli.credentials.v1",
      service: SERVICE_NAME,
      credentials: data,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmp, this.path);
    if (process.platform !== "win32") await fs.chmod(this.path, 0o600);
  }
  async get(key: string) { return (await this.load())[key] ?? null; }
  async set(key: string, value: string) {
    const data = await this.load();
    data[key] = value;
    await this.save(data);
  }
  async delete(key: string) {
    const data = await this.load();
    if (key in data) { delete data[key]; await this.save(data); }
  }
}

let backendPromise: Promise<CredentialBackend> | null = null;
async function selectBackend(): Promise<CredentialBackend> {
  const forced = (process.env.DUST_CREDENTIAL_STORE || "auto").toLowerCase().trim();
  const filePath = process.env.DUST_CREDENTIAL_FILE || DEFAULT_CREDENTIAL_FILE;
  if (forced === "file") return new FileBackend(filePath);
  if (forced === "keychain") return new KeytarBackend();
  try {
    const k = loadKeytar(); // may throw if the native module can't load
    await k.getPassword(SERVICE_NAME, "__probe__");
    return new KeytarBackend();
  } catch {
    return new FileBackend(filePath);
  }
}
function getBackend(): Promise<CredentialBackend> {
  if (!backendPromise) backendPromise = selectBackend();
  return backendPromise;
}

export const TokenStorage = {
  async saveTokens(accessToken: string, refreshToken: string) {
    const b = await getBackend();
    await b.set(KEYS.ACCESS_TOKEN, accessToken);
    await b.set(KEYS.REFRESH_TOKEN, refreshToken);
  },
  async getAccessToken() { return (await getBackend()).get(KEYS.ACCESS_TOKEN); },
  async getRefreshToken() { return (await getBackend()).get(KEYS.REFRESH_TOKEN); },
  async saveWorkspaceId(id: string) { await (await getBackend()).set(KEYS.WORKSPACE, id); },
  async getWorkspaceId() { return (await getBackend()).get(KEYS.WORKSPACE); },
  async saveRegion(region: string) { await (await getBackend()).set(KEYS.REGION, region); },
  async getRegion() { return (await getBackend()).get(KEYS.REGION); },
  async clearTokens() {
    const b = await getBackend();
    await b.delete(KEYS.ACCESS_TOKEN);
    await b.delete(KEYS.REFRESH_TOKEN);
    await b.delete(KEYS.WORKSPACE);
    await b.delete(KEYS.REGION);
  },
  async getBackendName() { return (await getBackend()).name; },
};

export default TokenStorage;
