import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { resolveActingAid, detectEnv, resolveApiToken, matouDataDir } from "../src/identity.js";

afterEach(() => {
  delete process.env.MATOU_USER_AID;
  delete process.env.MATOU_API_TOKEN;
});

describe("resolveActingAid", () => {
  const none = async () => undefined;
  it("prefers the MATOU_USER_AID env override", async () => {
    process.env.MATOU_USER_AID = "EOVERRIDE";
    expect(await resolveActingAid(async () => "EBACKEND", () => '{"aid":"EFILE"}')).toBe("EOVERRIDE");
  });
  it("uses the running backend's identity before the file", async () => {
    expect(await resolveActingAid(async () => "EBACKEND", () => '{"aid":"EFILE"}')).toBe("EBACKEND");
  });
  it("reads aid from a plaintext identity.json when the backend has none", async () => {
    expect(await resolveActingAid(none, () => '{"aid":"EFILE"}')).toBe("EFILE");
  });
  it("explains an encrypted identity.json instead of a JSON parse error", async () => {
    await expect(resolveActingAid(none, () => "MATOU-IDENC1\n\u0000garbage")).rejects.toThrowError(
      /encrypted.*set MATOU_USER_AID/,
    );
  });
  it("throws a helpful error when the file is unreadable", async () => {
    await expect(
      resolveActingAid(none, () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toThrowError(/set MATOU_USER_AID/);
  });
});

describe("matouDataDir", () => {
  it("uses Application Support on macOS", () => {
    expect(matouDataDir("darwin", {}, "/Users/me")).toBe(
      join("/Users/me", "Library", "Application Support", "Matou", "matou-data"),
    );
  });
  it("uses ~/.config (or XDG_CONFIG_HOME) on Linux", () => {
    expect(matouDataDir("linux", {}, "/home/me")).toBe(join("/home/me", ".config", "Matou", "matou-data"));
    expect(matouDataDir("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/me")).toBe(join("/xdg", "Matou", "matou-data"));
  });
  it("uses %APPDATA% on Windows", () => {
    expect(matouDataDir("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me")).toBe(
      join("C:\\Users\\me\\AppData\\Roaming", "Matou", "matou-data"),
    );
  });
  it("honours MATOU_DATA_DIR (kit builds with another productName)", () => {
    expect(matouDataDir("darwin", { MATOU_DATA_DIR: "/custom" }, "/Users/me")).toBe("/custom");
  });
});

describe("detectEnv", () => {
  it("maps known ports", () => {
    expect(detectEnv("http://127.0.0.1:8080")).toBe("dev");
    expect(detectEnv("http://127.0.0.1:9080")).toBe("test");
    expect(detectEnv("http://127.0.0.1:46505")).toBe("prod");
  });
});

describe("resolveApiToken", () => {
  it("prefers the MATOU_API_TOKEN env override", () => {
    process.env.MATOU_API_TOKEN = "env-token";
    expect(resolveApiToken("prod", () => "file-token")).toBe("env-token");
  });
  it("uses the dev constant for dev/test backends even when the file exists", () => {
    // The file only ever holds the packaged app's token; reading it against
    // a dev/test backend would 401 every mutation.
    expect(resolveApiToken("dev", () => "file-token")).toBe("matou-dev");
    expect(resolveApiToken("test", () => "file-token")).toBe("matou-dev");
  });
  it("reads the token from the api-token file for prod backends", () => {
    expect(resolveApiToken("prod", () => "file-token\n")).toBe("file-token");
  });
  it("falls back to the dev constant when the file is unreadable", () => {
    expect(
      resolveApiToken("prod", () => {
        throw new Error("ENOENT");
      }),
    ).toBe("matou-dev");
  });
});
