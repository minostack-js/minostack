/**
 * Repository + unit-of-work ports (plan P5.1).
 *
 * Application services depend on these interfaces, never on database clients.
 * Optimistic concurrency is built in: `save` requires the entity version to
 * match the stored version and throws `ConflictException` otherwise.
 */

import { ConflictException } from "./exceptions.js";

export interface Versioned {
  id: string;
  version: number;
}

export interface Repository<T extends Versioned> {
  findById(id: string): Promise<T | undefined>;
  findAll(): Promise<T[]>;
  save(entity: T): Promise<T>;
  delete(id: string): Promise<boolean>;
}

/**
 * Single-process memory repository for dev/tests. Copies on write and read
 * so callers can never mutate stored state by accident.
 */
export class MemoryRepository<T extends Versioned> implements Repository<T> {
  private readonly rows = new Map<string, T>();

  async findById(id: string): Promise<T | undefined> {
    const row = this.rows.get(id);
    return row === undefined ? undefined : { ...row };
  }

  async findAll(): Promise<T[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async save(entity: T): Promise<T> {
    const stored = this.rows.get(entity.id);
    if (stored === undefined) {
      const created: T = { ...entity, version: entity.version ?? 0 };
      this.rows.set(entity.id, created);
      return { ...created };
    }
    if (stored.version !== entity.version) {
      throw new ConflictException(
        `Version conflict for "${entity.id}": expected ${stored.version}, got ${entity.version}`,
      );
    }
    const next: T = { ...entity, version: entity.version + 1 };
    this.rows.set(entity.id, next);
    return { ...next };
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  get size(): number {
    return this.rows.size;
  }
}

export interface UnitOfWork {
  /** Run `fn` transactionally (dev implementation runs it directly). */
  run<T>(fn: () => T | Promise<T>): Promise<T>;
}

/** Non-transactional unit of work for dev/tests — documents the boundary. */
export class MemoryUnitOfWork implements UnitOfWork {
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    return fn();
  }
}
