import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

const KEY_BYTES = 64;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => nodeScrypt(password, salt, KEY_BYTES, (error, key) => error ? reject(error) : resolve(key)));
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt);
  return { passwordSalt: salt.toString("base64"), passwordHash: hash.toString("base64") };
}

export async function verifyPassword(password: string, passwordSalt: string, passwordHash: string) {
  const expected = Buffer.from(passwordHash, "base64");
  const actual = await scrypt(password, Buffer.from(passwordSalt, "base64"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Keeps unknown-email login attempts close to the same cost as known accounts. */
export async function consumePasswordCost(password: string) {
  await scrypt(password, Buffer.alloc(16, 0x5a));
}
