import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMPORT_COLUMNS, suggestMapping } from './import-columns.js';

describe('Modèles d’import (CDC 12.2)', () => {
  it('contiennent les colonnes obligatoires du cahier des charges', () => {
    const required = (kind: keyof typeof IMPORT_COLUMNS) => IMPORT_COLUMNS[kind].filter((c) => c.required).map((c) => c.name);
    expect(required('VEHICULES')).toEqual(['company_code', 'vehicle_code', 'registration', 'make', 'model', 'category']);
    expect(required('CONDUCTEURS')).toEqual(['company_code', 'driver_code', 'first_name', 'last_name', 'active']);
    expect(required('RELEVES')).toEqual(['company_code', 'vehicle_code', 'observed_at', 'physical_km', 'meter_reference']);
    expect(required('BASES_ENTRETIEN')).toEqual(['company_code', 'vehicle_code', 'maintenance_type', 'base_mode']);
  });

  it('sont tous décrits dans docs/guide-imports.md', () => {
    const guide = readFileSync(resolve(import.meta.dirname, '../../../../../docs/guide-imports.md'), 'utf8');
    for (const [kind, columns] of Object.entries(IMPORT_COLUMNS)) {
      expect(guide, kind).toContain(`(\`${kind}\`)`);
      for (const c of columns) expect(guide, `${kind}.${c.name}`).toContain(`| \`${c.name}\` | ${c.required ? 'oui' : 'non'} |`);
    }
  });

  it('propose une association sur les en-têtes identiques (casse, espaces et tirets ignorés)', () => {
    expect(suggestMapping('CONDUCTEURS', ['Company Code', 'driver-code', 'Prénom', 'ACTIVE'])).toEqual({ company_code: 'Company Code', driver_code: 'driver-code', active: 'ACTIVE' });
  });
});
