import { describe, expect, it } from 'vitest';
import {
  assignmentStatus,
  canEndAssignment,
  currentAssignmentWhere,
  editableAssignmentFields,
  isAcceptableUpdatedEnd,
  isAssignmentCurrent,
  replacementDecision,
  submissionTargets,
  upcomingAssignmentWhere,
  vehicleAcceptsAssignment,
  type AssignmentPeriod,
  type SubmissionTargetInput,
} from './responsible-assignment.js';

const d = (iso: string) => new Date(iso);
const now = d('2026-09-24T10:00:00.000Z');
const ms = (date: Date, delta: number) => new Date(date.getTime() + delta);

/** Évalue la clause de base de données sur une période, pour vérifier qu'elle coïncide avec la règle. */
function matchesCurrentWhere(p: AssignmentPeriod, at: Date): boolean {
  const w = currentAssignmentWhere(at);
  const startOk = p.startsAt.getTime() <= w.startsAt.lte.getTime();
  const endOk = w.OR.some((clause) => (clause.endsAt === null ? p.endsAt === null : p.endsAt !== null && p.endsAt.getTime() > clause.endsAt.gt.getTime()));
  return startOk && endOk;
}

describe('état d’une affectation habituelle : définition unique (CDC 4.1, D-136)', () => {
  it('A_VENIR tant que le début est futur, même sans fin', () => {
    expect(assignmentStatus({ startsAt: ms(now, 1), endsAt: null }, now)).toBe('A_VENIR');
    expect(assignmentStatus({ startsAt: d('2026-10-01T00:00:00Z'), endsAt: d('2026-10-10T00:00:00Z') }, now)).toBe('A_VENIR');
  });

  it('EN_COURS dès le début (borne incluse), sans fin ou avec une fin future', () => {
    expect(assignmentStatus({ startsAt: now, endsAt: null }, now)).toBe('EN_COURS');
    expect(assignmentStatus({ startsAt: d('2026-09-01T00:00:00Z'), endsAt: null }, now)).toBe('EN_COURS');
    expect(assignmentStatus({ startsAt: d('2026-09-01T00:00:00Z'), endsAt: ms(now, 1) }, now)).toBe('EN_COURS');
  });

  it('TERMINEE dès que la fin est atteinte (borne exclue)', () => {
    expect(assignmentStatus({ startsAt: d('2026-09-01T00:00:00Z'), endsAt: now }, now)).toBe('TERMINEE');
    expect(assignmentStatus({ startsAt: d('2026-09-01T00:00:00Z'), endsAt: ms(now, -1) }, now)).toBe('TERMINEE');
  });

  it('isAssignmentCurrent et canEndAssignment dérivent de la même règle', () => {
    const cases: AssignmentPeriod[] = [
      { startsAt: ms(now, 1), endsAt: null },
      { startsAt: now, endsAt: null },
      { startsAt: ms(now, -1000), endsAt: ms(now, 1000) },
      { startsAt: ms(now, -1000), endsAt: now },
    ];
    expect(cases.map((c) => isAssignmentCurrent(c, now))).toEqual([false, true, true, false]);
    expect(cases.map((c) => canEndAssignment(c, now))).toEqual([true, true, true, false]);
  });

  it('la clause de base de données « en cours » coïncide avec la règle aux bornes', () => {
    const starts = [ms(now, -86_400_000), ms(now, -1), now, ms(now, 1)];
    const ends = [null, ms(now, -1), now, ms(now, 1), ms(now, 86_400_000)];
    for (const startsAt of starts) {
      for (const endsAt of ends) {
        if (endsAt && endsAt <= startsAt) continue;
        const p = { startsAt, endsAt };
        expect(matchesCurrentWhere(p, now)).toBe(isAssignmentCurrent(p, now));
      }
    }
    expect(upcomingAssignmentWhere(now)).toEqual({ startsAt: { gt: now } });
  });
});

describe('remplacement explicite du responsable en cours', () => {
  const current = { startsAt: d('2026-09-01T00:00:00Z'), endsAt: null };

  it('clôture l’affectation en cours au début de la nouvelle', () => {
    expect(replacementDecision(current, d('2026-09-20T00:00:00Z'))).toEqual({ action: 'CLOTURER', endsAt: d('2026-09-20T00:00:00Z') });
  });

  it('une affectation en cours avec fin prévue est remplaçable avant sa fin', () => {
    expect(replacementDecision({ startsAt: current.startsAt, endsAt: d('2026-12-31T00:00:00Z') }, d('2026-10-01T00:00:00Z'))).toEqual({ action: 'CLOTURER', endsAt: d('2026-10-01T00:00:00Z') });
  });

  it('ne prolonge jamais : fin prévue antérieure ou égale au nouveau début → rien à clôturer', () => {
    expect(replacementDecision({ startsAt: current.startsAt, endsAt: d('2026-10-01T00:00:00Z') }, d('2026-10-01T00:00:00Z'))).toEqual({ action: 'AUCUNE' });
    expect(replacementDecision({ startsAt: current.startsAt, endsAt: d('2026-10-01T00:00:00Z') }, d('2026-11-01T00:00:00Z'))).toEqual({ action: 'AUCUNE' });
  });

  it('refuse un nouveau début antérieur ou égal au début de l’affectation en cours', () => {
    expect(replacementDecision(current, d('2026-09-01T00:00:00Z'))).toEqual({ action: 'REFUS_DEBUT_ANTERIEUR' });
    expect(replacementDecision(current, d('2026-08-01T00:00:00Z'))).toEqual({ action: 'REFUS_DEBUT_ANTERIEUR' });
  });

  it('sans affectation en cours, rien à remplacer', () => {
    expect(replacementDecision(null, now)).toEqual({ action: 'AUCUNE' });
  });
});

describe('véhicule sorti du parc', () => {
  it('cédé ou archivé : plus de nouvelle affectation', () => {
    expect(vehicleAcceptsAssignment('ACTIF')).toBe(true);
    expect(vehicleAcceptsAssignment('HORS_SERVICE')).toBe(true);
    expect(vehicleAcceptsAssignment('CEDE')).toBe(false);
    expect(vehicleAcceptsAssignment('ARCHIVE')).toBe(false);
  });
});

describe('véhicule de soumission du conducteur (D-116, D-268)', () => {
  const base: SubmissionTargetInput = {
    driver: { status: 'ACTIF', companyId: 'A' },
    openUsage: null,
    assignments: [{ id: 'aff-1', vehicleId: 'v-resp', companyId: 'A', startsAt: d('2026-09-01T00:00:00Z'), endsAt: null, vehicle: { companyId: 'A', lifecycleStatus: 'ACTIF' } }],
    allowHabitualVehicleSubmissions: false,
    now,
  };

  it('utilisation EN_COURS : seul son véhicule, même si le paramètre est actif', () => {
    const targets = submissionTargets({ ...base, allowHabitualVehicleSubmissions: true, openUsage: { id: 'u-1', vehicleId: 'v-usage', companyId: 'A' } });
    expect(targets).toEqual([{ vehicleId: 'v-usage', companyId: 'A', basis: 'UTILISATION_EN_COURS', usageId: 'u-1', assignmentId: null }]);
  });

  it('sans utilisation et paramètre désactivé (défaut) : aucun véhicule', () => {
    expect(submissionTargets(base)).toEqual([]);
  });

  it('sans utilisation et paramètre actif : véhicule dont il est responsable habituel en cours', () => {
    expect(submissionTargets({ ...base, allowHabitualVehicleSubmissions: true })).toEqual([{ vehicleId: 'v-resp', companyId: 'A', basis: 'RESPONSABLE_HABITUEL', usageId: null, assignmentId: 'aff-1' }]);
  });

  it('exclut les affectations à venir ou terminées, les véhicules sortis du parc ou d’une autre société', () => {
    const vehicle = { companyId: 'A', lifecycleStatus: 'ACTIF' };
    const assignments = [
      { id: 'futur', vehicleId: 'v1', companyId: 'A', startsAt: ms(now, 60_000), endsAt: null, vehicle },
      { id: 'fini', vehicleId: 'v2', companyId: 'A', startsAt: d('2026-09-01T00:00:00Z'), endsAt: now, vehicle },
      { id: 'archive', vehicleId: 'v3', companyId: 'A', startsAt: d('2026-09-01T00:00:00Z'), endsAt: null, vehicle: { companyId: 'A', lifecycleStatus: 'ARCHIVE' } },
      { id: 'transfere', vehicleId: 'v4', companyId: 'A', startsAt: d('2026-09-01T00:00:00Z'), endsAt: null, vehicle: { companyId: 'B', lifecycleStatus: 'ACTIF' } },
      { id: 'autre-societe', vehicleId: 'v5', companyId: 'B', startsAt: d('2026-09-01T00:00:00Z'), endsAt: null, vehicle: { companyId: 'B', lifecycleStatus: 'ACTIF' } },
      { id: 'fin-future', vehicleId: 'v6', companyId: 'A', startsAt: d('2026-09-01T00:00:00Z'), endsAt: ms(now, 60_000), vehicle: { companyId: 'A', lifecycleStatus: 'HORS_SERVICE' } },
    ];
    expect(submissionTargets({ ...base, allowHabitualVehicleSubmissions: true, assignments }).map((t) => t.assignmentId)).toEqual(['fin-future']);
  });

  it('conducteur inactif : aucun véhicule, quelle que soit la base', () => {
    const inactive = { ...base, driver: { status: 'INACTIF', companyId: 'A' }, allowHabitualVehicleSubmissions: true };
    expect(submissionTargets(inactive)).toEqual([]);
    expect(submissionTargets({ ...inactive, openUsage: { id: 'u-1', vehicleId: 'v-usage', companyId: 'A' } })).toEqual([]);
  });
});

describe('modification d’une affectation (CDC 15.2, 4.1)', () => {
  it('à venir : tous les champs ; en cours : fin et notes seulement ; terminée : aucun', () => {
    expect(editableAssignmentFields({ startsAt: new Date('2026-10-01T00:00:00Z'), endsAt: null }, now)).toEqual(['driverId', 'startsAt', 'endsAt', 'notes']);
    expect(editableAssignmentFields({ startsAt: new Date('2026-09-01T00:00:00Z'), endsAt: null }, now)).toEqual(['endsAt', 'notes']);
    expect(editableAssignmentFields({ startsAt: new Date('2026-09-01T00:00:00Z'), endsAt: new Date('2026-09-30T00:00:00Z') }, now)).toEqual(['endsAt', 'notes']);
    expect(editableAssignmentFields({ startsAt: new Date('2026-09-01T00:00:00Z'), endsAt: now }, now)).toEqual([]);
  });
  it('une modification fixe une fin future ou aucune fin ; une fin passée ou présente relève de « terminer »', () => {
    expect(isAcceptableUpdatedEnd(null, now)).toBe(true);
    expect(isAcceptableUpdatedEnd(new Date('2026-09-24T10:00:01Z'), now)).toBe(true);
    expect(isAcceptableUpdatedEnd(now, now)).toBe(false);
    expect(isAcceptableUpdatedEnd(new Date('2026-09-20T00:00:00Z'), now)).toBe(false);
  });
});
