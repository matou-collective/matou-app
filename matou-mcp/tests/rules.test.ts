import { describe, it, expect } from "vitest";
import {
  validateEnum,
  CONTRIBUTION_TYPES,
  NOTICE_TYPES,
  buildDerivationNote,
} from "../src/rules.js";

describe("validateEnum", () => {
  it("accepts a valid value", () => {
    expect(validateEnum("contribution_type", "research_knowledge", CONTRIBUTION_TYPES)).toBe(
      "research_knowledge",
    );
  });
  it("throws listing valid options on an invalid value", () => {
    expect(() => validateEnum("type", "party", NOTICE_TYPES)).toThrowError(
      /type must be one of: event, update, announcement/,
    );
  });
});

describe("buildDerivationNote", () => {
  it("includes the rate when amount is given", () => {
    expect(buildDerivationNote(24.375, 1950)).toBe(
      "Effort: 24.375 hrs @ $80.00/hr = $1950. (Stored as whole hours; this build accepts integers only.)",
    );
  });
  it("omits the rate when amount is missing", () => {
    expect(buildDerivationNote(24.375)).toBe(
      "Effort: 24.375 hrs (stored rounded to whole hours; this build accepts integers only).",
    );
  });
});
