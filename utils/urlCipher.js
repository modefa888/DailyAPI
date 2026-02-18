const crypto = require("crypto");

const DEFAULT_SECRET = "dailyapi-url-secret";
const SECRET = String(process.env.URL_CIPHER_SECRET || DEFAULT_SECRET);
const KEY = crypto.createHash("sha256").update(SECRET).digest();

function base64UrlEncode(buf) {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function base64UrlDecode(str) {
    const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + "=".repeat(padLength);
    return Buffer.from(padded, "base64");
}

function encryptUrl(plainUrl) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plainUrl), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return base64UrlEncode(Buffer.concat([iv, tag, ciphertext]));
}

function decryptUrl(token) {
    const buf = base64UrlDecode(String(token || ""));
    if (buf.length < 12 + 16 + 1) {
        throw new Error("Invalid encrypted url");
    }
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
}

module.exports = { encryptUrl, decryptUrl };
