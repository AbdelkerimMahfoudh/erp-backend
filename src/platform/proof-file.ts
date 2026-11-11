/**
 * How a payment proof's file is named and served (0136, owner 2026-11-11).
 *
 * Every proof was served as `payment-proof` with no extension, so a computer could not tell a PNG from anything else
 * and opened nothing. The type was always right: it is sniffed from the bytes at upload (PDF, PNG or JPEG only). Now the
 * file keeps the name it was sent with, made safe, and its extension always matches the type its bytes say; a proof
 * stored before 0136 is named from its date and that type. The type served is the one the bytes say again on every read,
 * so a stored type that was ever wrong cannot reach the browser.
 */

export const PROOF_TYPES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' } as const;
export type ProofType = keyof typeof PROOF_TYPES;

/** The type the bytes say: PDF, PNG or JPEG — or null for anything else. */
export function sniffProofType(buffer: Buffer | Uint8Array): ProofType | null {
  const b = Buffer.from(buffer);
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * The name to keep: the sent name's last path part, control characters, quotes and path separators removed, spaces
 * collapsed, at most 100 characters before the extension — and the extension replaced by the one the type calls for.
 * No usable name: null (the served name is then built from the date).
 */
export function safeProofName(original: string | undefined | null, type: ProofType): string | null {
  if (!original) return null;
  const last = String(original).split(/[\\/]/).pop() ?? '';
  const stem = last
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f"<>:|?*;]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/^\.+/, '');
  return stem ? `${stem}.${PROOF_TYPES[type]}` : null;
}

/** The name a proof is served under: its kept name, or `payment-proof-YYYY-MM-DD-<id>.<ext>`. */
export function servedProofName(p: { id: string; fileName: string | null; submittedAt: Date }, type: ProofType | null): string {
  if (p.fileName && type && p.fileName.toLowerCase().endsWith(`.${PROOF_TYPES[type]}`)) return p.fileName;
  const ext = type ? PROOF_TYPES[type] : 'bin';
  return `payment-proof-${p.submittedAt.toISOString().slice(0, 10)}-${p.id.slice(-8)}.${ext}`;
}

/** `attachment` with an ASCII fallback name and the exact name in UTF-8 (RFC 6266 / 5987), so Arabic names survive. */
export function contentDisposition(name: string, inline = false): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
