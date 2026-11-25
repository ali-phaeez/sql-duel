// Room codes: 4 consonants. No vowels (no accidental words), no I/O (no 1/0 confusion).
export const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const CODE_LENGTH = 4;

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function generateCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    const idx = Math.min(CODE_ALPHABET.length - 1, Math.floor(random() * CODE_ALPHABET.length));
    out += CODE_ALPHABET[idx];
  }
  return out;
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidCode(code: string): boolean {
  return CODE_RE.test(code);
}
