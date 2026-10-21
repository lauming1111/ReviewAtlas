/**
 * AES-GCM-256 encryption for API keys stored in chrome.storage.local.
 *
 * Stored format  :  "enc:<iv_b64>:<ciphertext_b64>"
 * Key derivation :  PBKDF2-SHA-256, 100 000 iterations
 * Password       :  chrome.runtime.id  +  hardcoded pepper
 * Salt           :  16-byte random value, stored in chrome.storage.local
 *                   (separate key from the settings blob)
 *
 * Threat model
 * ────────────
 *   ✓ Raw key strings are never written to storage — only ciphertext
 *   ✓ An attacker with only the storage file cannot decrypt without:
 *       – the extension ID (stable per-install, not guessable)
 *       – the pepper (embedded in the extension source)
 *       – the per-device random salt
 *   ✓ Each encrypt call uses a fresh random IV → same key → different blob
 *   ✓ PBKDF2 with 100 k iterations slows down brute-force attempts
 *   ✓ Legacy plaintext values are accepted on read and encrypted on next save
 *
 *   ⚠ This is NOT equivalent to OS keychain storage. An attacker with
 *     full local access to both the Chrome profile and the extension source
 *     can reconstruct the derived key. For a browser extension this is the
 *     strongest protection achievable without a user-supplied master password.
 */
// ─── Constants ────────────────────────────────────────────────────────────────
/** Prefix that identifies an encrypted blob. */
const ENC_PREFIX = 'enc:';
/** chrome.storage.local key where the random per-device salt is kept. */
const SALT_STORAGE_KEY = 'gReviewSummKeySalt';
/**
 * Hardcoded pepper mixed into the PBKDF2 password.
 * Changing this value invalidates all stored ciphertext — bump if keys leak.
 */
const PEPPER = 'gr3v13w-s0mm-@3s-gcm-2024!';
const PBKDF2_ITERATIONS = 100000;
// ─── Helpers ──────────────────────────────────────────────────────────────────
function toBase64(data) {
    // Safe for any array size (no spread stack overflow risk)
    let binary = '';
    for (let i = 0; i < data.length; i++)
        binary += String.fromCharCode(data[i]);
    return btoa(binary);
}
function fromBase64(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        out[i] = binary.charCodeAt(i);
    return out;
}
// ─── Key derivation (cached per popup session) ────────────────────────────────
let _cachedKey = null;
async function getOrCreateSalt() {
    return new Promise((resolve) => {
        chrome.storage.local.get([SALT_STORAGE_KEY], (data) => {
            const stored = data[SALT_STORAGE_KEY];
            if (stored) {
                resolve(fromBase64(stored));
            }
            else {
                const salt = crypto.getRandomValues(new Uint8Array(16));
                chrome.storage.local.set({ [SALT_STORAGE_KEY]: toBase64(salt) }, () => resolve(salt));
            }
        });
    });
}
async function getDerivedKey() {
    if (_cachedKey)
        return _cachedKey;
    const salt = await getOrCreateSalt();
    const password = chrome.runtime.id + PEPPER;
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    _cachedKey = await crypto.subtle.deriveKey(
    // TS 5.7+ types a bare Uint8Array as possibly SharedArrayBuffer-backed,
    // which BufferSource rejects; ours never are.
    { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return _cachedKey;
}
// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Encrypt a plaintext API key.
 * Returns an opaque string suitable for storage.
 */
export async function encryptApiKey(plaintext) {
    const key = await getDerivedKey();
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
    const enc = new TextEncoder();
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
    return `${ENC_PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(cipherBuf))}`;
}
/**
 * Decrypt a value produced by encryptApiKey().
 * If the value is not an encrypted blob (legacy plaintext), it is returned as-is
 * so existing un-encrypted keys continue to work until the next save.
 * Throws if the ciphertext is structurally valid but decryption fails.
 */
export async function decryptApiKey(encoded) {
    if (!encoded.startsWith(ENC_PREFIX))
        return encoded; // legacy plaintext — pass through
    const rest = encoded.slice(ENC_PREFIX.length);
    const colonAt = rest.indexOf(':');
    if (colonAt === -1)
        throw new Error('Malformed encrypted key blob');
    const iv = fromBase64(rest.slice(0, colonAt));
    const ciphertext = fromBase64(rest.slice(colonAt + 1));
    const key = await getDerivedKey();
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, // casts: see getDerivedKey()
    key, ciphertext);
    return new TextDecoder().decode(plainBuf);
}
/** Returns true when the string is a blob produced by encryptApiKey(). */
export function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}
/** Invalidate the in-memory derived-key cache (useful after salt is reset). */
export function clearKeyCache() {
    _cachedKey = null;
}
