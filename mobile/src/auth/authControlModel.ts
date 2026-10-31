/** Secret-free SQLite control rows shared by auth foreground/headless runtimes. */
export const AUTH_CONTROL_TABLE_SQL = `CREATE TABLE IF NOT EXISTS auth_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL,
  revoked INTEGER NOT NULL CHECK (revoked IN (0, 1))
);`;

export const AUTH_REFRESH_LEASE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS auth_refresh_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);`;

export const AUTH_REFRESH_LEASE_ACQUIRE_SQL = `INSERT INTO auth_refresh_lease (singleton, owner, generation, expires_at)
  SELECT 1, ?, ?, ? WHERE EXISTS (
    SELECT 1 FROM auth_control WHERE singleton = 1 AND generation = ? AND revoked = 0
  ) ON CONFLICT(singleton) DO UPDATE SET owner = excluded.owner,
    generation = excluded.generation, expires_at = excluded.expires_at
  WHERE auth_refresh_lease.generation <> excluded.generation OR auth_refresh_lease.expires_at <= ?`;

export const AUTH_REFRESH_LEASE_RELEASE_SQL =
  "DELETE FROM auth_refresh_lease WHERE singleton = 1 AND generation = ? AND owner = ?";

/** SecureStore data is accepted only if it matches the active control epoch. */
export function isSessionGenerationCurrent(
  envelopeGeneration: number,
  activeGeneration: number,
  revoked: boolean,
): boolean {
  return !revoked && Number.isSafeInteger(envelopeGeneration) && envelopeGeneration === activeGeneration;
}

/** A late refresh must still match both the current epoch and submitted token. */
export function isRefreshCredentialCurrent(
  envelopeGeneration: number,
  activeGeneration: number,
  revoked: boolean,
  currentRefreshToken: string,
  submittedRefreshToken: string,
): boolean {
  return isSessionGenerationCurrent(envelopeGeneration, activeGeneration, revoked) &&
    currentRefreshToken === submittedRefreshToken;
}

/** A delayed keychain delete must not erase a newer login's envelope. */
export function shouldDeleteRevokedSession(
  activeGeneration: number,
  revokedGeneration: number,
  revoked: boolean,
): boolean {
  return revoked && activeGeneration === revokedGeneration;
}
