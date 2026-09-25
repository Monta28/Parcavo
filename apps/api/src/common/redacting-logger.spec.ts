import { afterEach, describe, expect, it } from 'vitest';
import { RedactingConsoleLogger } from './redacting-logger.js';
import { trackSensitiveValues } from './secret-redaction.js';

/** Capture de ce que le journal écrit réellement sur la sortie standard et la sortie d'erreur. */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originals = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  const write = (chunk: unknown) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return true;
  };
  process.stdout.write = write;
  process.stderr.write = write;
  return {
    lines,
    restore: () => {
      process.stdout.write = originals.out;
      process.stderr.write = originals.err;
    },
  };
}

describe('Journal masqué (D-304, T44)', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('format texte : jeton d’URL, en-tête et secret suivi masqués, y compris dans la pile', () => {
    const release = trackSensitiveValues(['Sentinelle-Journal-7c41']);
    const out = capture();
    restore = out.restore;
    try {
      const logger = new RedactingConsoleLogger({ logLevels: ['log', 'warn', 'error'] });
      logger.warn('Échec GET https://gps.example.tn/api?token=abcd1234efgh&all=true', 'Telemetrie');
      logger.error('Réponse : Authorization: Bearer eyJ0eXAi.payload.sig', 'Error: Sentinelle-Journal-7c41\n    at appel (fournisseur.ts:1:1)', 'Telemetrie');
      logger.log('Clé Sentinelle-Journal-7c41 reçue', 'Telemetrie');
    } finally {
      out.restore();
      release();
    }
    const journal = out.lines.join('');
    expect(journal).toContain('gps.example.tn/api');
    expect(journal).toContain('all=true');
    expect(journal).toContain('[expurgé]');
    for (const leak of ['abcd1234efgh', 'eyJ0eXAi.payload.sig', 'Sentinelle-Journal-7c41']) expect(journal).not.toContain(leak);
  });

  it('format JSON : chaque champ de l’objet journalisé est assaini', () => {
    const out = capture();
    restore = out.restore;
    try {
      const logger = new RedactingConsoleLogger({ json: true, logLevels: ['log', 'warn', 'error'] });
      logger.warn('Connexion refusée pour password=MotDePasse-Secret-9', 'Telemetrie');
    } finally {
      out.restore();
    }
    const journal = out.lines.join('');
    expect(journal).toContain('"level":"warn"');
    expect(journal).not.toContain('MotDePasse-Secret-9');
  });
});
