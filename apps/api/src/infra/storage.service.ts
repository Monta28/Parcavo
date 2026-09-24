import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { APP_ENV, type AppEnv } from './env.js';

export interface StoredObject {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Abstraction de stockage privé (CDC 16.2) : implémentation « volume persistant » en V1.
 * Les clés sont aléatoires ; aucun chemin utilisateur n'est utilisé. Un stockage objet
 * ultérieur remplace cette classe sans toucher aux modules métier.
 */
export abstract class ObjectStorage {
  abstract put(content: Buffer): Promise<StoredObject>;
  abstract openRead(storageKey: string): Promise<Readable>;
  abstract size(storageKey: string): Promise<number>;
  abstract remove(storageKey: string): Promise<void>;
}

@Injectable()
export class FileSystemStorage extends ObjectStorage implements OnModuleInit {
  private readonly logger = new Logger(FileSystemStorage.name);
  private readonly root: string;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    super();
    this.root = resolve(env.storageDir);
  }

  async onModuleInit(): Promise<void> {
    await mkdir(join(this.root, 'tmp'), { recursive: true });
    await mkdir(join(this.root, 'objects'), { recursive: true });
  }

  async put(content: Buffer): Promise<StoredObject> {
    const storageKey = randomBytes(24).toString('hex');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const dir = join(this.root, 'objects', storageKey.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const tmpPath = join(this.root, 'tmp', `${storageKey}.part`);
    await writeFile(tmpPath, content, { mode: 0o600 });
    await rename(tmpPath, this.pathFor(storageKey));
    return { storageKey, sizeBytes: content.length, sha256 };
  }

  async openRead(storageKey: string): Promise<Readable> {
    const path = this.pathFor(storageKey);
    await stat(path);
    return createReadStream(path);
  }

  async size(storageKey: string): Promise<number> {
    return (await stat(this.pathFor(storageKey))).size;
  }

  async remove(storageKey: string): Promise<void> {
    try {
      await unlink(this.pathFor(storageKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.logger.warn(`Objet déjà absent : ${storageKey}`);
    }
  }

  private pathFor(storageKey: string): string {
    if (!/^[a-f0-9]{48}$/.test(storageKey)) {
      throw new Error('Clé de stockage invalide.');
    }
    const path = join(this.root, 'objects', storageKey.slice(0, 2), storageKey);
    if (!path.startsWith(this.root + sep)) throw new Error('Chemin de stockage hors racine.');
    return path;
  }
}
