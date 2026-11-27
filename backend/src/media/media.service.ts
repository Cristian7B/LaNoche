import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { fileTypeFromFile } from 'file-type';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp, { type OutputInfo } from 'sharp';
import pLimit from 'p-limit';

const execFileAsync = promisify(execFile);
const videoLimit = pLimit(2);

export interface ProcessedMedia {
  position: number;
  kind: 'image' | 'video';
  mimeType: string;
  extension: 'webp' | 'mp4';
  data: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
  durationMs: number | null;
  sizeBytes: number;
}

@Injectable()
export class MediaService {
  async process(files: Express.Multer.File[], category: 'photo' | 'sticker'): Promise<ProcessedMedia[]> {
    if (files.length < 1 || files.length > (category === 'photo' ? Number(process.env.MAX_IMAGES_PER_PHOTO ?? 10) : 1)) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Cantidad de archivos no válida.' });
    }
    const maxBytes = category === 'photo' ? Number(process.env.MAX_IMAGE_BYTES ?? 10_485_760) : Number(process.env.MAX_STICKER_BYTES ?? 10_485_760);
    const results: ProcessedMedia[] = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (file.size > maxBytes) throw new UnprocessableEntityException({ code: 'MEDIA_INVALID', message: 'El archivo supera el tamaño permitido.' });
      const detected = await fileTypeFromFile(file.path);
      if (!detected) throw this.invalidMedia();
      const maxDurationMs = 10_000;
      if (category === 'photo') {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(detected.mime)) throw this.invalidMedia();
        let output: { data: Buffer; info: OutputInfo };
        try {
          output = await sharp(file.path, { failOn: 'error' }).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
        } catch { throw this.invalidMedia(); }
        const thumbnail = await sharp(output.data).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
        results.push({ position: index + 1, kind: 'image', mimeType: 'image/webp', extension: 'webp', data: output.data, thumbnail, width: output.info.width, height: output.info.height, durationMs: null, sizeBytes: output.data.length });
        continue;
      }
      const accepted = ['image/webp', 'image/png', 'image/jpeg', 'image/gif', 'video/mp4', 'video/webm'];
      if (!accepted.includes(detected.mime)) throw this.invalidMedia();
      const metadata = await sharp(file.path, { animated: true, failOn: 'error' }).metadata().catch(() => null);
      const animatedImage = (metadata?.pages ?? 1) > 1;
      const video = detected.mime.startsWith('video/');
      if (!animatedImage && !video) {
        let output: { data: Buffer; info: OutputInfo };
        try {
          output = await sharp(file.path, { failOn: 'error' }).resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
        } catch { throw this.invalidMedia(); }
        const thumbnail = await sharp(output.data).resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
        results.push({ position: 1, kind: 'image', mimeType: 'image/webp', extension: 'webp', data: output.data, thumbnail, width: output.info.width, height: output.info.height, durationMs: null, sizeBytes: output.data.length });
        continue;
      }
      const processed = await videoLimit(() => this.convertStickerVideo(file.path, animatedImage, metadata?.delay));
      if (processed.durationMs > maxDurationMs) throw this.invalidMedia();
      results.push({ position: 1, kind: 'video', mimeType: 'video/mp4', extension: 'mp4', data: processed.data, thumbnail: processed.thumbnail, width: processed.width, height: processed.height, durationMs: processed.durationMs, sizeBytes: processed.data.length });
    }
    return results;
  }

  private async convertStickerVideo(input: string, animatedImage: boolean, frameDelays?: number[]) {
    const tempDir = await mkdtemp(join(tmpdir(), 'gala-media-'));
    const outputPath = join(tempDir, `${randomUUID()}.mp4`);
    const thumbnailPath = join(tempDir, `${randomUUID()}.png`);
    try {
      const bg = process.env.MEDIA_STICKER_BG ?? '#FFFFFF';
      let durationMs: number;
      if (animatedImage) {
        const imageMeta = await sharp(input, { animated: true, failOn: 'error' }).metadata();
        const pages = imageMeta.pages ?? 1;
        const delays = Array.from({ length: pages }, (_, index) => Math.max(20, frameDelays?.[index] ?? 100));
        durationMs = delays.reduce((sum, delay) => sum + delay, 0);
        if (pages < 2 || durationMs > 10_000) throw this.invalidMedia();
        const framePaths: string[] = [];
        for (let index = 0; index < pages; index++) {
          const framePath = join(tempDir, `frame-${String(index).padStart(4, '0')}.png`);
          await sharp(input, { page: index, pages: 1, failOn: 'error' })
            .resize({ width: 512, height: 512, fit: 'contain', background: bg })
            .flatten({ background: bg }).png().toFile(framePath);
          framePaths.push(framePath);
        }
        const concatPath = join(tempDir, 'frames.txt');
        const concat = framePaths.map((path, index) => `file '${path.replace(/\\/g, '/')}'\nduration ${(delays[index] / 1000).toFixed(3)}`).join('\n')
          + `\nfile '${framePaths.at(-1)!.replace(/\\/g, '/')}'\n`;
        await writeFile(concatPath, concat);
        await execFileAsync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-vsync', 'vfr', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-preset', 'veryfast', '-movflags', '+faststart', outputPath], { timeout: 30_000, windowsHide: true });
        await sharp(framePaths[0]).resize({ width: 256, height: 256, fit: 'inside' }).png().toFile(thumbnailPath);
      } else {
        const probe = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input], { timeout: 5_000, windowsHide: true });
        durationMs = Math.ceil(Number(probe.stdout.trim()) * 1000);
        if (!Number.isFinite(durationMs) || durationMs > 10_000) throw this.invalidMedia();
        const filter = `[0:v]scale=w=512:h=512:force_original_aspect_ratio=decrease:force_divisible_by=2,format=rgba[fg];color=c=${bg}:s=512x512[bg];[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1:format=auto,format=yuv420p[v]`;
        await execFileAsync('ffmpeg', ['-y', '-i', input, '-filter_complex', filter, '-map', '[v]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-preset', 'veryfast', '-movflags', '+faststart', outputPath], { timeout: 30_000, windowsHide: true });
        await execFileAsync('ffmpeg', ['-y', '-i', input, '-filter_complex', filter, '-map', '[v]', '-frames:v', '1', thumbnailPath], { timeout: 30_000, windowsHide: true });
      }
      const data = await readFile(outputPath);
      const thumbnail = await sharp(thumbnailPath).webp({ quality: 75 }).toBuffer();
      const width = 512;
      const height = 512;
      return { data, thumbnail, width, height, durationMs };
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      throw new UnprocessableEntityException({ code: 'MEDIA_INVALID', message: 'No se pudo procesar el sticker animado.' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private invalidMedia() {
    return new UnprocessableEntityException({ code: 'MEDIA_INVALID', message: 'El contenido del archivo no coincide con un formato permitido.' });
  }
}
