import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";

export type StreamPrincipal = { roomId: string; memberId: string };
export type AuthorizeStream = (request: IncomingMessage, roomId: string) => Promise<StreamPrincipal | null>;
type Subscriber = { send: (id: string, payload: unknown) => void; close: () => void };

/** One API process. For multiple instances replace the broker with a shared durable transport. */
export class RoomStreams<PublicEvent, PrivateEvent> {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  constructor(private readonly publicSchema: z.ZodType<PublicEvent>, private readonly privateSchema: z.ZodType<PrivateEvent>, private readonly authorize: AuthorizeStream) {}

  private key(roomId: string, memberId?: string) { return JSON.stringify([roomId, memberId ?? null]); }

  async connect(request: IncomingMessage, response: ServerResponse, roomId: string, channel: "public" | "private") {
    const principal = await this.authorize(request, roomId).catch(() => null);
    if (!principal || principal.roomId !== roomId || !principal.memberId) {
      response.writeHead(401, { "cache-control": "no-store" }).end(); return;
    }
    const key = this.key(roomId, channel === "private" ? principal.memberId : undefined);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no", "connection": "keep-alive" });
    response.flushHeaders();
    response.write("retry: 2000\nevent: resync\ndata: {}\n\n"); // Fetch current session-authorized state after every reconnect.
    let closed = false, pending = 0;
    let queue = Promise.resolve();
    const current = async () => {
      const next = await this.authorize(request, roomId).catch(() => null);
      return next?.roomId === roomId && next.memberId === principal.memberId;
    };
    const subscriber: Subscriber = {
      send: (id, payload) => {
        if (closed) return;
        if (++pending > 100) { subscriber.close(); return; }
        queue = queue.then(async () => {
          try {
            if (closed) return;
            if (!await current()) { subscriber.close(); return; }
            if (!response.write(`id: ${id}\nevent: update\ndata: ${JSON.stringify(payload)}\n\n`)) subscriber.close();
          } finally { pending--; }
        }).catch(() => subscriber.close());
      },
      close: () => {
        if (closed) return;
        closed = true; clearInterval(heartbeat);
        this.subscribers.get(key)?.delete(subscriber);
        if (!this.subscribers.get(key)?.size) this.subscribers.delete(key);
        response.end();
      },
    };
    const heartbeat = setInterval(() => {
      void current().then(valid => {
        if (!valid) subscriber.close();
        else if (!closed && !response.write(": heartbeat\n\n")) subscriber.close();
      }).catch(() => subscriber.close());
    }, 15_000);
    heartbeat.unref();
    if (!this.subscribers.has(key)) this.subscribers.set(key, new Set());
    this.subscribers.get(key)!.add(subscriber);
    response.once("close", subscriber.close);
  }

  publishPublic(roomId: string, eventId: string, event: PublicEvent) {
    this.publish(this.key(roomId), eventId, this.publicSchema.parse(event));
  }
  /** memberId is server-resolved from the domain event recipient, never a client selector. */
  publishPrivate(roomId: string, memberId: string, eventId: string, event: PrivateEvent) {
    this.publish(this.key(roomId, memberId), eventId, this.privateSchema.parse(event));
  }
  private publish(key: string, id: string, payload: unknown) {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(id)) throw new Error("Invalid event ID");
    for (const subscriber of this.subscribers.get(key) ?? []) subscriber.send(id, payload);
  }
  close() { for (const group of this.subscribers.values()) for (const subscriber of group) subscriber.close(); }
}
