import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import type { Request } from 'express';
import { rm } from 'node:fs/promises';
import { finalize } from 'rxjs';

@Injectable()
export class UploadedFilesCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>();
    return next.handle().pipe(finalize(() => {
      const files = Array.isArray(request.files) ? request.files
        : request.files && typeof request.files === 'object' ? Object.values(request.files).flat() : [];
      void Promise.all(files.map((file) => rm(file.path, { force: true }).catch(() => undefined)));
    }));
  }
}
