import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPayload,
  generateFreshSecrets,
  generateVapidKeys,
  isVapidKeyPair,
  MAX_PLAINTEXT_BYTES,
  vapidAuthorization,
  type P256KeyPair,
} from './webPush.ts';
import { decryptPushBody, generateSubscriber } from './testing/pushReceiver.ts';

function decode(text: string): Uint8Array<ArrayBuffer> {
  const bytes = base64UrlDecode(text);
  if (bytes === null) throw new Error(`Not base64url: ${text}`);
  return bytes;
}

// RFC 8291, Appendix A and section 5: the example message with every intermediate value fixed.
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  senderPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  subscriberPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  subscriberPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function importPrivateKey(privateKey: string, publicKey: string): Promise<CryptoKey> {
  const point = decode(publicKey);
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: privateKey,
      x: base64UrlEncode(point.slice(1, 33)),
      y: base64UrlEncode(point.slice(33)),
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
}

describe('base64url', () => {
  it('round-trips bytes without padding', () => {
    const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255]);
    const text = base64UrlEncode(bytes);
    expect(text).toBe('APr7_P3-_w');
    expect(base64UrlDecode(text)).toEqual(bytes);
  });

  it('refuses padding, the standard alphabet and impossible lengths', () => {
    for (const text of ['AA==', 'a+b/', 'a b', 'A', 'AAAAA', 'é']) {
      expect(base64UrlDecode(text)).toBeNull();
    }
  });
});

describe('encryptPayload', () => {
  it('produces exactly the message of RFC 8291 Appendix A from its keys and salt', async () => {
    const senderPoint = decode(RFC8291.senderPublic);
    const keyPair: P256KeyPair = {
      privateKey: await importPrivateKey(RFC8291.senderPrivate, RFC8291.senderPublic),
      publicKey: await crypto.subtle.importKey(
        'raw',
        senderPoint,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        [],
      ),
    };

    const body = await encryptPayload(
      new TextEncoder().encode(RFC8291.plaintext),
      { p256dh: decode(RFC8291.subscriberPublic), auth: decode(RFC8291.auth) },
      { keyPair, salt: decode(RFC8291.salt) },
    );

    expect(base64UrlEncode(body)).toBe(RFC8291.body);
  });

  it('is read back by the receiving side of the RFC example', async () => {
    const plaintext = await decryptPushBody(decode(RFC8291.body), {
      privateKey: await importPrivateKey(RFC8291.subscriberPrivate, RFC8291.subscriberPublic),
      p256dh: RFC8291.subscriberPublic,
      auth: RFC8291.auth,
    });
    expect(new TextDecoder().decode(plaintext)).toBe(RFC8291.plaintext);
  });

  it('makes a different message every time, which only the subscriber can read', async () => {
    const subscriber = await generateSubscriber();
    const keys = { p256dh: decode(subscriber.p256dh), auth: decode(subscriber.auth) };
    const message = new TextEncoder().encode('{"title":"Demo App: site is down"}');

    const first = await encryptPayload(message, keys, await generateFreshSecrets());
    const second = await encryptPayload(message, keys, await generateFreshSecrets());

    expect(base64UrlEncode(first)).not.toBe(base64UrlEncode(second));
    expect(await decryptPushBody(first, subscriber)).toEqual(message);
    expect(await decryptPushBody(second, subscriber)).toEqual(message);
    const stranger = await generateSubscriber();
    await expect(decryptPushBody(first, stranger)).rejects.toThrow();
    // With the right key but another auth secret it cannot be read either.
    await expect(decryptPushBody(first, { ...subscriber, auth: stranger.auth })).rejects.toThrow();
  });

  it('refuses a message that does not fit one record, and keys of the wrong shape', async () => {
    const subscriber = await generateSubscriber();
    const keys = { p256dh: decode(subscriber.p256dh), auth: decode(subscriber.auth) };
    const fresh = await generateFreshSecrets();

    const largest = await encryptPayload(new Uint8Array(MAX_PLAINTEXT_BYTES), keys, fresh);
    expect(largest.byteLength).toBe(4096);
    await expect(
      encryptPayload(new Uint8Array(MAX_PLAINTEXT_BYTES + 1), keys, fresh),
    ).rejects.toThrow('at most');
    await expect(
      encryptPayload(new Uint8Array(1), { ...keys, auth: new Uint8Array(15) }, fresh),
    ).rejects.toThrow('auth');
    // 65 bytes that are not a point on the curve.
    const notAPoint = new Uint8Array(65).fill(1);
    notAPoint[0] = 4;
    await expect(
      encryptPayload(new Uint8Array(1), { ...keys, p256dh: notAPoint }, fresh),
    ).rejects.toThrow();
  });
});

describe('VAPID', () => {
  const claims = {
    audience: 'https://push.example.test',
    subject: 'https://status.example.test',
    now: new Date('2026-11-26T12:00:00.000Z'),
  };

  function parts(authorization: string): { token: string; key: string } {
    const match = /^vapid t=([A-Za-z0-9_.-]+), k=([A-Za-z0-9_-]+)$/.exec(authorization);
    if (!match?.[1] || !match[2]) throw new Error('Not a vapid Authorization header');
    return { token: match[1], key: match[2] };
  }

  function json(segment: string | undefined): unknown {
    return JSON.parse(new TextDecoder().decode(decode(segment ?? '')));
  }

  it('generates a pair in the stored form: a 65-byte point and a 32-byte scalar', async () => {
    const keys = await generateVapidKeys();
    expect(decode(keys.publicKey).byteLength).toBe(65);
    expect(decode(keys.publicKey)[0]).toBe(4);
    expect(decode(keys.privateKey).byteLength).toBe(32);
    expect(isVapidKeyPair(keys)).toBe(true);
  });

  it('recognises strings that are not a pair', async () => {
    const keys = await generateVapidKeys();
    expect(isVapidKeyPair({ ...keys, publicKey: keys.privateKey })).toBe(false);
    expect(isVapidKeyPair({ ...keys, privateKey: keys.publicKey })).toBe(false);
    expect(isVapidKeyPair({ ...keys, privateKey: `${keys.privateKey}=` })).toBe(false);
    expect(isVapidKeyPair({ publicKey: '', privateKey: '' })).toBe(false);
    await expect(vapidAuthorization({ publicKey: 'x', privateKey: 'y' }, claims)).rejects.toThrow(
      'malformed',
    );
  });

  it('signs an ES256 token that verifies with the public key in the header', async () => {
    const keys = await generateVapidKeys();
    const { token, key } = parts(await vapidAuthorization(keys, claims));
    expect(key).toBe(keys.publicKey);

    const [header, body, signature] = token.split('.');
    expect(token.split('.')).toHaveLength(3);
    expect(json(header)).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(json(body)).toEqual({
      aud: 'https://push.example.test',
      // Twelve hours ahead: inside the 24 hours a push service allows.
      exp: Date.parse('2026-11-27T00:00:00.000Z') / 1000,
      sub: 'https://status.example.test',
    });

    const verifyKey = await crypto.subtle.importKey(
      'raw',
      decode(key),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const verify = (signed: string) =>
      crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifyKey,
        decode(signature ?? ''),
        new TextEncoder().encode(signed),
      );
    expect(decode(signature ?? '').byteLength).toBe(64);
    expect(await verify(`${header}.${body}`)).toBe(true);
    expect(await verify(`${header}.${body}x`)).toBe(false);
  });

  it('does not verify with another pair', async () => {
    const keys = await generateVapidKeys();
    const other = await generateVapidKeys();
    const { token } = parts(await vapidAuthorization(keys, claims));
    const [header, body, signature] = token.split('.');
    const otherKey = await crypto.subtle.importKey(
      'raw',
      decode(other.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        otherKey,
        decode(signature ?? ''),
        new TextEncoder().encode(`${header}.${body}`),
      ),
    ).toBe(false);
  });
});
