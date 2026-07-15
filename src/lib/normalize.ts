import type { Direction, MetadataValue } from "../types";

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .trim()
    .toLocaleLowerCase("de-DE");
}

export function normalizeHeader(value: unknown): string {
  return normalizeText(value)
    .replace(/[€$£]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function parseAmount(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  let text = String(value ?? "").trim();
  if (!text || text === "--") return 0;

  const negativeByParentheses = /^\(.*\)$/.test(text);
  text = text.replace(/[()]/g, "").replace(/\s/g, "").replace(/[^0-9,.'+\-]/g, "");
  text = text.replace(/'/g, "");

  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    if (comma > dot) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
  } else if (comma >= 0) {
    const decimalDigits = text.length - comma - 1;
    text = decimalDigits <= 2 ? text.replace(",", ".") : text.replace(/,/g, "");
  } else if ((text.match(/\./g) ?? []).length > 1) {
    const last = text.lastIndexOf(".");
    text = `${text.slice(0, last).replace(/\./g, "")}.${text.slice(last + 1)}`;
  }

  const amount = Number(text);
  if (!Number.isFinite(amount)) return 0;
  return negativeByParentheses ? -Math.abs(amount) : amount;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function directionFromAmount(amount: number): Direction {
  if (amount > 0) return "in";
  if (amount < 0) return "out";
  return "neutral";
}

function validDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

export type DateFormat = "auto" | "dmy" | "mdy" | "german-named";

const GERMAN_MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  januar: 1,
  feb: 2,
  february: 2,
  februar: 2,
  mar: 3,
  march: 3,
  marz: 3,
  mrz: 3,
  apr: 4,
  april: 4,
  mai: 5,
  may: 5,
  jun: 6,
  june: 6,
  juni: 6,
  jul: 7,
  july: 7,
  juli: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  okt: 10,
  october: 10,
  oktober: 10,
  nov: 11,
  november: 11,
  dez: 12,
  december: 12,
  dezember: 12,
};

function parseNumericDate(text: string, format: "dmy" | "mdy"): string | undefined {
  const match = text.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/);
  if (!match) return undefined;
  let year = Number(match[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return format === "dmy" ? validDate(year, second, first) : validDate(year, first, second);
}

function parseGermanNamedDate(text: string): string | undefined {
  const match = normalizeText(text).match(/^(\d{1,2})[.\-/\s]+([a-z]+)\.?[.\-/\s,]+(\d{2,4})/);
  if (!match) return undefined;
  let year = Number(match[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const month = GERMAN_MONTHS[match[2]];
  return month ? validDate(year, month, Number(match[1])) : undefined;
}

function parseEnglishNamedDate(text: string): string | undefined {
  const match = normalizeText(text).match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{2,4})/);
  if (!match) return undefined;
  let year = Number(match[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const month = GERMAN_MONTHS[match[1]];
  return month ? validDate(year, month, Number(match[2])) : undefined;
}

export function parseDate(value: unknown, format: DateFormat = "auto"): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value ?? "").trim();
  if (!text) return undefined;

  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  if (format === "mdy") return parseNumericDate(text, "mdy");
  if (format === "dmy") return parseNumericDate(text, "dmy");
  if (format === "german-named") return parseGermanNamedDate(text) ?? parseNumericDate(text, "dmy");

  const germanNamed = parseGermanNamedDate(text);
  if (germanNamed) return germanNamed;
  const englishNamed = parseEnglishNamedDate(text);
  if (englishNamed) return englishNamed;
  const numeric = parseNumericDate(text, "dmy");
  if (numeric) return numeric;

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

export function dateDifferenceDays(left?: string, right?: string): number | undefined {
  if (!left || !right) return undefined;
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return undefined;
  return Math.round(Math.abs(leftTime - rightTime) / 86_400_000);
}

export function makeId(...parts: unknown[]): string {
  const input = parts.map((part) => String(part ?? "")).join("|");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `r_${(hash >>> 0).toString(36)}`;
}

export function referenceTokens(...values: unknown[]): string[] {
  const ignored = new Set(["2025", "2026", "eur", "invoice", "rechnung", "payment", "bestellung"]);
  return Array.from(
    new Set(
      values
        .flatMap((value) => normalizeText(value).match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [])
        .map((token) => token.replace(/^#+/, ""))
        .filter((token) => token.length >= 4 && !ignored.has(token)),
    ),
  );
}

export function metadataValue(value: unknown): MetadataValue {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function formatMoney(value: number, currency = "EUR"): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(value);
}

export function formatDate(value?: string): string {
  if (!value) return "–";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

export function similarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeText(left).split(/\W+/).filter((token) => token.length > 2));
  const rightTokens = new Set(normalizeText(right).split(/\W+/).filter((token) => token.length > 2));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}
