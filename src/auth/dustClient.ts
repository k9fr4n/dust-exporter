import { DustAPI } from "@dust-tt/client";

import { apiDomainForRegion, loadConfig } from "../config";
import AuthService from "./authService";
import TokenStorage from "./tokenStorage";

let cached: DustAPI | null = null;
export function resetDustClient(): void { cached = null; }

/** Build (and cache) a DustAPI bound to the shared dust-cli OAuth session.
 *  Returns null when the user is not authenticated. */
export async function getDustClient(): Promise<DustAPI | null> {
  if (cached) return cached;
  const token = await AuthService.getValidAccessToken();
  if (!token) return null;
  const cfg = loadConfig();
  const region = await TokenStorage.getRegion();
  const url = apiDomainForRegion(region, cfg);
  const workspaceId = (await TokenStorage.getWorkspaceId()) ?? "me";
  cached = new DustAPI(
    { url },
    {
      apiKey: async () => (await AuthService.getValidAccessToken()) || "",
      workspaceId,
      // Identify exactly like the official dust-cli: the Dust API only accepts
      // context.origin = "cli" when these headers match the CLI.
      extraHeaders: {
        "X-Dust-CLI-Version": process.env.DUST_PROXY_CLI_VERSION || "0.4.5",
        "User-Agent": "Dust CLI",
      },
    },
    console,
  );
  return cached;
}
