import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MongoClient, type AnyBulkWriteOperation, type Collection, type Db, type Document } from "mongodb";
import { MongoMerchantStore } from "../../integrations/src/mongo-merchant.js";

/** Encrypted at rest: only the owning member's API responses ever decrypt it. */
export type SealedValue = { kid: string; iv: string; tag: string; data: string };
export type SessionRecord = { userId: string; roomId?: string; memberId?: string; createdAt: string };
export type RoomAggregate = { room: Document; users: Document[]; members: Document[]; proposals: Document[] };
export type Removals = { members: string[]; sessions: string[] };
export type Snapshot = { rooms: Document[]; users: Document[]; members: Document[]; proposals: Document[]; sessions: Document[]; invitations: Document[] };

const coordinatorCollections = ["rooms", "users", "members", "proposals", "sessions", "invitations"] as const;
const merchantCollections = ["merchant_offers", "merchant_bookings", "merchant_outbox"] as const;
export const SESSION_TTL_SECONDS = 30 * 86_400;

export class Sealer {
  readonly #key: Buffer;
  constructor(base64Key: string, readonly kid = "v1") {
    this.#key = Buffer.from(base64Key, "base64");
    if (this.#key.length !== 32) throw new Error("ACCORD_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  seal(value: unknown): SealedValue {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { kid: this.kid, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }
  open<T>(sealed: SealedValue): T {
    if (sealed.kid !== this.kid) throw new Error("UNKNOWN_ENCRYPTION_KEY");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8")) as T;
  }
}

/** Atlas-backed coordinator state. Requires a replica set (Atlas) for transactions. Run exactly one coordinator process. */
export class MongoPersistence {
  readonly merchantStore: MongoMerchantStore<any, any>;
  readonly #db: Db;
  #tail: Promise<void> = Promise.resolve();

  private constructor(private readonly client: MongoClient, dbName: string, readonly sealer: Sealer) {
    this.#db = client.db(dbName);
    this.merchantStore = new MongoMerchantStore(client, this.#db);
  }

  static async connect(uri: string, dbName: string, encryptionKey: string) {
    const sealer = new Sealer(encryptionKey);
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, appName: "accord-coordinator", ignoreUndefined: true });
    await client.connect();
    const persistence = new MongoPersistence(client, dbName, sealer);
    await persistence.#ensureIndexes();
    return persistence;
  }

  #collection(name: string): Collection<Document> { return this.#db.collection(name); }

  async #ensureIndexes() {
    await this.#collection("members").createIndex({ roomId: 1 });
    await this.#collection("members").createIndex({ userId: 1, roomId: 1 });
    await this.#collection("users").createIndex({ email: 1 }, { unique: true, sparse: true });
    await this.#collection("proposals").createIndex({ roomId: 1 });
    await this.#collection("sessions").createIndex({ userId: 1 });
    try { await this.#collection("sessions").createIndex({ createdAt: 1 }, { expireAfterSeconds: SESSION_TTL_SECONDS }); }
    catch (error) {
      const mongo = error as { code?: number; codeName?: string };
      if (mongo.code !== 85 && mongo.codeName !== "IndexOptionsConflict") throw error;
      // Existing deployments used a one-day TTL. Change it in place so
      // upgrading to durable 30-day device accounts does not block startup.
      await this.#db.command({ collMod: "sessions", index: { keyPattern: { createdAt: 1 }, expireAfterSeconds: SESSION_TTL_SECONDS } });
    }
  }

  async ping() {
    try { await this.#db.command({ ping: 1 }, { timeoutMS: 3_000 }); return true; }
    catch { return false; }
  }

  async load(): Promise<Snapshot> {
    const [rooms, users, members, proposals, sessions, invitations] = await Promise.all(
      coordinatorCollections.map(name => this.#collection(name).find().toArray()));
    return { rooms: rooms!, users: users!, members: members!, proposals: proposals!, sessions: sessions!, invitations: invitations! };
  }

  /** Writes are serialized so a later snapshot can never be overwritten by an earlier one. */
  save(aggregates: RoomAggregate[], users: Document[], sessions: Array<{ id: string; value: SessionRecord }>, invitations: Array<{ id: string; roomId: string }>, removed: Removals = { members: [], sessions: [] }) {
    const run = this.#tail.then(() => this.#write(aggregates, users, sessions, invitations, removed));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #write(aggregates: RoomAggregate[], users: Document[], sessions: Array<{ id: string; value: SessionRecord }>, invitations: Array<{ id: string; roomId: string }>, removed: Removals) {
    const upserts = (docs: Document[]): AnyBulkWriteOperation<Document>[] =>
      docs.map(doc => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } }));
    const writes: Array<[string, AnyBulkWriteOperation<Document>[]]> = [
      ["rooms", upserts(aggregates.map(item => item.room))],
      ["users", upserts([...new Map([...aggregates.flatMap(item => item.users), ...users].map(doc => [String(doc._id), doc])).values()])],
      ["members", upserts(aggregates.flatMap(item => item.members))],
      ["proposals", upserts(aggregates.flatMap(item => item.proposals))],
      ["sessions", upserts(sessions.map(item => ({ _id: item.id, ...item.value, createdAt: new Date(item.value.createdAt) })))],
      ["invitations", upserts(invitations.map(item => ({ _id: item.id, roomId: item.roomId })))],
    ];
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        for (const [name, operations] of writes) if (operations.length) await this.#collection(name).bulkWrite(operations, { session, ordered: true });
        if (removed.members.length) await this.#collection("members").deleteMany({ _id: { $in: removed.members } } as Document, { session });
        if (removed.sessions.length) await this.#collection("sessions").deleteMany({ _id: { $in: removed.sessions } } as Document, { session });
      }, { writeConcern: { w: "majority" }, maxCommitTimeMS: 10_000 });
    } finally { await session.endSession(); }
  }

  /** Demo reset: removes every room, session and merchant mutation so the catalog reseeds from scratch. */
  async clear() {
    await this.#tail;
    await Promise.all([...coordinatorCollections, ...merchantCollections].map(name => this.#collection(name).deleteMany({})));
  }

  async close() { await this.#tail; await this.client.close(); }
}
