# buchrec

Browserbasierter, nachvollziehbarer Zahlungsabgleich für Accountable-Exporte, Zahlungswege und Verkaufsplattformen. Die Anwendung ordnet Belege, Bestellungen, Plattformabrechnungen, Auszahlungen und tatsächliche Geldbewegungen einander zu und stellt verbleibende Ausnahmen zur manuellen Prüfung bereit.

## Datenschutzmodell

- CSV- und Excel-Dateien werden ausschließlich im Browser gelesen.
- Der Projektstand liegt in IndexedDB des verwendeten Browsers.
- Es gibt keine Upload- oder Finanzdaten-API auf dem Server.
- Railway liefert nur die statischen Anwendungsdateien aus.
- Der Produktionsserver ist per HTTP Basic Auth geschützt und setzt eine restriktive Content Security Policy.
- Finanz-, Projekt- und Umgebungsdateien sind durch `.gitignore` vom Repository ausgeschlossen.

Beim Löschen über das Papierkorb-Symbol wird der lokale Projektstand dieses Browsers entfernt. Für ein Backup kann vorher eine `*.buchrec.json`-Projektdatei exportiert werden.

## Unterstützte Strukturen

- Accountable: Ausgaben und Ausgangsrechnungen aus einer Excel-Arbeitsmappe
- Banken: FYRST und N26
- Business-PayPal
- Etsy: Verkäufe, Überweisungen und monatliche Abrechnungen; beliebig viele Shops
- eBay: Bestellungen und Abrechnungsübersicht
- Shopify: Bestellungen und Gebührentabellen; beliebig viele Shops
- Printful: Bestellungen und Geldbörse
- Gelato: Kontoauszug

Die Erkennung orientiert sich an Spalten und Datenstruktur, nicht ausschließlich am Dateinamen. Erkannte Shopnamen können in der Oberfläche korrigiert werden. DKB-Exporte werden bewusst erkannt und als ausgeschlossen markiert.

## Arbeitsablauf

1. Dateien in beliebig vielen Schritten zur Upload-Liste hinzufügen und erst mit „Prüfen“ einlesen. Identische Dateien werden anhand ihrer SHA-256-Prüfsumme ignoriert.
2. Erkannte Quellen, Zeiträume und Warnungen kontrollieren.
3. Unter „Regeln“ globale Testidentitäten pflegen und bei Bedarf je Shopify-Shop echte Kunden markieren. 0-Euro-Bestellungen bleiben automatisch Tests.
4. Sichere automatische Zuordnungen im „Einzelabgleich“ und echte Sammelvorgänge unter „Plattformabrechnungen“ prüfen.
5. Offene Fälle manuell verbinden oder mit „manuell geklärt“, „offen mit Anmerkung“, „Warnung“ beziehungsweise „Datenfehler“ bewerten.
6. PDF, Excel-Prüfbericht, ZIP-Prüfpaket und optional eine lokale Projektdatei exportieren.

Das Matching berücksichtigt unter anderem Referenzen, Beträge, Gegenparteien, Richtung, angegebene Zahlungsdaten, konfigurierbare Datumsabstände, Plattformauszahlungen, PayPal-Gegenläufe, Fremdwährungsumrechnungen und Printful-Geldbörsenaufladungen. PayPal- und Bankbewegungen werden nicht doppelt als Zahlung gezählt.

Die Prüfung unterscheidet drei Nachweise: Beleg beziehungsweise Bestellung, Zahlung und Kontenabstimmung. PayPal wird als eigenes Zwischenkonto pro Währung über den laufenden Guthabenstand abgestimmt. Eine aus PayPal-Guthaben bezahlte Ausgabe benötigt daher keine identische Bankabbuchung. Sammelabbuchungen bleiben als aufklappbare Gruppen mit allen enthaltenen Bewegungen erhalten.

Bei Etsy werden Verkäuferumsatz, von Etsy abgeführte Marketplace Sales Tax, Gebühren und Auszahlung getrennt geführt. Die vom Käufer zusätzlich gezahlte und von Etsy abgeführte Sales Tax erhöht nicht den mit Accountable abzugleichenden Rechnungsumsatz. Sammelauszahlungen werden nur dann automatisch verbunden, wenn ein einzelnes oder kombiniertes Auszahlungsfenster centgenau aufgeht.

Unter „Plattformabrechnungen“ zeigt buchrec für Etsy Form, Etsy Frida und eBay jeweils getrennt den Belegabgleich, das Plattformkonto und den Zahlungsnachweis. Jahresenddifferenzen werden als „Differenz / Übertrag“ ausgewiesen. Gelato, Printful, Printler, Art Heroes, Redbubble, Europosters, Albin Michel, Google und Shopify stehen getrennt im „Einzelabgleich“. Das lokale Prüfpaket enthält den aktuellen PDF- und Excel-Prüfbericht, Projektstand, Verfahrensbeschreibung und SHA-256-Prüfsummen der Originalimporte.

Jede Zuordnung enthält Regel, Sicherheit, Betragsdifferenz und Datumsabstand. Teilzuordnungen bleiben in den Ausnahmen sichtbar, bis das Bankende der Kette nachgewiesen ist.

## Lokal entwickeln und prüfen

Voraussetzung: Node.js 22.13 oder neuer und pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm check
```

Ein lokaler, anonymisierter Strukturcheck gegen einen nicht eingecheckten Datenordner ist möglich mit:

```bash
pnpm verify:local "C:\\Pfad\\zu\\CSV"
```

Der Befehl gibt nur Anzahlen, erkannte Quelltypen, Warnungen und Abdeckungswerte aus.

## Railway

Der Build und Start sind in `railway.toml` definiert. In Railway müssen mindestens diese Variablen gesetzt werden:

```text
NODE_ENV=production
APP_USERNAME=<benutzername>
APP_PASSWORD=<langes-zufälliges-passwort>
```

`PORT` wird von Railway bereitgestellt. Der öffentliche Healthcheck `/health` bestätigt zusätzlich mit `storage: browser-only`, dass der Dienst keine Finanzdatenhaltung betreibt.

## Einordnung des Ergebnisses

Ein technisch als „geklärt“ markierter Datensatz ist nachvollziehbar zugeordnet oder bewusst klassifiziert. Das ist eine belastbare Arbeits- und Prüfgrundlage, aber keine Garantie für steuerliche Vollständigkeit und kein Ersatz für die abschließende Beurteilung durch einen Steuerberater. Insbesondere Jahresrandbuchungen und fehlende Zahlungswege können nur mit den jeweils bereitgestellten Daten beurteilt werden.
