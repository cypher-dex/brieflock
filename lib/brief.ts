/**
 * BriefLock: the sellable "product" that sits on top of the Fiber pay-to-unlock flow.
 *
 * A brief has a PUBLIC part (title, author, teaser, price, fingerprint) that travels in the
 * offer in clear text, and a SECRET part (full text + optional file) that is encrypted with
 * the key that Fiber reveals as the payment preimage.
 */

export const MIN_PRICE_CKB = 1;
export const MAX_PRICE_CKB = 20; // Bottle only holds 150 CKB of spendable balance on the seller side.
export const MAX_FILE_BYTES = 100 * 1024; // keeps the offer JSON small enough to copy by hand.
export const MAX_TITLE = 80;
export const MAX_AUTHOR = 40;
export const MAX_TEASER = 400;

export type BriefPublic = {
  title: string;
  author: string;
  teaser: string;
  priceCkb: number;
  /** SHA-256 of the exact secret payload, published before payment. */
  contentHash: `0x${string}`;
  /** Only name and size of the attachment are public; its bytes are encrypted. */
  file?: { name: string; size: number };
};

export type BriefFile = { name: string; type: string; base64: string };
export type BriefSecret = { body: string; file?: BriefFile };

export type BriefDraft = {
  title: string;
  author: string;
  teaser: string;
  priceCkb: number;
  body: string;
  file?: BriefFile;
};

const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

/** Stable serialization: the same draft always produces the same string (and hash). */
export function serializeSecret(secret: BriefSecret) {
  return JSON.stringify(secret.file ? { body: secret.body, file: secret.file } : { body: secret.body });
}

export function parseSecret(text: string): BriefSecret {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Unlocked content is not a brief.');
  const { body, file } = value as { body?: unknown; file?: unknown };
  if (typeof body !== 'string') throw new Error('Unlocked content is missing its text.');
  if (file === undefined) return { body };
  if (typeof file !== 'object' || file === null) throw new Error('Unlocked attachment is malformed.');
  const { name, type, base64 } = file as Record<string, unknown>;
  if (typeof name !== 'string' || typeof type !== 'string' || typeof base64 !== 'string') {
    throw new Error('Unlocked attachment is malformed.');
  }
  return { body, file: { name, type, base64 } };
}

export function base64Size(base64: string) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export function priceToShannons(priceCkb: number) {
  return BigInt(priceCkb) * 100_000_000n;
}

export function formatCkb(shannons: bigint) {
  const whole = shannons / 100_000_000n;
  const fraction = (shannons % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KB`;
}

/** Returns a human readable problem, or null when the draft can be sold. */
export function draftProblem(draft: BriefDraft): string | null {
  if (!draft.title.trim()) return 'Add a title.';
  if (draft.title.length > MAX_TITLE) return `Title is limited to ${MAX_TITLE} characters.`;
  if (draft.author.length > MAX_AUTHOR) return `Author is limited to ${MAX_AUTHOR} characters.`;
  if (!draft.teaser.trim()) return 'Add a free preview so buyers know what they are paying for.';
  if (draft.teaser.length > MAX_TEASER) return `Preview is limited to ${MAX_TEASER} characters.`;
  if (!Number.isInteger(draft.priceCkb) || draft.priceCkb < MIN_PRICE_CKB || draft.priceCkb > MAX_PRICE_CKB) {
    return `Price must be a whole number between ${MIN_PRICE_CKB} and ${MAX_PRICE_CKB} CKB.`;
  }
  if (!draft.body.trim()) return 'Add the full brief that will be locked.';
  if (draft.file && base64Size(draft.file.base64) > MAX_FILE_BYTES) {
    return `Attachment is limited to ${formatBytes(MAX_FILE_BYTES)}.`;
  }
  return null;
}

export async function buildPublicPart(draft: BriefDraft): Promise<{ publicPart: BriefPublic; secret: string }> {
  const problem = draftProblem(draft);
  if (problem) throw new Error(problem);
  const secret = serializeSecret({ body: draft.body, file: draft.file });
  const publicPart: BriefPublic = {
    title: draft.title.trim(),
    author: draft.author.trim(),
    teaser: draft.teaser.trim(),
    priceCkb: draft.priceCkb,
    contentHash: await sha256Hex(secret),
    ...(draft.file ? { file: { name: draft.file.name, size: base64Size(draft.file.base64) } } : {}),
  };
  return { publicPart, secret };
}

/** Buyer side: validate the public part of a pasted offer. */
export function parseBriefPublic(value: unknown): BriefPublic {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Offer is missing its brief preview.');
  const brief = value as Record<string, unknown>;
  const text = (field: string, max: number, required: boolean) => {
    const entry = brief[field];
    if (typeof entry !== 'string' || (required && !entry.trim()) || entry.length > max) {
      throw new Error(`Offer ${field} is missing or too long.`);
    }
    return entry;
  };
  const priceCkb = brief.priceCkb;
  if (typeof priceCkb !== 'number' || !Number.isInteger(priceCkb) || priceCkb < MIN_PRICE_CKB || priceCkb > MAX_PRICE_CKB) {
    throw new Error(`Offer price must be a whole number between ${MIN_PRICE_CKB} and ${MAX_PRICE_CKB} CKB.`);
  }
  const contentHash = brief.contentHash;
  if (typeof contentHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(contentHash)) {
    throw new Error('Offer content fingerprint is missing.');
  }
  let file: BriefPublic['file'];
  if (brief.file !== undefined) {
    const entry = brief.file as Record<string, unknown> | null;
    if (!entry || typeof entry.name !== 'string' || typeof entry.size !== 'number' || entry.size < 0 || entry.size > MAX_FILE_BYTES) {
      throw new Error('Offer attachment details are malformed.');
    }
    file = { name: entry.name.slice(0, 120), size: entry.size };
  }
  return {
    title: text('title', MAX_TITLE, true),
    author: text('author', MAX_AUTHOR, false),
    teaser: text('teaser', MAX_TEASER, true),
    priceCkb,
    contentHash: contentHash.toLowerCase() as `0x${string}`,
    ...(file ? { file } : {}),
  };
}

/** Buyer side, after unlocking: the text must match the fingerprint published before payment. */
export async function verifyFingerprint(decryptedText: string, publicPart: BriefPublic) {
  return (await sha256Hex(decryptedText)) === publicPart.contentHash.toLowerCase();
}
