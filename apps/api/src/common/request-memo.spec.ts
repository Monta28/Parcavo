import { describe, expect, it } from 'vitest';
import { RequestMemo, settingMemoPrefix } from './request-memo.js';

describe('RequestMemo (mémoïsation par requête HTTP)', () => {
  it('hors requête : chaque lecture est directe, rien n’est retenu', async () => {
    let reads = 0;
    const load = async () => ++reads;
    expect(await RequestMemo.get('k', load)).toBe(1);
    expect(await RequestMemo.get('k', load)).toBe(2);
  });

  it('dans une requête : une seule lecture par clé, y compris pour des lectures simultanées', async () => {
    let reads = 0;
    const load = async () => ++reads;
    await RequestMemo.run(async () => {
      const [a, b] = await Promise.all([RequestMemo.get('k', load), RequestMemo.get('k', load)]);
      expect([a, b, await RequestMemo.get('k', load)]).toEqual([1, 1, 1]);
      expect(await RequestMemo.get('autre', load)).toBe(2);
    });
    expect(reads).toBe(2);
  });

  it('deux requêtes ne partagent jamais leur mémoire', async () => {
    let reads = 0;
    const load = async () => ++reads;
    const first = RequestMemo.run(() => RequestMemo.get('k', load));
    const second = RequestMemo.run(() => RequestMemo.get('k', load));
    expect((await Promise.all([first, second])).sort()).toEqual([1, 2]);
  });

  it('une écriture invalide les valeurs de son préfixe ; un échec n’est pas retenu', async () => {
    let reads = 0;
    await RequestMemo.run(async () => {
      const key = `${settingMemoPrefix('org')}:societe:cle`;
      expect(await RequestMemo.get(key, async () => ++reads)).toBe(1);
      RequestMemo.invalidate(settingMemoPrefix('org'));
      expect(await RequestMemo.get(key, async () => ++reads)).toBe(2);
      await expect(RequestMemo.get('echec', async () => Promise.reject(new Error('base indisponible')))).rejects.toThrow('base indisponible');
      expect(await RequestMemo.get('echec', async () => 'relu')).toBe('relu');
    });
  });
});
