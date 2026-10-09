import { randomBytes, randomUUID } from 'node:crypto';
import { FixedClock } from '../../src/shared-kernel/clock';
import { PostgresRetentionPurge } from '../../src/platform/retention/postgres-retention-purge';
import { RetentionSweeper } from '../../src/platform/retention/retention-sweeper';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const DAY_MS = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const BATCH = 1000;

describe('PostgresRetentionPurge and RetentionSweeper (integration, ADR 35)', () => {
  let db: TestDatabase;
  let appId: string;
  let userId: string;
  let purge: PostgresRetentionPurge;
  const query = <T>(sql: string, params: unknown[] = []): Promise<T[]> => db.dataSource.query(sql, params);
  const count = async (table: string): Promise<number> =>
    Number((await query<{ n: string }>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n);
  const sweeper = () =>
    new RetentionSweeper({ purge, clock: new FixedClock(NOW), logger: { error: (message) => { throw new Error(message); } } });

  const addSession = async (expiresAt: Date, overrides: { revokedAt?: Date | null } = {}): Promise<string> => {
    const id = randomUUID();
    await query(
      `INSERT INTO auth_sessions (id, app_id, user_id, created_at, last_used_at, expires_at, revoked_at, revoked_reason)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7)`,
      [id, appId, userId, ago(40 * DAY_MS), expiresAt, overrides.revokedAt ?? null, overrides.revokedAt ? 'logout' : null],
    );
    return id;
  };
  const addRefreshToken = async (sessionId: string, consumed: boolean): Promise<void> => {
    await query(
      `INSERT INTO refresh_tokens (token_hash, session_id, created_at, expires_at, consumed_at) VALUES ($1, $2, $3, $4, $5)`,
      [randomBytes(32), sessionId, ago(40 * DAY_MS), ago(30 * DAY_MS), consumed ? ago(35 * DAY_MS) : null],
    );
  };
  const addOneTimeToken = async (expiresAt: Date, consumedAt: Date | null = null): Promise<void> => {
    await query(
      `INSERT INTO one_time_tokens (id, user_id, purpose, token_hash, expires_at, consumed_at) VALUES ($1, $2, 'email_verification', $3, $4, $5)`,
      [randomUUID(), userId, randomBytes(32), expiresAt, consumedAt],
    );
  };
  const addOutbox = async (status: 'pending' | 'sent' | 'failed', createdAt: Date): Promise<string> => {
    const id = randomUUID();
    await query(
      `INSERT INTO email_outbox (id, app_id, to_address, template, status, next_attempt_at, created_at) VALUES ($1, $2, 'ana@example.com', 'confirmation', $3, $4, $4)`,
      [id, appId, status, createdAt],
    );
    return id;
  };
  const ids = async (table: string): Promise<string[]> =>
    (await query<{ id: string }>(`SELECT id FROM "${table}"`)).map((row) => row.id);

  beforeAll(async () => {
    db = await startTestDatabase();
    purge = new PostgresRetentionPurge(db.dataSource);
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    appId = randomUUID();
    userId = randomUUID();
    await query(
      `INSERT INTO apps (id, client_id, name, client_type, redirect_uris, allowed_origins, status, created_at, updated_at)
       VALUES ($1, $2, 'Shop', 'public', '{}', '{}', 'active', $3, $3)`,
      [appId, `app_${randomUUID().replaceAll('-', '')}`, NOW],
    );
    await query(
      `INSERT INTO users (id, app_id, email, password_hash, password_changed_at) VALUES ($1, $2, 'ana@example.com', 'hash', $3)`,
      [userId, appId, NOW],
    );
  });

  describe('sessions', () => {
    it('deletes a session expired for more than a day together with all its refresh tokens', async () => {
      const old = await addSession(ago(DAY_MS + 1000));
      await addRefreshToken(old, true);
      await addRefreshToken(old, false);

      const result = await sweeper().sweepOnce();

      expect(result.sessions).toBe(1);
      expect(await count('auth_sessions')).toBe(0);
      expect(await count('refresh_tokens')).toBe(0);
    });

    it('keeps a session at exactly one day past expiry and deletes it one millisecond later', async () => {
      const boundary = await addSession(ago(DAY_MS));
      await addRefreshToken(boundary, true);
      const justOver = await addSession(ago(DAY_MS + 1));

      await sweeper().sweepOnce();

      expect(await ids('auth_sessions')).toEqual([boundary]);
      expect(await count('refresh_tokens')).toBe(1);
      expect(justOver).not.toBe(boundary);
    });

    it('leaves a live session with consumed tokens untouched, so reuse detection survives', async () => {
      const live = await addSession(new Date(NOW.getTime() + 20 * DAY_MS));
      await addRefreshToken(live, true);
      await addRefreshToken(live, true);
      await addRefreshToken(live, false);
      // A session revoked long ago but not yet expired is also kept until its expiry plus a day.
      const revoked = await addSession(new Date(NOW.getTime() + DAY_MS), { revokedAt: ago(10 * DAY_MS) });
      await addRefreshToken(revoked, true);

      const result = await sweeper().sweepOnce();

      expect(result.sessions).toBe(0);
      expect((await ids('auth_sessions')).sort()).toEqual([live, revoked].sort());
      expect(await count('refresh_tokens')).toBe(4);
    });

    it('only removes the refresh tokens of the sessions it deletes', async () => {
      const old = await addSession(ago(2 * DAY_MS));
      await addRefreshToken(old, true);
      const live = await addSession(new Date(NOW.getTime() + DAY_MS));
      await addRefreshToken(live, false);

      await sweeper().sweepOnce();

      expect(await ids('auth_sessions')).toEqual([live]);
      expect(await count('refresh_tokens')).toBe(1);
    });
  });

  describe('one_time_tokens', () => {
    it('deletes tokens expired for more than a day, consumed or not, and keeps the boundary and live ones', async () => {
      await addOneTimeToken(ago(DAY_MS + 1));
      await addOneTimeToken(ago(2 * DAY_MS), ago(3 * DAY_MS));
      await addOneTimeToken(ago(DAY_MS));
      await addOneTimeToken(ago(DAY_MS - 1000), ago(DAY_MS));
      await addOneTimeToken(new Date(NOW.getTime() + 3600_000));

      const result = await sweeper().sweepOnce();

      expect(result.oneTimeTokens).toBe(2);
      expect(await count('one_time_tokens')).toBe(3);
    });
  });

  describe('email_outbox', () => {
    it('deletes sent and failed rows older than 7 days and keeps the boundary and newer ones', async () => {
      const oldSent = await addOutbox('sent', ago(7 * DAY_MS + 1));
      const oldFailed = await addOutbox('failed', ago(8 * DAY_MS));
      const boundarySent = await addOutbox('sent', ago(7 * DAY_MS));
      const recentFailed = await addOutbox('failed', ago(6 * DAY_MS));

      const result = await sweeper().sweepOnce();

      expect(result.outbox).toBe(2);
      const left = await ids('email_outbox');
      expect(left.sort()).toEqual([boundarySent, recentFailed].sort());
      expect(left).not.toContain(oldSent);
      expect(left).not.toContain(oldFailed);
    });

    it('never deletes a pending row, however old', async () => {
      const ancient = await addOutbox('pending', ago(365 * DAY_MS));
      await addOutbox('sent', ago(365 * DAY_MS));

      await sweeper().sweepOnce();

      expect(await ids('email_outbox')).toEqual([ancient]);
    });
  });

  describe('batches', () => {
    it('deletes more than one batch of 1,000 in a single sweep', async () => {
      await query(
        `INSERT INTO one_time_tokens (id, user_id, purpose, token_hash, expires_at)
         SELECT gen_random_uuid(), $1, 'email_verification', sha256((g::text || random()::text)::bytea), $2::timestamptz FROM generate_series(1, $3::int) AS g`,
        [userId, ago(5 * DAY_MS), BATCH * 2 + 345],
      );
      await addOneTimeToken(new Date(NOW.getTime() + DAY_MS));

      const result = await sweeper().sweepOnce();

      expect(result.oneTimeTokens).toBe(BATCH * 2 + 345);
      expect(await count('one_time_tokens')).toBe(1);
    });

    it('returns the deleted count, capped at the limit, from each purge method', async () => {
      for (let i = 0; i < 5; i++) await addSession(ago(3 * DAY_MS));
      expect(await purge.deleteExpiredSessions(ago(DAY_MS), 3)).toBe(3);
      expect(await purge.deleteExpiredSessions(ago(DAY_MS), 3)).toBe(2);
      expect(await purge.deleteExpiredSessions(ago(DAY_MS), 3)).toBe(0);
    });
  });
});
