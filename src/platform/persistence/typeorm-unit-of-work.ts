import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';

/** Holds the transactional EntityManager for the current async call chain. */
const transactionStorage = new AsyncLocalStorage<EntityManager>();

/**
 * Repositories call this to get the manager to use: the transactional one
 * inside a unit of work, the DataSource default manager otherwise.
 */
export function currentManager(dataSource: DataSource): EntityManager {
  return transactionStorage.getStore() ?? dataSource.manager;
}

/**
 * True while the current async call chain runs inside a unit of work (a transaction holds a pool connection).
 *
 * The flag follows the async call chain (AsyncLocalStorage), not the transaction: work started inside the unit of
 * work and left running after it (a fire-and-forget promise, a timer, an event handler) still sees the flag, so a
 * guard that uses it, like the abuse counter store's, throws for that work too. Start such work after `run`
 * returns, or outside the chain (for example from a job that main.ts starts).
 */
export function isInUnitOfWork(): boolean {
  return transactionStorage.getStore() !== undefined;
}

@Injectable()
export class TypeOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly dataSource: DataSource) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    // A nested run joins the enclosing transaction instead of opening a new one.
    if (transactionStorage.getStore()) return work();
    return this.dataSource.transaction((manager) => transactionStorage.run(manager, work));
  }
}
