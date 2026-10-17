import assert from "node:assert/strict";
import { after, test } from "node:test";

import { validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";

/**
 * Real local-Supabase Auth integration for the anonymous-guest compatibility
 * spike. This is intentionally NOT part of the default suite and never talks
 * to a non-loopback project.
 *
 * Preconditions (see docs/supabase-setup.md §6):
 * - local `supabase start` + `supabase db reset` with the signup-gate
 *   migration applied;
 * - local Auth configured with the committed safe guest/upgrade profile:
 *   `[auth] enable_signup = true`, `enable_anonymous_sign_ins = true`,
 *   `enable_manual_linking = true`, and the `before_user_created` hook
 *   enabled;
 * - `[auth.email] enable_confirmations = true`, so a pending email change is
 *   not treated as a completed account upgrade;
 * - Mailpit (the Supabase local inbox) reachable at `MAILPIT_URL`
 *   (default `http://127.0.0.1:55324`).
 *
 * Run explicitly:
 *
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_PUBLISHABLE_KEY=<local publishable key> \
 *   SUPABASE_SERVICE_ROLE_KEY=<local service key> \
 *   FIT_TRACE_SUPABASE_AUTH_INTEGRATION=1 \
 *   FIT_TRACE_SUPABASE_UPGRADE_INTEGRATION=1 \
 *     node --test tests/supabaseAuthIntegration.test.ts
 *
 * The service key is used ONLY to provision/clean up throwaway local users and
 * to insert service-only invite rows; all guest/upgrade assertions use the
 * user's own bearer token. Verification consumes the real Mailpit inbox link
 * (HTTP redirect handled manually). Token/link values are never printed. This
 * suite never touches production data.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ENABLED = process.env.FIT_TRACE_SUPABASE_AUTH_INTEGRATION === "1";
const UPGRADE_ENABLED = process.env.FIT_TRACE_SUPABASE_UPGRADE_INTEGRATION === "1";
const MAILPIT_URL = (process.env.MAILPIT_URL ?? "http://127.0.0.1:55324").replace(/\/+$/, "");

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

const HARD_FAIL: string | null = !ENABLED
  ? null
  : SUPABASE_URL === "" || PUBLISHABLE_KEY === ""
    ? "FIT_TRACE_SUPABASE_AUTH_INTEGRATION=1 requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY."
    : !isLoopback(SUPABASE_URL)
      ? `refusing non-loopback SUPABASE_URL (${SUPABASE_URL}); auth integration never touches cloud.`
      : SERVICE_KEY === ""
        ? "FIT_TRACE_SUPABASE_AUTH_INTEGRATION=1 requires SUPABASE_SERVICE_ROLE_KEY (local only)."
        : null;

function seedRecord(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

function headers(token?: string, service = false): Record<string, string> {
  return {
    apikey: PUBLISHABLE_KEY,
    "Content-Type": "application/json",
    ...(service ? { Authorization: `Bearer ${SERVICE_KEY}` } : {}),
    ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function stackUp(): Promise<boolean> {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: PUBLISHABLE_KEY },
    });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function readOnce(response: Response): Promise<{ status: number; text: string; json: unknown }> {
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

const createdUserIds: string[] = [];

after(async () => {
  if (!ENABLED || HARD_FAIL !== null) return;
  for (const id of createdUserIds) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: headers(undefined, true),
      });
    } catch {
      // Best-effort cleanup of throwaway local users.
    }
  }
});

interface GuestSession {
  id: string;
  accessToken: string;
  user: { id: string; email?: string; is_anonymous?: boolean };
}

async function signInAnonymously(): Promise<GuestSession> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const once = await readOnce(response);
  assert.equal(once.status, 200, `anonymous sign-in failed: ${once.text.slice(0, 240)}`);
  const body = once.json as {
    access_token?: string;
    user?: { id?: string; email?: string; is_anonymous?: boolean };
  };
  assert.equal(typeof body.access_token, "string");
  assert.equal(typeof body.user?.id, "string");
  createdUserIds.push(body.user?.id as string);
  return {
    id: body.user?.id as string,
    accessToken: body.access_token as string,
    user: body.user as GuestSession["user"],
  };
}

async function verifiedUser(token: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: headers(token) });
  const once = await readOnce(response);
  assert.equal(once.status, 200, `verified user failed: ${once.text.slice(0, 240)}`);
  assert.equal(typeof once.json, "object");
  return once.json as Record<string, unknown>;
}

async function login(email: string, password: string): Promise<GuestSession> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const once = await readOnce(response);
  assert.equal(once.status, 200, `password login failed: ${once.text.slice(0, 240)}`);
  const body = once.json as {
    access_token: string;
    user: { id: string; email?: string; is_anonymous?: boolean };
  };
  return { id: body.user.id, accessToken: body.access_token, user: body.user };
}

async function insertInvite(email: string): Promise<void> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/signup_invites`, {
    method: "POST",
    headers: { ...headers(undefined, true), Prefer: "return=minimal" },
    body: JSON.stringify({ email }),
  });
  const once = await readOnce(response);
  assert.ok(
    once.status === 201 || once.status === 204 || once.status === 200,
    `allowlist insert failed: ${once.status} ${once.text.slice(0, 240)}`,
  );
}

async function inviteUser(email: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
    method: "POST",
    headers: headers(undefined, true),
    body: JSON.stringify({ email }),
  });
  const once = await readOnce(response);
  assert.equal(once.status, 200, `admin invite failed: ${once.text.slice(0, 240)}`);
  const id = (once.json as { id?: string }).id;
  assert.equal(typeof id, "string");
  createdUserIds.push(id as string);
  return id as string;
}

async function confirmEmailAndSetPassword(id: string, password: string): Promise<void> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: "PUT",
    headers: headers(undefined, true),
    body: JSON.stringify({ password, email_confirm: true }),
  });
  const once = await readOnce(response);
  assert.equal(once.status, 200, `admin confirmation failed: ${once.text.slice(0, 240)}`);
}

async function updateEmail(token: string, email: string): Promise<Response> {
  return fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({ email }),
  });
}

async function setPassword(token: string, password: string): Promise<Response> {
  return fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({ password }),
  });
}

interface MailpitMessageSummary {
  ID?: unknown;
  To?: { Address?: unknown }[];
}

/**
 * Read the real local inbox (Mailpit) and return the Auth verification link
 * for this recipient. Tokens are never printed or included in assertion
 * messages. This proves the mail-link/token path, not merely an Admin API
 * confirmation shortcut.
 */
async function waitForAuthLink(email: string, expectedType: string): Promise<string> {
  const target = email.toLowerCase();
  const deadline = Date.now() + 20_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const listResponse = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=100`);
    lastStatus = listResponse.status;
    if (listResponse.ok) {
      const listed = (await listResponse.json()) as { messages?: MailpitMessageSummary[] };
      const message = (listed.messages ?? []).find((candidate) =>
        (candidate.To ?? []).some(
          (to) => typeof to.Address === "string" && to.Address.toLowerCase() === target,
        ),
      );
      if (message !== undefined && typeof message.ID === "string") {
        const detailResponse = await fetch(`${MAILPIT_URL}/api/v1/message/${message.ID}`);
        if (detailResponse.ok) {
          const detail = (await detailResponse.json()) as { Text?: unknown; HTML?: unknown };
          const body = [detail.Text, detail.HTML]
            .filter((part): part is string => typeof part === "string")
            .join("\n")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
          const links = body.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]*/g) ?? [];
          const link = links.find((candidate) => candidate.includes(`type=${expectedType}`));
          if (link !== undefined) return link;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `no inbox verification link for ${email} (type=${expectedType}); mailpit HTTP ${lastStatus}`,
  );
}

/**
 * Consume the real email verification GET once and extract the implicit-flow
 * callback session. `redirect: "manual"` avoids depending on the Vite dev
 * server being up; the redirect Location is the app callback carrying tokens.
 * The returned access token is then the only source used for `/auth/v1/user`.
 */
async function verifyMailLink(link: string): Promise<{
  accessToken: string;
  refreshToken: string;
  type: string | null;
}> {
  const response = await fetch(link, {
    method: "GET",
    headers: { apikey: PUBLISHABLE_KEY },
    redirect: "manual",
  });
  assert.ok(
    response.status >= 300 && response.status < 400,
    `mail verification did not redirect (status ${response.status})`,
  );
  const location = response.headers.get("location");
  assert.equal(typeof location, "string", "mail verification redirect has no Location");
  const redirected = new URL(location as string);
  const params = new URLSearchParams(redirected.hash.startsWith("#") ? redirected.hash.slice(1) : "");
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  assert.equal(typeof accessToken, "string", "mail callback is missing access_token");
  assert.equal(typeof refreshToken, "string", "mail callback is missing refresh_token");
  return {
    accessToken: accessToken as string,
    refreshToken: refreshToken as string,
    type: params.get("type"),
  };
}

async function rpcCreate(token: string, record: WorkoutRecord): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/create_workout`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      p_id: record.id,
      p_payload: JSON.parse(JSON.stringify(record)) as unknown,
      p_date: record.date,
    }),
  });
}

async function rpcSaveArtifact(
  token: string,
  id: string,
  sourceRecordIds: string[],
  digest: string,
): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/save_imported_artifact`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      p_kind: "analysis",
      p_id: id,
      p_payload_schema_version: 1,
      p_payload: { metrics: {}, trends: [], source_records: sourceRecordIds },
      p_source_filename: "synthetic.json",
      p_source_record_ids: sourceRecordIds,
      p_content_digest: digest,
    }),
  });
}

test("anonymous sign-in creates a verified guest JWT (not the anon role)", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_AUTH_INTEGRATION=1 with local Supabase keys.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const guest = await signInAnonymously();
  // Classification is never trusted from the token response: the verified
  // `/auth/v1/user` response below is the only source. GoTrue v2.197.0 has
  // returned both an absent email and an empty string for guests; neither is a
  // classification signal.
  assert.ok(guest.user.email === undefined || guest.user.email === "");

  const verified = await verifiedUser(guest.accessToken);
  assert.equal(verified.id, guest.id);
  assert.equal(verified.is_anonymous, true);
  assert.ok(verified.email === undefined || verified.email === "");

  // A real guest JWT uses the authenticated role and own-row RLS.
  const record = seedRecord({ id: `w-guest-${Date.now()}`, date: "2026-10-17" });
  const created = await readOnce(await rpcCreate(guest.accessToken, record));
  assert.equal(created.status, 200, `guest workout create failed: ${created.text.slice(0, 240)}`);
  const listed = await fetch(
    `${SUPABASE_URL}/rest/v1/workouts?select=id,owner_id,payload&order=id.asc`,
    { headers: headers(guest.accessToken) },
  );
  const listedOnce = await readOnce(listed);
  assert.equal(listedOnce.status, 200, `guest workout read failed: ${listedOnce.text.slice(0, 240)}`);
  const rows = listedOnce.json as { id: string; owner_id: string }[];
  assert.deepEqual(rows.map((row) => row.id), [record.id]);
  assert.equal(rows[0]?.owner_id, guest.id);
});

test("public email signup is denied while a hook-qualified invited account can log in", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_AUTH_INTEGRATION=1 with local Supabase keys.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const stamp = Date.now();
  const denied = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `public-signup-${stamp}@example.com`,
      password: `Test-${stamp}-pw!`,
    }),
  });
  const deniedOnce = await readOnce(denied);
  assert.ok(
    deniedOnce.status >= 400,
    `public email signup must be denied under the safe profile, got ${deniedOnce.status}: ${deniedOnce.text.slice(0, 200)}`,
  );

  // A server-controlled allowlist row is the trusted qualification the
  // before_user_created hook checks; the client cannot create it.
  const email = `invited-${stamp}@example.com`;
  const password = `Test-${stamp}-pw!`;
  await insertInvite(email);
  const invitedId = await inviteUser(email);
  await confirmEmailAndSetPassword(invitedId, password);

  const account = await login(email, password);
  assert.equal(account.id, invitedId);
  const verified = await verifiedUser(account.accessToken);
  assert.equal(verified.id, invitedId);
  assert.equal(verified.is_anonymous, false);
  assert.equal(verified.email, email);
});

test("a valid invited pending email change does not authorize an account", async (t) => {
  if (!UPGRADE_ENABLED) {
    t.skip(
      "skipped: set FIT_TRACE_SUPABASE_UPGRADE_INTEGRATION=1 against the manual-linking profile.",
    );
    return;
  }
  assert.equal(ENABLED, true, "the pending-email check also requires FIT_TRACE_SUPABASE_AUTH_INTEGRATION=1.");
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const stamp = Date.now();
  const email = `guest-pending-${stamp}@example.com`;
  await insertInvite(email);
  const guest = await signInAnonymously();

  // A valid invite makes email-change initiation succeed. The invite must
  // remain unconsumed and the authoritative record must remain anonymous;
  // only the verified conversion may consume it.
  const response = await readOnce(await updateEmail(guest.accessToken, email));
  assert.ok(response.status < 400, `invited pending change failed: ${response.text.slice(0, 240)}`);
  const after = await verifiedUser(guest.accessToken);
  assert.equal(after.id, guest.id);
  assert.equal(after.is_anonymous, true);

  const invite = await readOnce(
    await fetch(
      `${SUPABASE_URL}/rest/v1/signup_invites?select=consumed_at&email=eq.${encodeURIComponent(email)}`,
      { headers: headers(undefined, true) },
    ),
  );
  assert.equal(invite.status, 200, `invite read failed: ${invite.text.slice(0, 240)}`);
  const rows = invite.json as { consumed_at: string | null }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.consumed_at, null);
});

test("same UID upgrade preserves ownership after real inbox verification + password (opt-in)", async (t) => {
  if (!UPGRADE_ENABLED) {
    t.skip(
      "skipped: set FIT_TRACE_SUPABASE_UPGRADE_INTEGRATION=1 against a stack with enable_manual_linking=true.",
    );
    return;
  }
  assert.equal(ENABLED, true, "the upgrade check also requires FIT_TRACE_SUPABASE_AUTH_INTEGRATION=1.");
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const stamp = Date.now();
  const email = `guest-upgrade-${stamp}@example.com`;
  const password = `Test-${stamp}-pw!`;
  await insertInvite(email);

  const guest = await signInAnonymously();
  const before = seedRecord({ id: `w-before-upgrade-${stamp}`, date: "2026-10-17" });
  const created = await readOnce(await rpcCreate(guest.accessToken, before));
  assert.equal(created.status, 200, `pre-upgrade workout create failed: ${created.text.slice(0, 240)}`);
  // issue6 validates the identity shape exactly: analysis:v1:<64 hex>. Per-user
  // ownership isolates the constant synthetic artifact across test users.
  const artifactId = `analysis:v1:${"a".repeat(64)}`;
  const artifact = await readOnce(
    await rpcSaveArtifact(guest.accessToken, artifactId, [before.id], "a".repeat(64)),
  );
  assert.equal(artifact.status, 200, `pre-upgrade artifact create failed: ${artifact.text.slice(0, 240)}`);

  const linked = await updateEmail(guest.accessToken, email);
  const linkedOnce = await readOnce(linked);
  assert.ok(linkedOnce.status < 400, `guest email link failed: ${linkedOnce.text.slice(0, 240)}`);
  const pending = await verifiedUser(guest.accessToken);
  assert.equal(pending.id, guest.id);
  assert.equal(pending.is_anonymous, true);

  // Real Mailpit inbox link/token. This is the actual GoTrue verify transaction
  // (not Admin email_confirm) that flips is_anonymous and consumes the invite.
  const link = await waitForAuthLink(email, "email_change");
  const callback = await verifyMailLink(link);
  assert.equal(callback.type, "email_change");

  const upgraded = await verifiedUser(callback.accessToken);
  assert.equal(upgraded.id, guest.id);
  assert.equal(upgraded.is_anonymous, false);
  assert.equal(upgraded.email, email);
  assert.equal(typeof upgraded.email_confirmed_at, "string");

  // Same UID and RLS ownership is preserved: the pre-upgrade workout remains
  // visible to the verified account (no owner/data migration).
  const listed = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/workouts?select=id,owner_id&order=id.asc`, {
      headers: headers(callback.accessToken),
    }),
  );
  assert.equal(listed.status, 200, `post-upgrade workout read failed: ${listed.text.slice(0, 240)}`);
  const rows = listed.json as { id: string; owner_id: string }[];
  assert.ok(rows.some((row) => row.id === before.id && row.owner_id === guest.id));

  // The sibling issue's imported artifact keeps the same owner across upgrade.
  const artifacts = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/imported_artifacts?select=id`, {
      headers: headers(callback.accessToken),
    }),
  );
  assert.equal(artifacts.status, 200, `post-upgrade artifact read failed: ${artifacts.text.slice(0, 240)}`);
  assert.ok((artifacts.json as { id: string }[]).some((row) => row.id === artifactId));

  // Password setup is an official follow-up with the verified callback token.
  const passwordSet = await readOnce(await setPassword(callback.accessToken, password));
  assert.ok(passwordSet.status < 400, `password set failed: ${passwordSet.text.slice(0, 240)}`);

  const signedIn = await login(email, password);
  assert.equal(signedIn.id, guest.id);
  const verified = await verifiedUser(signedIn.accessToken);
  assert.equal(verified.id, guest.id);
  assert.equal(verified.is_anonymous, false);
  assert.equal(verified.email, email);

  // Once the invite has been consumed at verified conversion, another guest
  // cannot initiate or complete an upgrade with the same email.
  const secondGuest = await signInAnonymously();
  const otherWorkouts = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/workouts?select=id`, {
      headers: headers(secondGuest.accessToken),
    }),
  );
  assert.equal(otherWorkouts.status, 200);
  assert.deepEqual(otherWorkouts.json, []);
  const otherArtifacts = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/imported_artifacts?select=id`, {
      headers: headers(secondGuest.accessToken),
    }),
  );
  assert.equal(otherArtifacts.status, 200);
  assert.deepEqual(otherArtifacts.json, []);
  const duplicate = await readOnce(await updateEmail(secondGuest.accessToken, email));
  assert.ok(
    duplicate.status >= 400,
    `consumed invite must not authorize another guest, got ${duplicate.status}`,
  );
  const secondAfter = await verifiedUser(secondGuest.accessToken);
  assert.equal(secondAfter.id, secondGuest.id);
  assert.equal(secondAfter.is_anonymous, true);

  // Invited/recovery flows remain unaffected after the upgrade trigger.
  const recovery = await readOnce(
    await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: "POST",
      headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }),
  );
  assert.equal(recovery.status, 200, `recovery request failed: ${recovery.text.slice(0, 240)}`);
});

test("guest upgrade boundary denies uninvited + forged-metadata upgrades (opt-in)", async (t) => {
  if (!UPGRADE_ENABLED) {
    t.skip(
      "skipped: set FIT_TRACE_SUPABASE_UPGRADE_INTEGRATION=1 against a stack with enable_manual_linking=true.",
    );
    return;
  }
  assert.equal(ENABLED, true, "the upgrade check also requires FIT_TRACE_SUPABASE_AUTH_INTEGRATION=1.");
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const guest = await signInAnonymously();
  const uninvited = `guest-uninvited-${Date.now()}@example.com`;

  // Direct PUT /auth/user email linking must be rejected at the Auth DB
  // boundary even though manual linking is enabled.
  const denied = await readOnce(await updateEmail(guest.accessToken, uninvited));
  assert.ok(denied.status >= 400, `uninvited upgrade must be denied, got ${denied.status}`);
  const stillGuest = await verifiedUser(guest.accessToken);
  assert.equal(stillGuest.id, guest.id);
  assert.equal(stillGuest.is_anonymous, true);

  // User metadata is never an invitation authority. Forging invite-looking
  // metadata must not flip classification or let an email change bypass the
  // trigger.
  const forged = await readOnce(
    await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: headers(guest.accessToken),
      body: JSON.stringify({
        data: { email: uninvited, signup_invite: true, role: "service_role" },
      }),
    }),
  );
  assert.ok(forged.status < 400, `metadata-only update should not be a credential change`);
  const afterMetadata = await verifiedUser(guest.accessToken);
  assert.equal(afterMetadata.id, guest.id);
  assert.equal(afterMetadata.is_anonymous, true);
});
