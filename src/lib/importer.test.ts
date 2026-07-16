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

  it("recognizes the owner even when additional given names are present", async () => {
    const shopify = csvFile(
      "shop.csv",
      "Name,Financial Status,Paid at,Currency,Total,Created at,Billing Name,Shipping Name,Payment Method,Payment Reference,Vendor\n#1,paid,2025-05-02,EUR,67.43,2025-05-02,Niklas Maximilian Heinrich Horstmann,Niklas Maximilian Heinrich Horstmann,PayPal,P-1,Shop",
    );
    const fyrst = csvFile(
      "fyrst.csv",
      [
        "Buchungstag;Wert;Umsatzart;Begünstigter / Auftraggeber;Verwendungszweck;IBAN / Kontonummer;Betrag;Soll;Haben;Währung",
        "23.06.2025;23.06.2025;SEPA Überweisung;Niklas Maximilian Heinrich Horstmann;Privat;;-15;15;;EUR",
      ].join("\n"),
    );
    const [shopifyResult, fyrstResult] = await Promise.all([parseImportFile(shopify), parseImportFile(fyrst)]);
    expect(applyGlobalTestIdentities(shopifyResult.records, ["Niklas Horstmann"])[0]).toMatchObject({
      disposition: "test",
      dispositionReason: "Globale Testidentität",
    });
    expect(fyrstResult.records[0]).toMatchObject({
      disposition: "private",
      dispositionReason: "Privatentnahme des Inhabers",
    });
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

  it("warns when an Accountable invoice number is missing from the export", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Einkommenszahl", "Rechnung Type", "Status", "Rechnungsdatum", "Kundenname", "Gesamtbetrag", "Währung"],
        ["1906-2025-14", "invoice", "Bezahlt", "03.02.2025", "Iris", 28.34, "EUR"],
        ["1906-2025-15", "invoice", "Bezahlt", "03.02.2025", "Astrid", 26.86, "EUR"],
        ["1906-2025-17", "invoice", "Bezahlt", "06.02.2025", "Printler", 1260.39, "EUR"],
        ["1906-2025-18", "invoice", "Bezahlt", "06.02.2025", "Pierre", 29.62, "EUR"],
      ]),
      "Rechnungen",
    );
    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const result = await parseImportFile(new File([bytes], "accountable.xlsx"));
    expect(result.sources[0].warnings).toContain("Mögliche Lücken im Rechnungsnummernkreis 1906-2025-: 16.");
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

  it("imports Etsy Sold Orders with seller revenue excluding marketplace tax", async () => {
    const file = csvFile(
      "EtsySoldOrders2025 form.csv",
      [
        "Sale Date,Order ID,Buyer User ID,Full Name,Currency,Order Value,Discount Amount,Shipping Discount,Shipping,Sales Tax,Order Total,Card Processing Fees,Order Net,Adjusted Order Total,Adjusted Card Processing Fees,Adjusted Net Order Amount,Buyer,SKU",
        "12/30/25,3935119409,kj7,Andrew Dye,EUR,82.27,8.23,0.00,0.00,0.00,80.85,3.53,70.51,0.00,0.00,0.00,Andrew Dye,\"sku-a,sku-b\"",
      ].join("\n"),
    );
    const result = await parseImportFile(file);
    expect(result.sources[0]).toMatchObject({ kind: "etsy-sold-orders", shop: "Form" });
    expect(result.sources[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.records[0]).toMatchObject({
      category: "order-detail",
      reference: "3935119409",
      counterparty: "Andrew Dye",
      amount: 74.04,
      settlementAmount: 70.51,
      feeAmount: 3.53,
    });
    expect(result.records[0].metadata.marketplaceTax).toBe(6.81);
  });

  it("recognizes fully refunded Etsy orders from the sales export", async () => {
    const file = csvFile(
      "Etsy Payments-Verkäufe Frida 25.csv",
      [
        "Payment ID,Buyer Username,Buyer Name,Order ID,Gross Amount,Fees,Net Amount,Adjusted Gross,Adjusted Fees,Adjusted Net,Currency,Listing Amount,Listing Currency,VAT Amount,Status,Order Date,Buyer,Refund Amount",
        "P-1,user,Irene,3729984516,32.23,1.72,30.51,0,0,0,EUR,35.45,EUR,0,SETTLED,07/08/2025,Irene Kay,35.45",
      ].join("\n"),
    );
    const result = await parseImportFile(file);
    expect(result.records[0]).toMatchObject({
      disposition: "resolved",
      dispositionReason: "Vollständig über Etsy erstattet; keine Ausgangsrechnung erwartet",
    });
    expect(result.records[0].metadata).toMatchObject({ refundAmount: 35.45, fullyRefunded: true });
  });

  it("imports Etsy Buyer Fees and fee credits with their economic sign", async () => {
    const file = csvFile(
      "etsy_statement_2025_7 frida.csv",
      [
        "Datum,Art,Titel,Info,Währung,Betrag,Gebühren & Steuern,Netto,Steuerliche Angaben",
        "15. July 2025,Buyer Fee,Colorado Retail Delivery Fee (paid by buyer),Order #3743707041,EUR,--,-€0.23,-€0.23,--",
        "10. July 2025,Fee,Credit for processing fee,Order #3729984516,EUR,--,€1.72,€1.72,--",
        "10. July 2025,Tax,Refund to buyer for sales tax,Order #3729984516,EUR,--,€3.22,€3.22,--",
      ].join("\n"),
    );
    const result = await parseImportFile(file);
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "buyer-fee", direction: "out", amount: 0.23 }),
      expect.objectContaining({ category: "fee", direction: "in", amount: 1.72 }),
      expect.objectContaining({ category: "fee", direction: "in", amount: 3.22, metadata: expect.objectContaining({ marketplaceTax: true }) }),
    ]));
  });

  it("maps the known Etsy account aliases to their canonical shops", async () => {
    const base = [
      "Payment ID,Buyer Username,Buyer Name,Order ID,Gross Amount,Fees,Net Amount,Currency,Listing Amount,Listing Currency,VAT Amount,Status,Order Date,Buyer,Refund Amount",
      "P-1,user,First,1234567890,32.55,1.72,30.83,EUR,35.58,EUR,0,SETTLED,02/01/2025,Full Buyer,0",
    ].join("\n");
    const [frida, form] = await Promise.all([
      parseImportFile(csvFile("FantasiasFloralesCo payments.csv", base)),
      parseImportFile(csvFile("FormAndFunctionDE payments.csv", base)),
    ]);
    expect(frida.sources[0].shop).toBe("Frida");
    expect(form.sources[0].shop).toBe("Form");
  });

  it("keeps Gelato refunds and PayPal balances as account movements", async () => {
    const gelato = csvFile(
      "gelato.csv",
      "Date,Reference ID,Product Charge,Shipping Charge,VAT Charge,Total Charge,Currency\n2025-12-11,G-1,73.39,10.10,0,-83.49,EUR",
    );
    const paypal = csvFile(
      "paypal.csv",
      "Datum,Beschreibung,Währung,Brutto,Entgelt,Netto,Guthaben,Transaktionscode,Zugehöriger Transaktionscode\n11.12.2025,Sammelzahlung,EUR,100,0,100,100,P-1,",
    );
    const [gelatoResult, paypalResult] = await Promise.all([parseImportFile(gelato), parseImportFile(paypal)]);
    expect(gelatoResult.records[0]).toMatchObject({ category: "refund", direction: "in", amount: 83.49 });
    expect(paypalResult.records[0].metadata.balance).toBe(100);
  });

  it("separates private owner withdrawals from the confirmed FYRST to N26 transfer", async () => {
    const file = csvFile(
      "fyrst.csv",
      [
        "Buchungstag;Wert;Umsatzart;Begünstigter / Auftraggeber;Verwendungszweck;IBAN / Kontonummer;Betrag;Soll;Haben;Währung",
        "06.10.2025;06.10.2025;SEPA Überweisung;Niklas Horstmann;Werbung;DE31100110012511694946;-200;200;;EUR",
        "20.10.2025;20.10.2025;SEPA Überweisung;Niklas Horstmann;;DE42120300001062505464;-1200;1200;;EUR",
      ].join("\n"),
    );
    const result = await parseImportFile(file);
    expect(result.records[0]).toMatchObject({ disposition: "active", dispositionReason: "Interne Überweisung FYRST → N26" });
    expect(result.records[1]).toMatchObject({ disposition: "private", dispositionReason: "Privatentnahme des Inhabers" });
  });

  it("imports eBay fees, refund corrections and bank-funded debits with their economic sign", async () => {
    const file = csvFile(
      "ebay-ledger.csv",
      [
        "Datum der Transaktionserstellung;Typ;Bestellnummer;Auszahlung Nr.;Betrag abzÃ¼gl. Kosten;Transaktionsbetrag (inkl. Kosten);Fixer Anteil der Verkaufsprovision;Variabler Anteil der Verkaufsprovision;Beschreibung",
        "01.10.2025;Bestellung;11-11111-11111;P-1;85,00;100,00;-5,00;-10,00;Bestellung",
        "02.10.2025;Rückerstattung;11-11111-11111;P-2;-17,00;-20,00;1,00;2,00;Rückerstattung",
        "03.10.2025;Andere Gebühr;11-11111-11111;P-2;-2,00;-2,00;0;0;Gebühr",
        "04.10.2025;Andere Gebühr;11-11111-11111;P-2;2,00;2,00;0;0;Gebührenkorrektur",
        "05.10.2025;Belastung;;P-2;20,00;20,00;0;0;Belastung für Rückerstattungskosten",
      ].join("\n"),
    );
    const result = await parseImportFile(file);
    expect(result.sources[0].kind).toBe("ebay-ledger");
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "sale", direction: "in", feeAmount: 15 }),
      expect.objectContaining({ category: "refund", direction: "out", feeAmount: -3 }),
      expect.objectContaining({ category: "fee", direction: "out", amount: 2 }),
      expect.objectContaining({ category: "fee", direction: "in", amount: 2 }),
      expect.objectContaining({ category: "transfer", direction: "in", amount: 20 }),
    ]));
  });
});
