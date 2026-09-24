import { Injectable } from '@nestjs/common';

/**
 * Horloge injectable (CDC 18 : « les cas de temps utilisent une horloge contrôlable »).
 * Toute règle dépendant de « maintenant » reçoit un Clock ; les tests fournissent un FixedClock.
 */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock extends Clock {
  private current: Date;

  constructor(initial: Date | string) {
    super();
    this.current = new Date(initial);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(next: Date | string): void {
    this.current = new Date(next);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
