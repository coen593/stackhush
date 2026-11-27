// The receiving side of Web Push, for tests: what a browser does with a push message. It makes
// a subscriber's keys and decrypts a request body with them (RFC 8291), written separately from
// worker/webPush.ts so a test that reads a message back does not check the sender against itself.

import {
  base64UrlDecode,
  base64UrlEncode,
  deriveSharedSecret,
  exportPublicKey,
  generateP256KeyPair,
  utf8,
} from '../webPush.ts';

type Bytes = Uint8Array<ArrayBuffer>;

export interface Subscriber {
  privateKey: CryptoKey;
  /** The public key and auth secret as a browser hands them over: unpadded base64url. */
  p256dh: string;
  auth: string;
}

export async function generateSubscriber(): Promise<Subscriber> {
  const pair = await generateP256KeyPair({ name: 'ECDH', usage: 'deriveBits' });
  return {
    privateKey: pair.privateKey,
    p256dh: base64UrlEncode(await exportPublicKey(pair.publicKey)),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

function bytesOf(text: string): Bytes {
  const bytes = base64UrlDecode(text);
  if (bytes === null) throw new Error('Not base64url');
  return bytes;
}

function join(...parts: Uint8Array[]): Bytes {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function derive(salt: Bytes, secret: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8),
  );
}

/** Decrypts an aes128gcm push message body. Throws when it was not made for this subscriber. */
export async function decryptPushBody(body: Uint8Array, subscriber: Subscriber): Promise<Bytes> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const keyIdLength = body[20];
  if (keyIdLength !== 65) throw new Error('The key id is not a P-256 public key');
  if (body.byteLength > recordSize) throw new Error('More than one record');
  const senderPublic = body.slice(21, 21 + keyIdLength);
  const record = body.slice(21 + keyIdLength);

  const senderKey = await crypto.subtle.importKey(
    'raw',
    senderPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await deriveSharedSecret(subscriber.privateKey, senderKey);
  const inputKey = await derive(
    bytesOf(subscriber.auth),
    shared,
    join(utf8('WebPush: info\0'), bytesOf(subscriber.p256dh), senderPublic),
    32,
  );
  const contentKey = await derive(salt, inputKey, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await derive(salt, inputKey, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, record),
  );
  // The plaintext ends with the delimiter of the last record (2) and optional zero padding.
  let end = padded.byteLength - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (padded[end] !== 2) throw new Error('No last-record delimiter');
  return padded.slice(0, end);
}
