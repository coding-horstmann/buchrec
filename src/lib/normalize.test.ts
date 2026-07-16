import { describe, expect, it } from "vitest";
import { normalizeHeader, parseAmount, parseDate, referenceTokens, similarity } from "./normalize";

describe("normalization", () => {
  it("parses German and international amounts", () => {
    expect(parseAmount("1.234,56 €")).toBe(1234.56);
    expect(parseAmount("-31.90")).toBe(-31.9);
    expect(parseAmount("(248,53)")).toBe(-248.53);
    expect(parseAmount("1,234.56 USD")).toBe(1234.56);
  });

  it("parses supported dates without changing the day", () => {
    expect(parseDate("10.01.2025")).toBe("2025-01-10");
    expect(parseDate("2025-12-31T22:10:00+01:00")).toBe("2025-12-31");
    expect(parseDate("02/01/2025", "mdy")).toBe("2025-02-01");
    expect(parseDate("15. Dez 2025", "german-named")).toBe("2025-12-15");
    expect(parseDate("15-Dez-25", "german-named")).toBe("2025-12-15");
    expect(parseDate("March 3, 2025")).toBe("2025-03-03");
    expect(parseDate("28. February 2025")).toBe("2025-02-28");
    expect(parseDate("1. März 2025", "german-named")).toBe("2025-03-01");
  });

  it("normalizes headers and compares counterparties", () => {
    expect(normalizeHeader("Gebühren & Steuern")).toBe("gebuhren steuern");
    expect(similarity("Google Ireland Limited", "GOOGLE Ireland")).toBeGreaterThan(0.5);
  });

  it("ignores standalone years without fixing the matcher to specific tax years", () => {
    expect(referenceTokens("Rechnung 2027 AB-4711")).toEqual(["ab-4711"]);
    expect(referenceTokens("Archiv 2031 Rechnung XZ-9000")).toEqual(["archiv", "xz-9000"]);
  });
});
