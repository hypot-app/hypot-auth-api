const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A token's `sub` is attacker-chosen until proven otherwise; Postgres rejects a non-UUID in a uuid column (a 500). */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
