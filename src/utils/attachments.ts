import type { Attachment } from '../types';

export function fileToAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        dataUrl: reader.result as string,
      });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function filesToAttachments(files: File[]): Promise<Attachment[]> {
  return Promise.all(files.map(fileToAttachment));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
