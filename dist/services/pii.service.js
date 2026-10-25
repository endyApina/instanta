"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptPii = encryptPii;
exports.piiLookupHash = piiLookupHash;
exports.decryptPii = decryptPii;
const node_crypto_1 = require("node:crypto");
const app_error_1 = require("../errors/app-error");
function encryptionKey() {
    const value = process.env.PII_ENCRYPTION_KEY;
    if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
        throw new app_error_1.AppError(503, "PII_ENCRYPTION_NOT_CONFIGURED", "PII encryption is not configured");
    }
    return Buffer.from(value, "hex");
}
function encryptPii(value) {
    const iv = (0, node_crypto_1.randomBytes)(12);
    const cipher = (0, node_crypto_1.createCipheriv)("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
}
function piiLookupHash(value) {
    // Domain separation keeps blind lookup indexes distinct from encryption use.
    return (0, node_crypto_1.createHmac)("sha256", encryptionKey()).update(`instanta-lookup-v1:${value}`).digest("hex");
}
function decryptPii(value) {
    const [ivText, tagText, dataText] = value.split(".");
    if (!ivText || !tagText || !dataText) {
        throw new app_error_1.AppError(500, "INVALID_ENCRYPTED_PII", "Stored identity data is invalid");
    }
    const decipher = (0, node_crypto_1.createDecipheriv)("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([
        decipher.update(Buffer.from(dataText, "base64")),
        decipher.final(),
    ]).toString("utf8");
}
