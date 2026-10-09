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

/** True while the current async call chain runs inside a unit of work (a transaction holds a pool connection). */
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
