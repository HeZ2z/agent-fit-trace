import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestVerifier } from "../server/auth/testVerifier.ts";
import { createCloudCoachingHandler } from "../server/cloud/httpHandler.ts";
import { FakeCloudDatabase } from "./cloudFakes.ts";
import { createSupabaseCoachingRequestRepository } from "../server/cloud/supabaseCoachingRepository.ts";
import { CloudError } from "../server/cloud/repository.ts";

const base = "/coaching/cloud/conversations";
test("conversation endpoints validate inputs, require formal identity and expose no message write", async () => {
  const db = new FakeCloudDatabase();
  const fake = db.requestRepository();
  fake.listConversations = async () => ({ conversations: [] });
  fake.createConversation = async (id) => ({ id, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  fake.deleteConversation = async (id) => { if (id === "busy") throw new CloudError("CONFLICT", "Conversation has an active or unresolved run.", 409); if (id === "other-owner") throw new CloudError("NOT_FOUND", "Conversation not found.", 404); return {deleted: true}; };
  fake.readConversation = async () => { throw new CloudError("NOT_FOUND", "Conversation not found.", 404); };
  const handler = createCloudCoachingHandler({
    verifier: createTestVerifier({ formal: {id: "user-1", isAnonymous: false}, guest: {id: "guest", isAnonymous: true} }),
    repositoryFor: () => fake,
    source: null, providerConfigured: false,
    providerLimits: {maxSteps: 4, maxTokens: 2048, timeoutMs: 1000},
  });
  const call = (method: string, pathname: string, body?: unknown, token = "formal") => handler({method, pathname, authorization: `Bearer ${token}`, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  assert.equal((await call("GET", base, undefined, "guest")).status, 403);
  assert.equal((await call("GET", base)).status, 200);
  assert.equal((await call("POST", base, {id: "../bad"})).status, 400);
  assert.equal((await call("POST", base, {id: "conv-1"})).status, 201);
  assert.equal((await call("GET", `${base}/other-owner`)).status, 404);
  assert.equal((await call("DELETE", `${base}/other-owner`)).status, 404);
  assert.equal((await call("DELETE", `${base}/busy`)).status, 409);
  assert.deepEqual(JSON.parse((await call("DELETE", `${base}/conv-1`)).body).data, {deleted:true});
  assert.equal((await call("PUT", `${base}/conv-1/messages/m1`, {role:"assistant",content:"forged"})).status, 404);
});

test("conversation repository uses caller RPCs, rejects malformed history and maps hidden ownership to 404", async () => {
  let result: unknown = {conversation: {id:"c",createdAt:"t",updatedAt:"t"}, messages: [{id:"m",role:"user",content:"hello",createdAt:"t"}]};
  let status = 200;
  const requests: Array<{url:string,authorization:string | null}> = [];
  const repo = createSupabaseCoachingRequestRepository({supabaseUrl:"http://localhost",publishableKey:"pub",accessToken:"owner-token",fetchImpl: (async (input, init) => {
    requests.push({url:String(input),authorization:new Headers(init?.headers).get("authorization")});
    return new Response(JSON.stringify(result), {status});
  }) as typeof fetch});
  assert.equal((await repo.readConversation!("c")).messages[0]?.content, "hello");
  assert.match(requests[0]!.url, /coaching_read_conversation$/);
  assert.equal(requests[0]!.authorization, "Bearer owner-token");
  result = {conversation: {id:"c",createdAt:"t",updatedAt:"t"}, messages: [{id:"m",role:"system",content:"bad",createdAt:"t"}]};
  await assert.rejects(repo.readConversation!("c"), (e: unknown) => e instanceof CloudError && e.status === 503);
  status = 400; result = {message:"CLOUD_CONVERSATION_BUSY"};
  await assert.rejects(repo.deleteConversation!("busy"), (e: unknown) => e instanceof CloudError && e.status === 409);
  status = 400; result = {message:"CLOUD_CONVERSATION_NOT_FOUND"};
  await assert.rejects(repo.readConversation!("other-owner"), (e: unknown) => e instanceof CloudError && e.status === 404);
});

test("conversation submit IDs are validated and forwarded to replay lookup", async () => {
  const { parseCloudSubmitRunInput } = await import("@agent-fit-trace/api-contracts");
  const input = { sessionId: "s", prompt: "hello", idempotencyKey: "i", snapshot: {snapshotId:"snap",source:"src",accountId:"a"} };
  assert.throws(() => parseCloudSubmitRunInput({...input,conversationId:"../bad"}));
  assert.equal(parseCloudSubmitRunInput({...input,conversationId:"c-1"}).conversationId, "c-1");
  let sent: Record<string, unknown> | undefined;
  const repo = createSupabaseCoachingRequestRepository({supabaseUrl:"http://localhost",publishableKey:"pub",accessToken:"token",fetchImpl: (async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("null", {status:200});
  }) as typeof fetch});
  assert.equal(await repo.findRunByKey({...input,conversationId:"c-1"}), null);
  assert.equal(sent?.p_conversation_id, "c-1");
});
