import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { ValidationFailedError, type FieldErrors } from './errors.js';

/** Pipe de validation global : DTO explicites, propriétés inconnues rejetées, erreurs par champ en français. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    stopAtFirstError: false,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) => new ValidationFailedError(flatten(errors)),
  });
}

/** Erreurs class-validator aplaties par chemin de propriété, messages traduits (pipe global et imports). */
export function flatten(errors: ValidationError[], prefix = '', acc: FieldErrors = {}): FieldErrors {
  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    if (error.constraints) {
      acc[path] = Object.values(error.constraints).map(translate);
    }
    if (error.children && error.children.length > 0) {
      flatten(error.children, path, acc);
    }
  }
  return acc;
}

const TRANSLATIONS: Array<[RegExp, string]> = [
  [/should not exist/i, 'Propriété non autorisée.'],
  [/must be a string/i, 'Une chaîne de caractères est attendue.'],
  [/must be a number/i, 'Un nombre est attendu.'],
  [/must be an integer/i, 'Un entier est attendu.'],
  [/must be a boolean/i, 'Une valeur vrai/faux est attendue.'],
  [/must be a UUID/i, 'Un identifiant valide est attendu.'],
  [/must be a valid ISO 8601/i, 'Une date ISO 8601 est attendue.'],
  [/must be an email/i, 'Une adresse e-mail valide est attendue.'],
  [/should not be empty/i, 'Ce champ est obligatoire.'],
  [/must be one of the following values/i, 'Valeur non autorisée.'],
  [/must be longer than or equal to (\d+)/i, 'Longueur minimale non respectée.'],
  [/must be shorter than or equal to (\d+)/i, 'Longueur maximale dépassée.'],
  [/must not be less than/i, 'Valeur trop petite.'],
  [/must not be greater than/i, 'Valeur trop grande.'],
  [/must be an array/i, 'Une liste est attendue.'],
  [/must be a positive number/i, 'Une valeur strictement positive est attendue.'],
  [/must match/i, 'Format invalide.'],
  [/should not be null or undefined/i, 'Ce champ est obligatoire.'],
  [/must contain no more than (\d+) elements/i, 'Liste trop longue : $1 éléments au plus.'],
  [/must contain at least (\d+) elements/i, 'Liste trop courte : $1 élément(s) au moins.'],
  [/elements must be unique/i, 'Les éléments de la liste doivent être distincts.'],
  [/must be either object or array/i, 'Un objet ou une liste est attendu.'],
  [/must be an object/i, 'Un objet est attendu.'],
  [/an unknown value was passed to the validate function/i, 'Contenu de requête inattendu.'],
];

/**
 * Message par défaut de class-validator resté en anglais (décorateur sans traduction ci-dessus) : jamais
 * renvoyé tel quel à l'interface (CDC 10.1). Les messages propres au projet, en français, sont conservés.
 */
const ENGLISH_DEFAULT = /^[\x20-\x7E]*\b(must|should|is not|are not|has to|elements|property)\b[\x20-\x7E]*$/;

export function translate(message: string): string {
  for (const [pattern, fr] of TRANSLATIONS) {
    const m = pattern.exec(message);
    if (m) return fr.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? '');
  }
  return ENGLISH_DEFAULT.test(message) ? 'Valeur invalide.' : message;
}
