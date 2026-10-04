/**
 * Port: runs `work` inside one atomic transaction. Everything the work awaits
 * that goes through a repository joins the same transaction; if `work`
 * throws, all of it is rolled back.
 */
export interface UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
