'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useSession } from '@/components/layout/session-context';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, toQuery } from '@/lib/api-client';
import { type AssignmentView, assignmentState, RESPONSIBLE_REMINDER } from '@/lib/assignments-types';
import { formatDateTime } from '@/lib/format';
import { EditAssignmentDialog } from '../../vehicules/[id]/edit-assignment-dialog';

/**
 * Véhicules dont le conducteur est ou a été responsable habituel (GET /responsible-assignments?driverId=) ;
 * modification motivée des affectations que l'API déclare modifiables (PATCH /responsible-assignments/:id).
 */
export function DriverAssignmentsCard({ driverId }: { driverId: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<AssignmentView | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['responsible-assignments'] });
    void queryClient.invalidateQueries({ queryKey: ['vehicle'] });
  };
  const assignments = useQuery({ queryKey: ['responsible-assignments', 'driver', driverId], queryFn: () => api<AssignmentView[]>(`/responsible-assignments${toQuery({ driverId })}`) });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <h2>Véhicules dont il est responsable habituel</h2>
        </CardTitle>
        <CardDescription>{RESPONSIBLE_REMINDER} Les nominations et remplacements se font depuis l’onglet « Affectations » du véhicule ; une affectation à venir ou en cours peut être modifiée ici.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {assignments.isPending ? (
          <LoadingState />
        ) : assignments.isError ? (
          <ErrorState error={assignments.error} retry={() => void assignments.refetch()} />
        ) : assignments.data.length === 0 ? (
          <p className="text-muted-foreground">Ce conducteur n’a jamais été nommé responsable habituel d’un véhicule de votre périmètre.</p>
        ) : (
          <ul className="divide-y">
            {assignments.data.map((a) => {
              const state = assignmentState(a);
              return (
                <li key={a.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <Link href={`/vehicules/${a.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                      {a.vehicleCode}
                    </Link>
                    <span className="block text-muted-foreground">
                      {a.endsAt
                        ? `Du ${formatDateTime(a.startsAt, session.timezone)} au ${formatDateTime(a.endsAt, session.timezone)}`
                        : `${a.status === 'A_VENIR' ? 'À partir du' : 'Depuis le'} ${formatDateTime(a.startsAt, session.timezone)}, sans fin prévue`}
                    </span>
                    {a.endReason ? <span className="block text-muted-foreground">Motif de fin : {a.endReason}</span> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 self-start sm:self-center">
                    <StatusBadge label={state.label} tone={state.tone} />
                    {a.editableFields.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={() => setEditing(a)}>
                        Modifier<span className="sr-only"> l’affectation au véhicule {a.vehicleCode}</span>
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {editing ? (
          <EditAssignmentDialog
            key={editing.id}
            assignment={editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              refresh();
            }}
            onConflict={refresh}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
