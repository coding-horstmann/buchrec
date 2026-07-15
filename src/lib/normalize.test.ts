import { describe, expect, it } from "vitest";
import { normalizeHeader, parseAmount, parseDate, similarity } from "./normalize";

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
  });

  it("normalizes headers and compares counterparties", () => {
    expect(normalizeHeader("Gebühren & Steuern")).toBe("gebuhren steuern");
    expect(similarity("Google Ireland Limited", "GOOGLE Ireland")).toBeGreaterThan(0.5);
  });
});
