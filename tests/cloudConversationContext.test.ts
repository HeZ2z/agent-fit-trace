import { test } from "node:test";
import { strict as assert } from "node:assert";
import { composeCoachPrompt, formatConversationContext } from "../server/cloud/conversationContext.ts";

test("cloud conversation context includes ordered prior turns and the current question", () => {
  const result = composeCoachPrompt("What next?", 3, [
    { role: "user", content: "My knee hurts" },
    { role: "assistant", content: "Reduce load" },
  ]);
  assert.match(result, /untrusted context/);
  assert.ok(result.indexOf("My knee hurts") < result.indexOf("Reduce load"));
  assert.ok(result.indexOf("Reduce load") < result.indexOf("What next?"));
  assert.match(result, /Pinned snapshot: 3/);
});

test("context keeps a bounded suffix of complete turns", () => {
  const turns = Array.from({ length: 25 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` }));
  const result = formatConversationContext(turns);
  assert.doesNotMatch(result, /turn 4"/);
  assert.match(result, /turn 5/);
  assert.match(result, /turn 24/);
  assert.equal(formatConversationContext([{ role: "user", content: "中".repeat(6000) }]), "");
});
