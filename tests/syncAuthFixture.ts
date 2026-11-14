import { generateKeyPairSync, sign } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test" };
export const syncAuthFixture = {
  publicKeys: [jwk],
  publishableKey: "public",
  fetchImpl: async () => new Response("true", { status: 200 }),
};
export function signedSyncToken(payload: string, header = JSON.stringify({ alg: "ES256", kid: "test" })): string {
  const input = `${Buffer.from(header).toString("base64url")}.${Buffer.from(payload).toString("base64url")}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
