import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generateSecret as otpGenerateSecret, generateURI, verifySync } from "otplib";
import { env } from "../env";

// Admin TOTP 2FA. The shared secret is AES-256-GCM encrypted at rest (contracts
// §2 requires AES-256 for secrets) with a key from env. Format stored in
// two_factor_secrets.secret: hex(iv):hex(tag):hex(ciphertext).
const KEY = Buffer.from(env.TWO_FACTOR_ENC_KEY, "hex");
const ISSUER = "Ashta Eight";

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), ct.toString("hex")].join(":");
}

function decrypt(stored: string): string {
  const [ivHex, tagHex, ctHex] = stored.split(":");
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}

export const generateSecret = () => otpGenerateSecret();
export const encryptSecret = encrypt;
export const otpauthUrl = (secret: string, accountEmail: string) =>
  generateURI({ issuer: ISSUER, label: accountEmail, secret });

// Verify a 6-digit code against the encrypted stored secret (otplib default
// tolerance window). Malformed stored data → false, never throws to the caller.
export function verifyCode(code: string, storedSecret: string): boolean {
  try {
    return verifySync({ token: code, secret: decrypt(storedSecret) }).valid;
  } catch {
    return false;
  }
}
