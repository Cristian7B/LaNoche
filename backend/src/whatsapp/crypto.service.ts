import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';

@Injectable()
export class CryptoService {
  private key() {
    const value = process.env.WA_TOKEN_ENCRYPTION_KEY;
    if (!value) throw new Error('WA_TOKEN_ENCRYPTION_KEY is required');
    const key = Buffer.from(value, 'base64url');
    if (key.length !== 32) throw new Error('WA_TOKEN_ENCRYPTION_KEY must encode 32 bytes');
    return key;
  }

  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  decrypt(value: string) {
    const bytes = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }

  hashToken(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  hashSender(value: string) {
    const pepper = process.env.WA_HASH_PEPPER;
    if (!pepper) throw new Error('WA_HASH_PEPPER is required');
    return createHmac('sha256', pepper).update(value).digest('hex');
  }
}
