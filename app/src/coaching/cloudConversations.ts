/** Authenticated durable conversation reads. The server owns message writes. */
export interface CloudConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
}
export interface CloudConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
export interface CloudConversationDetail {
  conversation: CloudConversation;
  messages: CloudConversationMessage[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function conversation(value: unknown): CloudConversation {
  if (!object(value) || typeof value.id !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("Invalid conversation response.");
  }
  return { id: value.id, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function message(value: unknown): CloudConversationMessage {
  if (!object(value) || typeof value.id !== "string" || (value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string" || typeof value.createdAt !== "string") {
    throw new Error("Invalid conversation message.");
  }
  return { id: value.id, role: value.role, content: value.content, createdAt: value.createdAt };
}

export class CloudConversationsClient {
  constructor(private readonly getAccessToken: () => string | null) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const token = this.getAccessToken();
    if (!token) throw new Error("Sign in to access conversations.");
    const response = await fetch(`/api/v1/coaching/cloud/conversations${path}`, {
      ...init,
      redirect: "error",
      headers: { accept: "application/json", authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
    });
    if (!response.ok) throw new Error(`Conversation request failed (${response.status}).`);
    const body: unknown = await response.json();
    if (!object(body) || !("data" in body)) throw new Error("Invalid conversation response.");
    return body.data;
  }

  async list(): Promise<CloudConversation[]> {
    const result = await this.request("");
    if (!object(result) || !Array.isArray(result.conversations)) throw new Error("Invalid conversations response.");
    return result.conversations.map(conversation);
  }

  async create(id: string): Promise<CloudConversation> {
    return conversation(await this.request("", { method: "POST", body: JSON.stringify({ id }) }));
  }

  async delete(id: string): Promise<void> {
    const result = await this.request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!object(result) || result.deleted !== true) throw new Error("Invalid delete response.");
  }

  async read(id: string): Promise<CloudConversationDetail> {
    const result = await this.request(`/${encodeURIComponent(id)}`);
    if (!object(result) || !Array.isArray(result.messages)) throw new Error("Invalid conversation response.");
    return { conversation: conversation(result.conversation), messages: result.messages.map(message) };
  }
}
