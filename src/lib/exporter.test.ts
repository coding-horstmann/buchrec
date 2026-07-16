import { strFromU8, unzipSync } from "fflate";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { buildAuditPackage } from "./exporter";

describe("audit package", () => {
  it("contains PDF, workbook, manifest, project and procedure documentation", async () => {
    const project = createDemoProject();
    project.decisions.push({
      id: "decision-demo",
      kind: "record-review",
      recordIds: ["expense-demo"],
      status: "manual-cleared",
      note: "Privater Zahlungsweg nachvollziehbar dokumentiert.",
      createdAt: "2025-12-31T12:00:00.000Z",
    });
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
      "Entscheidungen",
      "Dateiprüfsummen",
      "Verfahrensdoku",
      "Ausnahmen",
    ]));
    const decisions = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets["Entscheidungen"]);
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Art: "Bewertung",
        Anmerkung: "Privater Zahlungsweg nachvollziehbar dokumentiert.",
      }),
    ]));
    const exportedProject = JSON.parse(strFromU8(archive["projekt.json"])) as { decisions: Array<{ note: string }> };
    expect(exportedProject.decisions[0]?.note).toBe("Privater Zahlungsweg nachvollziehbar dokumentiert.");
    expect(strFromU8(archive["VERFAHRENSDOKUMENTATION.txt"])).toContain("Original-CSV-/Excel-Dateien");
    expect(strFromU8(archive["pruefbericht.pdf"].slice(0, 4))).toBe("%PDF");
  });
});
