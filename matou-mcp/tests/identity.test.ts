import { describe, it, expect, afterEach } from "vitest";
import { resolveActingAid, detectEnv, resolveApiToken } from "../src/identity.js";

afterEach(() => {
  delete process.env.MATOU_USER_AID;
  delete process.env.MATOU_API_TOKEN;
});

describe("resolveActingAid", () => {
  it("prefers the MATOU_USER_AID env override", () => {
    process.env.MATOU_USER_AID = "EOVERRIDE";
    expect(resolveActingAid(() => '{"aid":"EFILE"}')).toBe("EOVERRIDE");
  });
  it("reads aid from identity.json when no override", () => {
    expect(resolveActingAid(() => '{"aid":"EFILE"}')).toBe("EFILE");
  });
  it("throws a helpful error when the file is unreadable", () => {
    expect(() =>
      resolveActingAid(() => {
        throw new Error("ENOENT");
      }),
    ).toThrowError(/set MATOU_USER_AID/);
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
