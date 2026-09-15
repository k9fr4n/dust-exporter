import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ access: "expired" as string | null, refresh: "old" as string | null, clears: 0 }));
vi.mock("../src/auth/tokenStorage", () => ({ default: {
  getAccessToken: async () => storage.access,
  getRefreshToken: async () => storage.refresh,
  clearTokensIfRefreshToken: async (expected: string) => {
    if (storage.refresh !== expected) return false;
    storage.access = null; storage.refresh = null; storage.clears++; return true;
  },
  saveTokensIfRefreshToken: async (expected: string, access: string, refresh: string) => {
    if (storage.refresh !== expected) return false;
    storage.access = access; storage.refresh = refresh; return true;
  },
} }));

import AuthService from "../src/auth/authService";
import { deferred } from "./dustHarness";

beforeEach(() => { storage.access = "expired"; storage.refresh = "old"; storage.clears = 0; });
afterEach(() => vi.unstubAllGlobals());

describe("OAuth refresh lifecycle", () => {
  it("shares a single refresh across concurrent authenticated requests", async () => {
    const response = deferred<any>();
    const fetch = vi.fn(() => response.promise); vi.stubGlobal("fetch", fetch);
    const first = AuthService.getValidAccessToken();
    const second = AuthService.getValidAccessToken();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    response.resolve({ ok: true, json: async () => ({ access_token: "fresh", refresh_token: "rotated" }) });
    expect(await Promise.all([first, second])).toEqual(["fresh", "fresh"]);
    expect(storage.clears).toBe(0);
  });

  it("does not erase tokens replaced while an older refresh was pending", async () => {
    const response = deferred<any>();
    vi.stubGlobal("fetch", vi.fn(() => response.promise));
    const request = AuthService.getValidAccessToken();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    storage.access = "new login"; storage.refresh = "new refresh";
    response.resolve({ ok: false, status: 401 });
    expect(await request).toBe("new login");
    expect(storage.clears).toBe(0);
  });

  it("does not overwrite a new login with a stale successful refresh", async () => {
    const response = deferred<any>();
    vi.stubGlobal("fetch", vi.fn(() => response.promise));
    const request = AuthService.getValidAccessToken();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    storage.access = "new login"; storage.refresh = "new refresh";
    response.resolve({ ok: true, json: async () => ({ access_token: "stale", refresh_token: "stale refresh" }) });
    expect(await request).toBe("new login");
    expect(storage.refresh).toBe("new refresh");
  });

  it("releases the shared refresh after failure so the next request can retry", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "fresh", refresh_token: "rotated" }) });
    vi.stubGlobal("fetch", fetch);
    await expect(AuthService.getValidAccessToken()).rejects.toThrow("network");
    expect(await AuthService.getValidAccessToken()).toBe("fresh");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
