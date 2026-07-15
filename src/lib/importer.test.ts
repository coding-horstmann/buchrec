import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { applyGlobalTestIdentities, applyShopifyAllowList, parseImportFile } from "./importer";

function csvFile(name: string, content: string): File {
  return new File([content], name, { type: "text/csv" });
}

describe("file importer", () => {
  it("finds the FYRST header after metadata lines", async () => {
    const file = csvFile(
      "konto.csv",
      [
        "Kontoinhaber;Beispiel GmbH",
        "Zeitraum;2025",
        "",
        "Buchungstag;Wert;Umsatzart;Begünstigter / Auftraggeber;Verwendungszweck;Betrag;Soll;Haben;Währung",
        "10.01.2025;10.01.2025;SEPA Überweisung;Finanzamt;Umsatzsteuer;248,53;248,53;;EUR",
      ].join("\n"),
    );
    const result = await parseImportFile(file);
    expect(result.sources[0].kind).toBe("bank-fyrst");
    expect(result.sources[0].headerRow).toBe(4);
    expect(result.records[0]).toMatchObject({ direction: "out", amount: 248.53, counterparty: "Finanzamt" });
  });

  it("imports N26 and ignores DKB by policy", async () => {
    const n26 = csvFile(
      "werbung.csv",
      "Booking Date,Value Date,Partner Name,Partner Iban,Type,Payment Reference,Account Name,Amount (EUR),Original Amount,Original Currency,Exchange Rate\n2025-01-10,2025-01-10,Google,DE00,Card,Ads,N26,-40.00,40.00,EUR,1",
    );
    const dkb = csvFile(
      "privat.csv",
      "Buchungsdatum;Wertstellung;Status;Zahlungspflichtige*r;Zahlungsempfänger*in;Verwendungszweck;Umsatztyp;IBAN;Betrag (€)\n02.01.2025;02.01.2025;Gebucht;A;B;Privat;Lastschrift;DE00;-20,00",
    );
    const [n26Result, dkbResult] = await Promise.all([parseImportFile(n26), parseImportFile(dkb)]);
    expect(n26Result.sources[0].kind).toBe("bank-n26");
    expect(n26Result.records[0].amount).toBe(40);
    expect(dkbResult.sources[0]).toMatchObject({ kind: "bank-dkb-ignored", ignored: true });
    expect(dkbResult.records).toHaveLength(0);
  });

  it("groups Shopify line items and supports a user allow-list", async () => {
    const file = csvFile(
      "neuer-shop bestellungen.csv",
      [
        "Name,Financial Status,Paid at,Currency,Total,Created at,Billing Name,Shipping Name,Payment Method,Payment Reference,Vendor",
        "#1001,paid,2025-05-02,EUR,39.90,2025-05-02,Echte Person,Echte Person,PayPal,P-1,Neuer Shop",
        "#1001,,,,,,,Echte Person,,,Neuer Shop",
        "#1002,paid,,EUR,0.00,2025-05-03,Test Person,Test Person,,,Neuer Shop",
        "#1003,paid,2025-05-04,EUR,50.00,2025-05-04,Noch Test,Noch Test,PayPal,P-3,Neuer Shop",
      ].join("\n"),
    );
    const result = await parseImportFile(file);
    expect(result.sources[0].kind).toBe("shopify-orders");
    expect(result.sources[0].shop).toBe("Neuer Shop");
    expect(result.records).toHaveLength(3);
    expect(result.records.find((record) => record.reference === "#1002")?.disposition).toBe("test");
    const classified = applyShopifyAllowList(result.records, result.sources[0].shop!, ["Echte Person"]);
    expect(classified.find((record) => record.reference === "#1001")?.disposition).toBe("active");
    expect(classified.find((record) => record.reference === "#1003")?.disposition).toBe("test");
  });

  it("applies editable test identities across Shopify shops", async () => {
    const file = csvFile(
      "shop.csv",
      "Name,Financial Status,Paid at,Currency,Total,Created at,Billing Name,Shipping Name,Payment Method,Payment Reference,Vendor\n#1,paid,2025-05-02,EUR,67.43,2025-05-02,Niklas Horstmann,Niklas Horstmann,PayPal,P-1,Shop",
    );
    const result = await parseImportFile(file);
    const classified = applyGlobalTestIdentities(result.records, ["Niklas Horstmann"]);
    expect(classified[0]).toMatchObject({ disposition: "test", dispositionReason: "Globale Testidentität" });
    expect(applyGlobalTestIdentities(classified, [])[0]).toMatchObject({ disposition: "active", dispositionReason: undefined });
  });

  it("imports both relevant Accountable sheets", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Buchungsdatum", "Name Des Lieferanten", "Gesamtbetrag", "Währung", "Codebeschreibung", "Dokument Vorhanden"],
        ["10.01.2025", "Finanzamt", 248.53, "EUR", "Umsatzsteuer-Zahlungen", "Nein"],
      ]),
      "Ausgaben",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Einkommenszahl", "Rechnung Type", "Status", "Rechnungsdatum", "Kundenname", "Gesamtbetrag", "Währung"],
        ["R-1", "invoice", "Bezahlt", "02.01.2025", "Kunde", 39.9, "EUR"],
        ["R-1", "invoice", "Bezahlt", "02.01.2025", "Kunde", 10.1, "EUR"],
      ]),
      "Rechnungen",
    );
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Kundenname"], ["Kunde"]]), "Kunden");
    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const result = await parseImportFile(new File([bytes], "accountable.xlsx"));
    expect(result.sources.map((source) => source.kind)).toEqual(["accountable-expenses", "accountable-invoices"]);
    expect(result.records.map((record) => record.category)).toEqual(["tax-payment", "document-income"]);
    expect(result.records[1]).toMatchObject({ reference: "R-1", amount: 50 });
    expect(result.records[1].metadata.lineCount).toBe(2);
  });

  it("uses source-specific Etsy and eBay date formats", async () => {
    const etsy = csvFile(
      "etsy-sales.csv",
      [
        "Payment ID,Buyer Username,Buyer Name,Order ID,Gross Amount,Fees,Net Amount,Currency,Listing Amount,Listing Currency,VAT Amount,Status,Order Date,Buyer,Refund Amount",
        "P-1,user,First,1234567890,32.55,1.72,30.83,EUR,35.58,EUR,0,SETTLED,02/01/2025,Full Buyer,0",
      ].join("\n"),
    );
    const ebay = csvFile(
      "ebay-orders.csv",
      [
        "Verkaufsprotokollnummer;Bestellnummer;Gesamtbetrag;Verkauft am;Zahlungsdatum;Nutzername des Käufers;Name des Käufers",
        "1;23-12345-12345;116,99 €;10-Dez-25;10-Dez-25;buyer;--",
      ].join("\n"),
    );
    const [etsyResult, ebayResult] = await Promise.all([parseImportFile(etsy), parseImportFile(ebay)]);
    expect(etsyResult.records[0]).toMatchObject({ date: "2025-02-01", counterparty: "Full Buyer", amount: 32.55 });
    expect(ebayResult.records[0]).toMatchObject({ date: "2025-12-10", amount: 116.99 });
  });
});
