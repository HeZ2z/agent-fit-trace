import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const path = new URL("../supabase/migrations/20261030000100_coaching_conversation_runs.sql", import.meta.url);

test("conversation runs freeze bounded completed history under the owner lock", async () => {
  const sql = await readFile(path, "utf8");
  assert.match(sql, /owner_id = uid and c\.id = p_conversation_id for update/);
  assert.match(sql, /existing\.conversation_id is distinct from p_conversation_id/);
  assert.match(sql, /m\.owner_id=uid and m\.conversation_id=p_conversation_id/);
  assert.match(sql, /b\.n <= 10 and b\.total_bytes <= 16000/);
  assert.match(sql, /octet_length\(jsonb_build_object\('role','user','content',u\.content\)::text\)/);
  assert.match(sql, /conversation_id=p_conversation_id, conversation_context=ctx/);
  assert.match(sql, /revoke all on function public\.coaching_submit_run_guarded[^;]+authenticated/);
});

test("completed answers are written in the terminal transaction", async () => {
  const sql = await readFile(path, "utf8");
  assert.match(sql, /new\.status <> 'completed'/);
  assert.match(sql, /payload -> 'event' ->> 'type'='text_delta'/);
  assert.match(sql, /string_agg\(e\.payload -> 'event' ->> 'delta', '' order by e\.seq\)/);
  assert.match(sql, /create trigger coaching_completed_answer after update of status/);
  assert.match(sql, /on conflict \(owner_id,conversation_id,id\) do nothing/);
});


test("unconfirmed executions block both new turns and conversation deletion", async () => {
  const submit = await readFile(path, "utf8");
  const deletion = await readFile(new URL("../supabase/migrations/20261030000200_coaching_delete_conversation.sql", import.meta.url), "utf8");
  assert.match(submit, /r\.status not in \('completed','failed','cancelled'\)/);
  assert.match(deletion, /status not in \('completed','failed','cancelled'\)/);
});
