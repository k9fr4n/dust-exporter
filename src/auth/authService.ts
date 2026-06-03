import { jwtDecode } from "jwt-decode";

import { loadConfig } from "../config";
import { log } from "../logger";
import TokenStorage from "./tokenStorage";

interface JWTPayload { exp?: number; [k: string]: unknown }

function isApiKey(token: string | null): token is string {
  return !!token && token.startsWith("sk-");
}
function expiry(token: string): number {
  try { return jwtDecode<JWTPayload>(token).exp ?? 0; } catch { return 0; }
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export const AuthService = {
  /** Refresh the access token using the stored refresh token (WorkOS). */
  async refreshTokens(): Promise<boolean> {
    const cfg = loadConfig();
    const refreshToken = await TokenStorage.getRefreshToken();
    if (!refreshToken) return false;
    const res = await fetch(`https://${cfg.workosDomain}/user_management/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: cfg.workosClientId,
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) await TokenStorage.clearTokens();
      log.warn("token refresh failed", res.status);
      return false;
    }
    const data = (await res.json()) as { access_token: string; refresh_token: string };
    await TokenStorage.saveTokens(data.access_token, data.refresh_token);
    return true;
  },

  /** Returns a usable access token, refreshing proactively when close to expiry. */
  async getValidAccessToken(): Promise<string | null> {
    const token = await TokenStorage.getAccessToken();
    if (isApiKey(token)) return token;
    if (!token) {
      return (await this.refreshTokens()) ? TokenStorage.getAccessToken() : null;
    }
    const secondsLeft = expiry(token) - Math.floor(Date.now() / 1000);
    if (secondsLeft < 30) {
      return (await this.refreshTokens()) ? TokenStorage.getAccessToken() : null;
    }
    return token;
  },

  async isAuthenticated(): Promise<boolean> {
    const token = await TokenStorage.getAccessToken();
    if (isApiKey(token)) return true;
    if (token && expiry(token) > Math.floor(Date.now() / 1000)) return true;
    return this.refreshTokens();
  },

  async logout(): Promise<void> {
    await TokenStorage.clearTokens();
  },

  /** Start the WorkOS device authorization flow. */
  async startDeviceFlow(): Promise<DeviceCode> {
    const cfg = loadConfig();
    const res = await fetch(`https://${cfg.workosDomain}/user_management/authorize/device`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.workosClientId, scope: "openid profile email" }),
    });
    if (!res.ok) throw new Error(`Device flow failed: ${await res.text()}`);
    return (await res.json()) as DeviceCode;
  },

  /** Poll until the device flow completes; saves tokens + region on success. */
  async pollDeviceFlow(dc: DeviceCode): Promise<void> {
    const cfg = loadConfig();
    const deadline = Date.now() + dc.expires_in * 1000;
    let interval = Math.max(dc.interval, 1) * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      const res = await fetch(`https://${cfg.workosDomain}/user_management/authenticate`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: dc.device_code,
          client_id: cfg.workosClientId,
        }),
      });
      const data = (await res.json()) as
        | { access_token: string; refresh_token: string }
        | { error: string; error_description?: string };
      if ("error" in data) {
        if (data.error === "authorization_pending") continue;
        if (data.error === "slow_down") { interval += 2000; continue; }
        throw new Error(data.error_description || data.error);
      }
      await TokenStorage.saveTokens(data.access_token, data.refresh_token);
      try {
        const decoded = jwtDecode<Record<string, unknown>>(data.access_token);
        const region = decoded[`${cfg.workosClaimNamespace}region`];
        await TokenStorage.saveRegion(typeof region === "string" ? region : "us-central1");
      } catch {
        await TokenStorage.saveRegion("us-central1");
      }
      return;
    }
    throw new Error("Device code expired. Please retry.");
  },
};

export default AuthService;
