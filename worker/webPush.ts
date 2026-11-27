// Web Push with WebCrypto only: the message encryption of RFC 8291 (content coding aes128gcm,
// RFC 8188) and the VAPID Authorization header of RFC 8292. No request is made here; nothing
// here logs a key, a header or a payload.

/** An uncompressed P-256 point: 0x04, then X and Y of 32 bytes each. */
export const P256_PUBLIC_KEY_BYTES = 65;
export const P256_PRIVATE_KEY_BYTES = 32;
const P256_COORDINATE_BYTES = 32;
const UNCOMPRESSED_POINT = 0x04;
export const AUTH_SECRET_BYTES = 16;
export const SALT_BYTES = 16;

// RFC 8291 section 4: a push message is one record of at most 4096 bytes including the header.
const RECORD_SIZE = 4096;
const HEADER_BYTES = SALT_BYTES + 4 + 1 + P256_PUBLIC_KEY_BYTES;
const GCM_TAG_BYTES = 16;
/** The delimiter of the last (here: only) record, RFC 8188 section 2. */
const LAST_RECORD_DELIMITER = 0x02;
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_BYTES - GCM_TAG_BYTES - 1;

const CONTENT_KEY_BYTES = 16;
const NONCE_BYTES = 12;
const INPUT_KEY_BYTES = 32;

// RFC 8292 section 2: a push service must refuse a token that expires more than 24 hours ahead.
// Twelve hours leaves room for a clock that is off.
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

type Bytes = Uint8Array<ArrayBuffer>;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Decodes unpadded base64url; null for anything else (padding, '+', '/', a stray character). */
export function base64UrlDecode(text: string): Bytes | null {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function utf8(text: string): Bytes {
  // Copied into a plain ArrayBuffer view, which is what WebCrypto's types ask for.
  return new Uint8Array(new TextEncoder().encode(text));
}

// The three helpers below only narrow what WebCrypto returns: the runtime's type definitions
// give unions (a key or a pair, bytes or a JWK) whatever was asked for.

/** A P-256 key pair. Declared here: the Workers type definitions have no CryptoKeyPair. */
export interface P256KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

type KeyUse = { name: 'ECDH'; usage: 'deriveBits' } | { name: 'ECDSA'; usage: 'sign' };

export async function generateP256KeyPair({ name, usage }: KeyUse): Promise<P256KeyPair> {
  const pair = await crypto.subtle.generateKey({ name, namedCurve: 'P-256' }, true, [usage]);
  if (!('privateKey' in pair)) throw new Error('Expected a key pair');
  return pair;
}

/** The 65 bytes of a P-256 public key. */
export async function exportPublicKey(publicKey: CryptoKey): Promise<Bytes> {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error('Expected raw key bytes');
  return new Uint8Array(raw);
}

/** The 32-byte ECDH shared secret (the X coordinate of the shared point). */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<Bytes> {
  const algorithm = { name: 'ECDH', public: publicKey };
  const bits = await crypto.subtle.deriveBits(algorithm, privateKey, P256_COORDINATE_BYTES * 8);
  return new Uint8Array(bits);
}

function concat(...parts: Uint8Array[]): Bytes {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** HKDF with SHA-256 (RFC 5869): extract with the salt, then expand with the info. */
async function hkdf(salt: Bytes, keyMaterial: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Imports a browser's P-256 public key (65 raw bytes). Throws when the bytes are not a point on
 * the curve, which is how a subscription with a made-up key is refused.
 */
export function importSubscriberKey(publicKey: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', publicKey, P256, false, []);
}

/** What the browser gave when it subscribed, decoded. */
export interface SubscriberKeys {
  /** The browser's P-256 public key, 65 bytes. */
  p256dh: Bytes;
  /** The browser's auth secret, 16 bytes. */
  auth: Bytes;
}

/** What must be new for every message: a P-256 key pair and 16 random bytes. */
export interface FreshSecrets {
  keyPair: P256KeyPair;
  salt: Bytes;
}

export async function generateFreshSecrets(): Promise<FreshSecrets> {
  const keyPair = await generateP256KeyPair({ name: 'ECDH', usage: 'deriveBits' });
  return { keyPair, salt: crypto.getRandomValues(new Uint8Array(SALT_BYTES)) };
}

/**
 * Encrypts one push message for one browser (RFC 8291) and returns the request body: the
 * aes128gcm header (salt, record size, the sender's public key) followed by the one record.
 * `fresh` is a parameter so a test can run the RFC's example; every real message gets new ones.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  subscriber: SubscriberKeys,
  fresh: FreshSecrets,
): Promise<Bytes> {
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error(`A push message holds at most ${MAX_PLAINTEXT_BYTES} bytes`);
  }
  if (subscriber.auth.byteLength !== AUTH_SECRET_BYTES) throw new Error('auth must be 16 bytes');
  if (fresh.salt.byteLength !== SALT_BYTES) throw new Error('salt must be 16 bytes');

  const subscriberKey = await importSubscriberKey(subscriber.p256dh);
  const senderPublic = await exportPublicKey(fresh.keyPair.publicKey);
  const sharedSecret = await deriveSharedSecret(fresh.keyPair.privateKey, subscriberKey);

  // RFC 8291 section 3.4: the auth secret mixes into the shared secret, bound to both keys.
  const keyInfo = concat(utf8('WebPush: info\0'), subscriber.p256dh, senderPublic);
  const inputKey = await hkdf(subscriber.auth, sharedSecret, keyInfo, INPUT_KEY_BYTES);
  // RFC 8188 section 2.2 and 2.3: the content key and the nonce of the first record.
  const contentKey = await hkdf(
    fresh.salt,
    inputKey,
    utf8('Content-Encoding: aes128gcm\0'),
    CONTENT_KEY_BYTES,
  );
  const nonce = await hkdf(fresh.salt, inputKey, utf8('Content-Encoding: nonce\0'), NONCE_BYTES);

  const key = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: GCM_TAG_BYTES * 8 },
      key,
      concat(plaintext, new Uint8Array([LAST_RECORD_DELIMITER])),
    ),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);
  return concat(
    fresh.salt,
    recordSize,
    new Uint8Array([senderPublic.byteLength]),
    senderPublic,
    record,
  );
}

/**
 * The Worker's VAPID key pair, as stored in the secrets VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY:
 * the public key is the 65-byte uncompressed P-256 point and the private key the 32-byte
 * scalar, both unpadded base64url. That is the form browsers take as applicationServerKey and
 * the one other Web Push tools use for a VAPID pair.
 */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Whether the two strings have the shape of a VAPID pair. Does not prove they belong together. */
export function isVapidKeyPair(keys: VapidKeys): boolean {
  const publicKey = base64UrlDecode(keys.publicKey);
  const privateKey = base64UrlDecode(keys.privateKey);
  return (
    publicKey?.byteLength === P256_PUBLIC_KEY_BYTES &&
    publicKey[0] === UNCOMPRESSED_POINT &&
    privateKey?.byteLength === P256_PRIVATE_KEY_BYTES
  );
}

/** A new VAPID pair in the stored form. Used by scripts/push-keys.ts and by tests. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await generateP256KeyPair({ name: 'ECDSA', usage: 'sign' });
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (jwk instanceof ArrayBuffer || jwk.d === undefined) {
    throw new Error('The generated key has no private part');
  }
  return { publicKey: base64UrlEncode(await exportPublicKey(pair.publicKey)), privateKey: jwk.d };
}

async function importVapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const publicKey = base64UrlDecode(keys.publicKey);
  if (!isVapidKeyPair(keys) || publicKey === null) throw new Error('The VAPID keys are malformed');
  const x = publicKey.slice(1, 1 + P256_COORDINATE_BYTES);
  const y = publicKey.slice(1 + P256_COORDINATE_BYTES);
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: base64UrlEncode(x),
      y: base64UrlEncode(y),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

export interface VapidClaims {
  /** The origin of the push service the message goes to, for example https://push.example. */
  audience: string;
  /** A contact for the push service's operator. Here the dashboard URL, never an address. */
  subject: string;
  now: Date;
}

/**
 * The Authorization header of RFC 8292: `vapid t=<JWT signed with ES256>, k=<public key>`.
 * WebCrypto's ECDSA signature is already the 64 bytes (R then S) that a JWT wants.
 */
export async function vapidAuthorization(keys: VapidKeys, claims: VapidClaims): Promise<string> {
  const signingKey = await importVapidSigningKey(keys);
  const header = base64UrlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = base64UrlEncode(
    utf8(
      JSON.stringify({
        aud: claims.audience,
        exp: Math.floor(claims.now.getTime() / 1000) + VAPID_LIFETIME_SECONDS,
        sub: claims.subject,
      }),
    ),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      utf8(`${header}.${body}`),
    ),
  );
  return `vapid t=${header}.${body}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}
