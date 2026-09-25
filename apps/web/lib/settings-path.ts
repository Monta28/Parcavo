// Lecture et écriture par chemin (« imap.host ») dans un objet de paramètres JSON, sans mutation.
// Utilisé par l'éditeur des paramètres non secrets d'un fournisseur télématique.

type Settings = Record<string, unknown>;

function isObject(value: unknown): value is Settings {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getPath(settings: Settings, path: string): unknown {
  let current: unknown = settings;
  for (const key of path.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Remplace (ou retire si undefined) la valeur au chemin ; un objet parent vidé est retiré. */
export function setPath(settings: Settings, path: string, value: unknown): Settings {
  const [head, ...rest] = path.split('.') as [string, ...string[]];
  const next: Settings = { ...settings };
  if (rest.length === 0) {
    if (value === undefined) delete next[head];
    else next[head] = value;
    return next;
  }
  const child = setPath(isObject(next[head]) ? next[head] : {}, rest.join('.'), value);
  if (Object.keys(child).length === 0) delete next[head];
  else next[head] = child;
  return next;
}
