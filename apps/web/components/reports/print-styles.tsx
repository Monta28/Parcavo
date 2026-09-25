/**
 * Styles d'impression des fiches (CDC 11.2 : « imprimables en PDF via l'impression du navigateur ») : page A4,
 * texte noir, tableaux sans défilement horizontal, lignes et blocs non coupés. La navigation et les boutons
 * portent la classe no-print (masquée à l'impression par globals.css).
 */
export function PrintSheetStyles({ scope }: { scope: string }) {
  return (
    <style>{`@media print {
  @page { size: A4; margin: 12mm; }
  .${scope} { font-size: 9.5pt; color: #000; }
  .${scope} [data-slot='table-container'] { overflow: visible; }
  .${scope} table { font-size: 8.5pt; }
  .${scope} th, .${scope} td { padding: 2px 4px; }
  .${scope} tr, .${scope} dl > div, .${scope} .sheet-block { break-inside: avoid; }
  .${scope} h2, .${scope} h3 { break-after: avoid; }
}`}</style>
  );
}
