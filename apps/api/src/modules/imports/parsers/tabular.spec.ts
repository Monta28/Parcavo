import { describe, expect, it } from 'vitest';
import { readTable } from './tabular.js';

const csv = (text: string) => Buffer.from(text, 'utf8');

describe('Lecture des fichiers d’import (CDC 12.1, D-278)', () => {
  it('CSV UTF-8 avec BOM, séparateur détecté, guillemets RFC 4180 et numéros de ligne d’origine', async () => {
    const table = await readTable(csv('﻿a;b;c\r\n1;"x;y";"dit ""oui"""\r\n\r\n2;=F("z");\n'), 'f.csv', 10);
    expect(table.headers).toEqual(['a', 'b', 'c']);
    expect(table.rows).toEqual([
      { line: 2, cells: ['1', 'x;y', 'dit "oui"'] },
      { line: 4, cells: ['2', '=F("z")', ''] },
    ]);
    const comma = await readTable(csv('a,b\n1,2'), 'f.csv', 10);
    expect(comma.rows[0]?.cells).toEqual(['1', '2']);
  });
  it('refus explicites : encodage, guillemet non fermé, fichier vide, trop de lignes', async () => {
    await expect(readTable(Buffer.from([0x61, 0x3b, 0xe9, 0x0a, 0x31]), 'f.csv', 10)).rejects.toMatchObject({ code: 'ENCODAGE_INVALIDE' });
    await expect(readTable(csv('a;b\n1;"2'), 'f.csv', 10)).rejects.toMatchObject({ code: 'CSV_INVALIDE' });
    await expect(readTable(csv('a;b\n;\n'), 'f.csv', 10)).rejects.toMatchObject({ code: 'FICHIER_VIDE' });
    await expect(readTable(csv('a\n1\n2\n3'), 'f.csv', 2)).rejects.toMatchObject({ code: 'TROP_DE_LIGNES' });
  });
});
