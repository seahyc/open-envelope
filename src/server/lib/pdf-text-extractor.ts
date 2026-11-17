import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import pdfParse from 'pdf-parse';

const execFileAsync = promisify(execFile);

export function isPdfBuffer(content: Buffer): boolean {
  return content.length >= 4 && content.subarray(0, 4).toString('utf-8') === '%PDF';
}

export async function extractTextForDetection(content: Buffer): Promise<string> {
  if (isPdfBuffer(content)) {
    return extractPdfText(content);
  }
  return content.toString('utf-8', 0, Math.min(8000, content.length));
}

export async function extractStatementText(content: Buffer): Promise<string> {
  if (isPdfBuffer(content)) {
    return extractPdfText(content);
  }
  return content.toString('utf-8');
}

export async function extractPdfText(content: Buffer): Promise<string> {
  try {
    const tmpPath = join(tmpdir(), `pdf-${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`);
    await writeFile(tmpPath, content);

    try {
      const { stdout } = await execFileAsync('pdftotext', ['-layout', tmpPath, '-'], {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000
      });
      await unlink(tmpPath);
      return stdout;
    } catch (pdftotextError) {
      await unlink(tmpPath).catch(() => {});
      
      throw pdftotextError;
    }
  } catch {
    try {
      const pdf = await pdfParse(content);
      return pdf.text;
    } catch {
      return '';
    }
  }
}
