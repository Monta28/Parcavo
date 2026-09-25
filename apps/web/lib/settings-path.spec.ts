import { describe, expect, it } from 'vitest';
import { getPath, setPath } from './settings-path';

describe('paramètres par chemin', () => {
  it('lit une valeur imbriquée, undefined si le chemin traverse une valeur non objet', () => {
    const settings = { source: 'SFTP', sftp: { host: 'h', port: 22 }, list: ['a'] };
    expect(getPath(settings, 'sftp.host')).toBe('h');
    expect(getPath(settings, 'sftp.port')).toBe(22);
    expect(getPath(settings, 'imap.host')).toBeUndefined();
    expect(getPath(settings, 'source.x')).toBeUndefined();
    expect(getPath(settings, 'list.0')).toBeUndefined();
  });

  it('écrit sans muter, crée les objets intermédiaires et conserve les autres clés', () => {
    const settings = { source: 'IMAP', columns: { unit: 'U' }, inconnue: { garde: true } };
    const next = setPath(settings, 'imap.host', 'mail.exemple.tn');
    expect(next).toEqual({ source: 'IMAP', columns: { unit: 'U' }, inconnue: { garde: true }, imap: { host: 'mail.exemple.tn' } });
    expect(settings).toEqual({ source: 'IMAP', columns: { unit: 'U' }, inconnue: { garde: true } });
    expect(setPath(next, 'columns.timestamp', 'Date').columns).toEqual({ unit: 'U', timestamp: 'Date' });
  });

  it('retire la clé pour undefined et supprime un parent vidé ; null reste une valeur (nature désactivée)', () => {
    const settings = { imap: { host: 'h' }, canOdometerAttribute: 'odometer' };
    expect(setPath(settings, 'imap.host', undefined)).toEqual({ canOdometerAttribute: 'odometer' });
    expect(setPath(settings, 'canOdometerAttribute', null)).toEqual({ imap: { host: 'h' }, canOdometerAttribute: null });
    expect(setPath(settings, 'canOdometerAttribute', undefined)).toEqual({ imap: { host: 'h' } });
  });

  it('remplace une valeur non objet par un objet quand un sous-chemin est écrit', () => {
    expect(setPath({ sftp: 'texte' }, 'sftp.host', 'h')).toEqual({ sftp: { host: 'h' } });
  });
});
