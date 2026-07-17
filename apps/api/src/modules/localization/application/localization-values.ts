import { createHash } from 'node:crypto';

export type CanonicalJson =
  boolean | null | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

export function canonicalJsonHash(value: CanonicalJson): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function stableJson(value: CanonicalJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(',')}}`;
}

/** Produces an RFC-4122-shaped, deterministic UUID from a scoped identity. */
export function deterministicLocalizationUuid(identity: string): string {
  const bytes = createHash('sha256').update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeOptionalEditorialText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.normalize('NFC').trim();
  return normalized || null;
}

export function normalizeRequiredEditorialText(value: string, label: string): string {
  const normalized = value.normalize('NFC').trim();
  if (!normalized) throw new Error(`${label} cannot be blank.`);
  return normalized;
}

export function normalizeGlossarySourceTerm(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

export function glossaryComparisonKey(sourceTerm: string, caseSensitive: boolean): string {
  return caseSensitive ? sourceTerm : sourceTerm.toLowerCase();
}
