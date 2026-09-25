'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { vehicleQrLink } from '@/lib/qr-link';

/** QR interne (CDC 10.3) : lien opaque vers la fiche, valable seulement après authentification. */
export function QrPanel({ vehicleId, qrToken, canRegenerate }: { vehicleId: string; qrToken: string; canRegenerate: boolean }) {
  const queryClient = useQueryClient();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const link = vehicleQrLink(typeof window !== 'undefined' ? window.location.origin : '', qrToken);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(link, { margin: 1, width: 220 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => setDataUrl(null));
    return () => {
      cancelled = true;
    };
  }, [link]);
  const regenerate = useMutation({
    mutationFn: () => api(`/vehicles/${vehicleId}/qr/regenerate`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('QR code régénéré ; l’ancien n’ouvre plus la fiche.');
      void queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId] });
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Régénération impossible.'),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">QR code interne</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUrl} alt="QR code d’accès à la fiche véhicule" width={220} height={220} className="rounded-md border bg-white p-2" />
        ) : (
          <p className="text-muted-foreground">Génération du QR code…</p>
        )}
        <p className="text-muted-foreground">Ce code contient uniquement un identifiant opaque. Il ouvre la fiche après connexion et selon les permissions ; il n’affecte aucun conducteur.</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => window.print()}>
            Imprimer
          </Button>
          {canRegenerate ? (
            <Button type="button" variant="outline" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>
              Régénérer
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
