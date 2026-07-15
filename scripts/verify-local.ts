import { File } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseImportFile } from "../src/lib/importer";
import { coverageSummary, runMatching } from "../src/lib/matching";
import type { NormalizedRecord, SourceImport, SourceKind } from "../src/types";

async function filesIn(input: string): Promise<string[]> {
  const stat = await fs.stat(input);
  if (stat.isFile()) return [input];
  const entries = await fs.readdir(input, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => filesIn(path.join(input, entry.name))),
  );
  return nested.flat();
}

async function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) throw new Error("Mindestens einen Datei- oder Ordnerpfad angeben.");
  const paths = (await Promise.all(inputs.map(filesIn)))
    .flat()
    .filter((entry) => /\.(csv|xlsx|xls)$/i.test(entry));
  const sources: SourceImport[] = [];
  const records: NormalizedRecord[] = [];

  for (const filePath of paths) {
    const bytes = await fs.readFile(filePath);
    const file = new File([bytes], path.basename(filePath));
    const parsed = await parseImportFile(file as unknown as globalThis.File);
    sources.push(...parsed.sources);
    records.push(...parsed.records);
  }

  const countsByKind = Object.fromEntries(
    [...new Set(sources.map((source) => source.kind))]
      .sort()
      .map((kind) => [
        kind,
        {
          sources: sources.filter((source) => source.kind === kind).length,
          records: records.filter((record) => record.sourceKind === kind).length,
        },
      ]),
  ) as Partial<Record<SourceKind, { sources: number; records: number }>>;
  const matching = runMatching(records, 20);
  const output = {
    files: paths.length,
    sources: sources.length,
    records: records.length,
    countsByKind,
    unknownSources: sources.filter((source) => source.kind === "unknown").length,
    warningCount: sources.reduce((sum, source) => sum + source.warnings.length, 0),
    automaticLinks: matching.links.length,
    candidates: matching.candidates.length,
    coverage: coverageSummary(records, matching.links),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
