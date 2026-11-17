import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { RawDocument } from '../../shared/types.js';

export interface DocumentStore {
  store(filename: string, content: Buffer): Promise<RawDocument>;
  retrieve(hash: string): Promise<Buffer>;
  exists(hash: string): Promise<boolean>;
}

export class LocalDocumentStore implements DocumentStore {
  constructor(private basePath: string) {
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true });
    }
  }

  async store(filename: string, content: Buffer): Promise<RawDocument> {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const docPath = this.getPath(hash);
    
    if (!fs.existsSync(docPath)) {
      fs.writeFileSync(docPath, content);
    }

    const mimeType = this.getMimeType(filename);
    
    return {
      hash,
      filename,
      mimeType,
      uploadedAt: Date.now(),
      sizeBytes: content.length,
    };
  }

  async retrieve(hash: string): Promise<Buffer> {
    const docPath = this.getPath(hash);
    if (!fs.existsSync(docPath)) {
      throw new Error(`Document not found: ${hash}`);
    }
    return fs.readFileSync(docPath);
  }

  async exists(hash: string): Promise<boolean> {
    return fs.existsSync(this.getPath(hash));
  }

  deleteFile(hash: string): void {
    const prefix = hash.substring(0, 2);
    const docPath = path.join(this.basePath, prefix, hash);
    if (fs.existsSync(docPath)) fs.unlinkSync(docPath);
  }

  private getPath(hash: string): string {
    const prefix = hash.substring(0, 2);
    const dir = path.join(this.basePath, prefix);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, hash);
  }

  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.csv': 'text/csv',
      '.ofx': 'application/x-ofx',
      '.qfx': 'application/x-ofx',
      '.pdf': 'application/pdf',
      '.eml': 'message/rfc822',
      '.txt': 'text/plain',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }
}
