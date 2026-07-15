import type { BuchrecProject, MatchLink, NormalizedRecord, ParsedFileResult, SourceImport } from "../types";
import { runMatching } from "./matching";

export function createProject(): BuchrecProject {
  const now = new Date().toISOString();
  return {
    version: 1,
    name: "Buchhaltung 2025",
    createdAt: now,
    updatedAt: now,
    settings: {
      year: new Date().getFullYear() - 1,
      dateToleranceDays: 20,
      amountTolerance: 0.02,
      shopifyRules: [],
    },
    sources: [],
    records: [],
    links: [],
    candidates: [],
  };
}

export function mergeParsedFiles(
  project: BuchrecProject,
  parsed: ParsedFileResult[],
): Pick<BuchrecProject, "sources" | "records"> {
  const incomingSources = parsed.flatMap((result) => result.sources);
  const incomingRecords = parsed.flatMap((result) => result.records);
  const incomingSourceIds = new Set(incomingSources.map((source) => source.id));
  const sources = [
    ...project.sources.filter((source) => !incomingSourceIds.has(source.id)),
    ...incomingSources,
  ];
  const records = [
    ...project.records.filter((record) => !incomingSourceIds.has(record.sourceId)),
    ...incomingRecords,
  ];
  return { sources, records };
}

export function preserveUserLinks(automatic: MatchLink[], previous: MatchLink[]): MatchLink[] {
  const decisions = previous.filter((link) => !link.automatic || link.rejected);
  const rejectedPairs = new Set(
    decisions
      .filter((link) => link.rejected)
      .map((link) => [link.fromId, link.toId, link.type].sort().join("|")),
  );
  const acceptedPairs = new Set(
    decisions
      .filter((link) => !link.rejected)
      .map((link) => [link.fromId, link.toId, link.type].sort().join("|")),
  );
  return [
    ...decisions,
    ...automatic.filter((link) => {
      const key = [link.fromId, link.toId, link.type].sort().join("|");
      return !rejectedPairs.has(key) && !acceptedPairs.has(key);
    }),
  ];
}

export function updateSourceShop(
  sources: SourceImport[],
  records: NormalizedRecord[],
  sourceId: string,
  shop: string,
): { sources: SourceImport[]; records: NormalizedRecord[] } {
  return {
    sources: sources.map((source) => (source.id === sourceId ? { ...source, shop } : source)),
    records: records.map((record) => (record.sourceId === sourceId ? { ...record, shop } : record)),
  };
}

export function synchronousMatch(project: BuchrecProject, records = project.records): BuchrecProject {
  const matching = runMatching(records, project.settings.dateToleranceDays, project.settings.amountTolerance);
  return {
    ...project,
    records,
    links: preserveUserLinks(matching.links, project.links),
    candidates: matching.candidates,
    updatedAt: new Date().toISOString(),
  };
}
