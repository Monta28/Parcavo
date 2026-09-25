import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEmail,
  IsEnum,
  IsISO8601,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsNumberString,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  validateSync,
} from 'class-validator';
import { flatten, translate } from './validation.js';

/**
 * CDC 10.1 : « tous les libellés, messages et statuts de l'interface sont en français ». Les erreurs par
 * champ (fieldErrors) de l'API sont affichées telles quelles sous les champs : aucun message par défaut de
 * class-validator (anglais) ne doit les atteindre, quel que soit le décorateur employé par un DTO.
 */

type Decorator = (target: object, property: string) => void;

/** Décorateurs de validation (avec message par défaut) et une valeur qu'ils refusent. */
const CASES: Record<string, { decorator: Decorator; invalid: unknown }> = {
  ArrayMaxSize: { decorator: ArrayMaxSize(2), invalid: [1, 2, 3] },
  ArrayMinSize: { decorator: ArrayMinSize(1), invalid: [] },
  ArrayUnique: { decorator: ArrayUnique(), invalid: [1, 1] },
  IsArray: { decorator: IsArray(), invalid: 'x' },
  IsBoolean: { decorator: IsBoolean(), invalid: 'x' },
  IsDateString: { decorator: IsDateString(), invalid: 'x' },
  IsDefined: { decorator: IsDefined(), invalid: undefined },
  IsEmail: { decorator: IsEmail(), invalid: 'x' },
  IsEnum: { decorator: IsEnum({ A: 'A' }), invalid: 'x' },
  IsISO8601: { decorator: IsISO8601(), invalid: 'x' },
  IsIn: { decorator: IsIn(['A']), invalid: 'x' },
  IsInt: { decorator: IsInt(), invalid: 1.5 },
  IsNotEmpty: { decorator: IsNotEmpty(), invalid: '' },
  IsNumber: { decorator: IsNumber(), invalid: 'x' },
  IsNumberString: { decorator: IsNumberString(), invalid: 'x' },
  IsObject: { decorator: IsObject(), invalid: 'x' },
  IsString: { decorator: IsString(), invalid: 1 },
  IsUUID: { decorator: IsUUID(), invalid: 'x' },
  Matches: { decorator: Matches(/^\d+$/), invalid: 'x' },
  Max: { decorator: Max(1), invalid: 2 },
  MaxLength: { decorator: MaxLength(1), invalid: 'xx' },
  Min: { decorator: Min(1), invalid: 0 },
  MinLength: { decorator: MinLength(3), invalid: 'x' },
  ValidateNested: { decorator: ValidateNested(), invalid: 'x' },
};
/** Imports de class-validator sans message propre : décorateurs conditionnels, fabriques et types. */
const NOT_VALIDATORS = new Set(['IsOptional', 'ValidateIf', 'ValidateBy', 'ValidationArguments', 'ValidationOptions', 'isUUID', 'registerDecorator', 'validate']);

const ENGLISH = /\b(must|should|elements|property|unknown value|either)\b/i;

function messagesFor(decorator: Decorator, value: unknown): string[] {
  class Probe {
    field: unknown;
  }
  decorator(Probe.prototype, 'field');
  const probe = Object.assign(new Probe(), { field: value });
  return Object.values(flatten(validateSync(probe))).flat();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('Messages de validation en français (CDC 10.1)', () => {
  it('chaque décorateur de class-validator employé par l’API produit un message français par champ', () => {
    const used = new Set<string>();
    for (const file of sourceFiles(fileURLToPath(new URL('..', import.meta.url)))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'class-validator'/g)) {
        for (const name of (m[1] ?? '').split(',')) {
          const clean = name.replace(/^\s*type\s+/, '').trim();
          if (clean) used.add(clean);
        }
      }
    }
    expect(used.size).toBeGreaterThan(15);
    const uncovered = [...used].filter((name) => !CASES[name] && !NOT_VALIDATORS.has(name));
    expect(uncovered, 'décorateur sans cas de traduction dans ce test').toEqual([]);

    for (const [name, { decorator, invalid }] of Object.entries(CASES)) {
      const messages = messagesFor(decorator, invalid);
      expect(messages.length, name).toBeGreaterThan(0);
      for (const message of messages) expect(message, `${name} : ${message}`).not.toMatch(ENGLISH);
    }
  });

  it('traduit les bornes de liste avec leur valeur et ne renvoie jamais un message par défaut anglais inconnu', () => {
    expect(messagesFor(CASES['ArrayMaxSize']!.decorator, [1, 2, 3])).toEqual(['Liste trop longue : 2 éléments au plus.']);
    expect(messagesFor(CASES['IsDefined']!.decorator, undefined)).toEqual(['Ce champ est obligatoire.']);
    expect(translate('value must be a hexadecimal color')).toBe('Valeur invalide.');
    expect(translate('field has to be a valid postal code')).toBe('Valeur invalide.');
    // Les messages propres au projet, en français, sont conservés tels quels.
    expect(translate('Litres : nombre strictement positif, 3 décimales au plus.')).toBe('Litres : nombre strictement positif, 3 décimales au plus.');
    expect(translate('Lieu invalide.')).toBe('Lieu invalide.');
  });
});
