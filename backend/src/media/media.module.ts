import { Module } from '@nestjs/common';
import { MediaService } from './media.service.js';
import { StorageService } from './storage.service.js';

@Module({ providers: [MediaService, StorageService], exports: [MediaService, StorageService] })
export class MediaModule {}
