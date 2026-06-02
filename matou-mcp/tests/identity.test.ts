import { describe, it, expect, afterEach } from "vitest";
import { resolveActingAid, detectEnv } from "../src/identity.js";

afterEach(() => {
  delete process.env.MATOU_USER_AID;
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
