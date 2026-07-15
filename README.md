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

1. Alle Exporte gemeinsam importieren.
2. Erkannte Quellen, Zeiträume und Warnungen kontrollieren.
3. Unter „Regeln“ die echten Shopify-Kunden markieren. 0-Euro-Bestellungen bleiben automatisch Tests.
4. Sichere automatische Zuordnungen und Vorschläge prüfen.
5. Offene Fälle manuell verbinden oder als geklärt, Test beziehungsweise privat klassifizieren.
6. Den Excel-Prüfbericht und optional eine lokale Projektdatei exportieren.

Das Matching berücksichtigt unter anderem Referenzen, Beträge, Gegenparteien, Richtung, konfigurierbare Datumsabstände, Plattformauszahlungen, PayPal-Gegenläufe und Printful-Geldbörsenaufladungen. Jede Zuordnung enthält Regel, Sicherheit, Betragsdifferenz und Datumsabstand.

## Lokal entwickeln und prüfen

Voraussetzung: Node.js 22.12 oder neuer und pnpm 11.

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
