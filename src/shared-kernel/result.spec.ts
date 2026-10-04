import { DomainError } from './domain-error';
import { err, ok, type Result } from './result';

describe('Result', () => {
  it('wraps a success value', () => {
    const result: Result<number, DomainError> = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('wraps a failure', () => {
    const error = new DomainError('invalid_client', 'Unknown client');
    const result: Result<number, DomainError> = err(error);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(error);
    }
  });
});

describe('DomainError', () => {
  it('exposes a stable code and message and is an Error', () => {
    const error = new DomainError('invalid_grant', 'Code already used');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('invalid_grant');
    expect(error.message).toBe('Code already used');
    expect(error.name).toBe('DomainError');
  });

  it('keeps the code distinct between instances', () => {
    expect(new DomainError('a', 'x').code).not.toBe(new DomainError('b', 'x').code);
  });
});
