import type { BuchrecProject, DecisionAudit, EtsyShopAlias, MatchCandidate, MatchLink, NormalizedRecord, ParsedFileResult, SourceImport } from "../types";
import { runMatching } from "./matching";
import { normalizeText } from "./normalize";

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
      testIdentities: ["Niklas Horstmann", "Nik Horstmann", "Niklas Test", "niklas dgfdg", "dsfdsf dsfdsf"],
      shopifyRules: [],
      etsyShopAliases: [
        { shop: "Frida", aliases: ["Frida", "FantasiasFloralesCo"] },
        { shop: "Form", aliases: ["Form", "FormAndFunctionDE"] },
      ],
    },
    sources: [],
    records: [],
    links: [],
    candidates: [],
    reviews: [],
    decisions: [],
  };
}

function sourceContentKey(source: SourceImport): string {
  return [
    source.contentHash ?? "",
    source.kind,
    source.sheetName ?? "",
  ].join("|");
}

function sourceSlotKey(source: SourceImport): string {
  return [
    source.fileName.toLocaleLowerCase("de-DE"),
    source.kind,
    source.sheetName ?? "",
  ].join("|");
}

export function mergeParsedFiles(
  project: BuchrecProject,
  parsed: ParsedFileResult[],
): Pick<BuchrecProject, "sources" | "records"> {
  const existingContent = new Set(project.sources.map(sourceContentKey));
  const acceptedContent = new Set<string>();
  const incomingSources = parsed
    .flatMap((result) => result.sources)
    .filter((source) => {
      const key = sourceContentKey(source);
      if (source.contentHash && (existingContent.has(key) || acceptedContent.has(key))) return false;
      acceptedContent.add(key);
      return true;
    });
  const acceptedSourceIds = new Set(incomingSources.map((source) => source.id));
  const incomingRecords = [
    ...new Map(
      parsed
        .flatMap((result) => result.records)
        .filter((record) => acceptedSourceIds.has(record.sourceId))
        .map((record) => [record.id, record]),
    ).values(),
  ];
  const incomingSourceIds = new Set(incomingSources.map((source) => source.id));
  const incomingSlots = new Set(incomingSources.map(sourceSlotKey));
  const replacedSourceIds = new Set(
    project.sources
      .filter((source) => incomingSlots.has(sourceSlotKey(source)))
      .map((source) => source.id),
  );
  const sources = [
    ...project.sources.filter((source) => !incomingSourceIds.has(source.id) && !replacedSourceIds.has(source.id)),
    ...incomingSources,
  ];
  const records = [
    ...project.records.filter((record) => !incomingSourceIds.has(record.sourceId) && !replacedSourceIds.has(record.sourceId)),
    ...incomingRecords,
  ];
  return { sources, records };
}

export function upgradeProject(project: BuchrecProject): BuchrecProject {
  const defaults = createProject();
  const testIdentities = [...new Set([
    ...defaults.settings.testIdentities,
    ...(project.settings?.testIdentities ?? []),
  ])];
  const decisions: DecisionAudit[] = project.decisions ?? [
    ...(project.reviews ?? [])
      .filter((review) => !review.automatic)
      .map((review) => ({
        id: `legacy-review-${review.id}`,
        kind: "record-review" as const,
        recordIds: [review.recordId],
        status: review.status,
        note: review.note,
        createdAt: review.createdAt,
      })),
    ...(project.links ?? [])
      .filter((link) => !link.automatic)
      .map((link) => ({
        id: `legacy-link-${link.id}`,
        kind: (link.rejected ? "link-rejected" : link.type === "manual" ? "manual-link" : "link-accepted") as DecisionAudit["kind"],
        recordIds: [link.fromId, link.toId],
        linkId: link.id,
        note: link.reason || (link.rejected ? "Vorschlag abgelehnt" : "Zuordnung bestätigt"),
        createdAt: project.updatedAt || project.createdAt,
      })),
  ];
  return {
    ...project,
    settings: {
      ...defaults.settings,
      ...project.settings,
      testIdentities,
      shopifyRules: project.settings?.shopifyRules ?? [],
      etsyShopAliases: project.settings?.etsyShopAliases ?? defaults.settings.etsyShopAliases,
    },
    reviews: project.reviews ?? [],
    decisions,
    candidates: project.candidates ?? [],
    links: project.links ?? [],
  };
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

export function filterCandidatesAgainstDecisions(
  candidates: MatchCandidate[],
  links: MatchLink[],
): MatchCandidate[] {
  const accepted = links.filter((link) => !link.automatic && !link.rejected);
  const rejectedKeys = new Set(
    links.filter((link) => link.rejected).map((link) => [...[link.fromId, link.toId].sort(), link.type].join("|")),
  );
  return candidates.filter((candidate) => {
    const key = [...[candidate.fromId, candidate.toId].sort(), candidate.type].join("|");
    if (rejectedKeys.has(key)) return false;
    if (accepted.some((link) => [...[link.fromId, link.toId].sort(), link.type].join("|") === key)) return false;
    if (candidate.type !== "document-order" && candidate.type !== "document-payment") return true;
    return !accepted.some((link) =>
      link.type === candidate.type &&
      (
        link.fromId === candidate.fromId ||
        link.fromId === candidate.toId ||
        link.toId === candidate.fromId ||
        link.toId === candidate.toId
      ),
    );
  });
}

export function updateSourceShop(
  sources: SourceImport[],
  records: NormalizedRecord[],
  sourceId: string,
  shop: string,
): { sources: SourceImport[]; records: NormalizedRecord[] } {
  const unresolved = !shop.trim() || normalizeText(shop).includes("bitte zuordnen");
  const assignmentWarning = "Shop konnte nicht eindeutig aus dem Dateiinhalt erkannt werden und muss zugeordnet werden.";
  return {
    sources: sources.map((source) => (source.id === sourceId ? {
      ...source,
      shop,
      warnings: unresolved
        ? [...new Set([...source.warnings, assignmentWarning])]
        : source.warnings.filter((warning) => warning !== assignmentWarning),
    } : source)),
    records: records.map((record) => (record.sourceId === sourceId ? { ...record, shop } : record)),
  };
}

export function canonicalEtsyShop(shop: string, aliases: EtsyShopAlias[]): string {
  const normalized = normalizeText(shop);
  return aliases.find((rule) => rule.aliases.some((alias) => normalizeText(alias) === normalized))?.shop ?? shop;
}

export function synchronousMatch(project: BuchrecProject, records = project.records): BuchrecProject {
  const matching = runMatching(records, project.settings.dateToleranceDays, project.settings.amountTolerance);
  return {
    ...project,
    records,
    links: preserveUserLinks(matching.links, project.links),
    candidates: matching.candidates,
    reviews: [
      ...(project.reviews ?? []).filter((review) => !review.automatic),
      ...matching.reviews,
    ],
    updatedAt: new Date().toISOString(),
  };
}
