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

function flatten(errors: ValidationError[], prefix = '', acc: FieldErrors = {}): FieldErrors {
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
];

function translate(message: string): string {
  for (const [pattern, fr] of TRANSLATIONS) {
    if (pattern.test(message)) return fr;
  }
  return message;
}
