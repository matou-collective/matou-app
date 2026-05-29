import { describe, it, expect } from "vitest";
import { MemberDirectory } from "../src/members.js";

const dir = new MemberDirectory([
  { aid: "EBEN", name: "Ben" },
  { aid: "EENGIE", name: "Engie M" },
  { aid: "ETY1", name: "Tyrone" },
  { aid: "ETY2", name: "Tyrone" },
]);

describe("MemberDirectory.resolve", () => {
  it("resolves a unique name case-insensitively", () => {
    expect(dir.resolve("ben")).toBe("EBEN");
  });
  it("passes through a value that already looks like an AID", () => {
    expect(dir.resolve("EUNKNOWNAIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(
      "EUNKNOWNAIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
  });
  it("throws on an unknown name", () => {
    expect(() => dir.resolve("Nobody")).toThrowError(/No member matching "Nobody"/);
  });
  it("throws on an ambiguous name listing the AIDs", () => {
    expect(() => dir.resolve("Tyrone")).toThrowError(/ambiguous.*ETY1.*ETY2/s);
  });
});

describe("MemberDirectory.name", () => {
  it("returns the display name for a known AID", () => {
    expect(dir.name("EENGIE")).toBe("Engie M");
  });
});
