import { strFromU8, unzipSync } from "fflate";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { buildAuditPackage } from "./exporter";

describe("audit package", () => {
  it("contains PDF, workbook, manifest, project and procedure documentation", async () => {
    const project = createDemoProject();
    const archive = unzipSync(await buildAuditPackage(project));

    expect(Object.keys(archive).sort()).toEqual([
      "VERFAHRENSDOKUMENTATION.txt",
      "manifest.json",
      "projekt.json",
      "pruefbericht.pdf",
      "pruefbericht.xlsx",
    ]);

    const manifest = JSON.parse(strFromU8(archive["manifest.json"])) as {
      format: string;
      year: number;
      browserOnly: boolean;
    };
    expect(manifest).toMatchObject({
      format: "buchrec-audit-package",
      year: 2025,
      browserOnly: true,
    });

    const workbook = XLSX.read(archive["pruefbericht.xlsx"], { type: "array" });
    expect(workbook.SheetNames).toEqual(expect.arrayContaining([
      "Übersicht",
      "Statusachsen",
      "Kontenabgleich",
      "Sammelgruppen",
      "Dateiprüfsummen",
      "Verfahrensdoku",
      "Ausnahmen",
    ]));
    expect(strFromU8(archive["VERFAHRENSDOKUMENTATION.txt"])).toContain("Original-CSV-/Excel-Dateien");
    expect(strFromU8(archive["pruefbericht.pdf"].slice(0, 4))).toBe("%PDF");
  });
});
