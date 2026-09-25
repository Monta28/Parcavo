import { onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { createQueryClient } from './query-client';

describe('client de requêtes : aucun envoi différé hors connexion (CDC 1.3, 10.3)', () => {
  afterEach(() => onlineManager.setOnline(true));

  it('hors connexion, une mutation est tentée tout de suite et échoue : ni pause, ni rejeu au retour du réseau', async () => {
    const client = createQueryClient();
    onlineManager.setOnline(false);
    let calls = 0;
    const mutation = client.getMutationCache().build(client, {
      mutationFn: async () => {
        calls += 1;
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(mutation.execute(undefined)).rejects.toThrow('Failed to fetch');
    expect(calls).toBe(1);
    expect(mutation.state.status).toBe('error');
    expect(mutation.state.isPaused).toBe(false);
    onlineManager.setOnline(true);
    await client.resumePausedMutations();
    expect(calls).toBe(1);
  });

  it('options par défaut : mutations « always » sans nouvelle tentative, lectures en pause hors connexion', () => {
    const options = createQueryClient().getDefaultOptions();
    expect(options.mutations).toMatchObject({ networkMode: 'always', retry: false });
    expect(options.queries?.networkMode).toBeUndefined();
  });
});
