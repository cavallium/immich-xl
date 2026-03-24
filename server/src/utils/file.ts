import { HttpException, StreamableFile } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { access, constants } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';
import { CacheControl } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { ImmichReadStream } from 'src/repositories/storage.repository';
import { isConnectionAborted } from 'src/utils/misc';
import sharp from 'sharp';
import { spawn } from 'node:child_process';

export function getFileNameWithoutExtension(path: string): string {
  return basename(path, extname(path));
}

export function getFilenameExtension(path: string): string {
  return extname(path);
}

export function getLivePhotoMotionFilename(stillName: string, motionName: string) {
  return getFileNameWithoutExtension(stillName) + extname(motionName);
}

export class ImmichFileResponse {
  public readonly path!: string;
  public readonly contentType!: string;
  public readonly cacheControl!: CacheControl;
  public readonly fileName?: string;

  constructor(response: ImmichFileResponse) {
    Object.assign(this, response);
  }
}
type SendFile = Parameters<Response['sendFile']>;
type SendFileOptions = SendFile[1];

const cacheControlHeaders: Record<CacheControl, string | null> = {
  [CacheControl.PrivateWithCache]: 'private, max-age=86400, no-transform',
  [CacheControl.PrivateWithoutCache]: 'private, no-cache, no-transform',
  [CacheControl.None]: null, // falsy value to prevent adding Cache-Control header
};

export const sendFile = async (
  res: Response,
  next: NextFunction,
  handler: () => Promise<ImmichFileResponse>,
  logger: LoggingRepository,
): Promise<void> => {
  // promisified version of 'res.sendFile' for cleaner async handling
  const _sendFile = (path: string, options: SendFileOptions) =>
    promisify<string, SendFileOptions>(res.sendFile).bind(res)(path, options);

  try {
    const file = await handler();
    const cacheControlHeader = cacheControlHeaders[file.cacheControl];
    if (cacheControlHeader) {
      // set the header to Cache-Control
      res.set('Cache-Control', cacheControlHeader);
    }

    res.header('Content-Type', file.contentType);
    if (file.fileName) {
      res.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    }

    await access(file.path, constants.R_OK);

    // If we are serving a JPEG but the stored file is a JXL, transcode on-the-fly.
    // Prefer djxl (JPEG reconstruction) for truly lossless and very fast conversion when available,
    // otherwise fall back to sharp.
    const isJxlOnDisk = extname(file.path).toLowerCase() === '.jxl';
    const wantsJpeg = file.contentType === 'image/jpeg';
    if (isJxlOnDisk && wantsJpeg) {
      try {
        const usedDjxl = await new Promise<boolean>((resolve) => {
          let resolved = false;
          // Try djxl first for lossless JPEG reconstruction
          const djxl = spawn('djxl', ['--jpeg', file.path, '-']);
          djxl.on('error', (err) => {
            // djxl not found or failed to start
            logger.debug?.(`djxl not available or failed to start: ${err?.message || err}` as any);
            if (!resolved) {
              resolved = true;
              resolve(false);
            }
          });
          djxl.stderr.on('data', (chunk) => {
            // If djxl reports an error about missing JPEG reconstruction box, we'll handle on close with non-zero code
            logger.debug?.(chunk.toString() as any);
          });
          djxl.on('close', (code) => {
            if (!resolved) {
              resolved = true;
              resolve(code === 0);
            }
          });
          // Pipe stdout to response
          djxl.stdout.on('error', () => {
            // ignore, will resolve on close
          });
          res.on('close', () => {
            try {
              djxl.kill('SIGKILL');
            } catch {}
          });
          djxl.stdout.pipe(res, { end: true });
        });

        if (usedDjxl) {
          return;
        }

        // Fallback: use sharp decode->jpeg (may be lossy depending on settings)
        await new Promise<void>((resolve, reject) => {
          const transformer = sharp(file.path).jpeg();
          transformer.on('error', reject);
          res.on('close', resolve);
          transformer.pipe(res);
        });
        return;
      } catch (e: any) {
        logger.warn(`JXL→JPEG on-the-fly conversion failed, falling back to stored file: ${e?.message || e}`);
        if (!res.headersSent) {
          res.set('Content-Type', 'image/jxl');
        }
        return await _sendFile(file.path, { dotfiles: 'allow' });
      }
    }

    return await _sendFile(file.path, { dotfiles: 'allow' });
  } catch (error: Error | any) {
    // ignore client-closed connection
    if (isConnectionAborted(error) || res.headersSent) {
      return;
    }

    // log non-http errors
    if (error instanceof HttpException === false) {
      logger.error(`Unable to send file: ${error}`, error.stack);
    }

    res.header('Cache-Control', 'none');
    next(error);
  }
};

export const asStreamableFile = ({ stream, type, length }: ImmichReadStream) => {
  return new StreamableFile(stream, { type, length });
};
