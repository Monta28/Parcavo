'use client';

const SIGNATURE_BOXES = [
  { moment: 'À la remise', who: 'Le conducteur' },
  { moment: 'À la remise', who: 'Pour le parc (remettant)' },
  { moment: 'À la restitution', who: 'Le conducteur' },
  { moment: 'À la restitution', who: 'Pour le parc (réceptionnaire)' },
] as const;

/** Cadres de signature laissés vides, à compléter à la main sur la fiche imprimée. */
export function UsageSheetHandSignatures() {
  return (
    <section aria-labelledby="sheet-signatures" className="space-y-3 border-t pt-4">
      <h2 id="sheet-signatures" className="text-base font-semibold">
        Signatures manuscrites
      </h2>
      <p className="text-xs text-muted-foreground">À compléter à la main sur la fiche imprimée.</p>
      <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
        {SIGNATURE_BOXES.map((box) => (
          <div key={`${box.moment}-${box.who}`} className="space-y-3 rounded-md border p-3 print:break-inside-avoid">
            <p className="font-medium">
              {box.moment} — {box.who}
            </p>
            <p className="flex items-end gap-2">
              <span className="text-muted-foreground">Nom :</span>
              <span className="h-5 flex-1 border-b border-dashed" aria-hidden="true" />
            </p>
            <p className="flex items-end gap-2">
              <span className="text-muted-foreground">Date :</span>
              <span className="h-5 flex-1 border-b border-dashed" aria-hidden="true" />
            </p>
            <p className="text-muted-foreground">Signature :</p>
            <div className="h-16" aria-hidden="true" />
          </div>
        ))}
      </div>
    </section>
  );
}
