import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class StorageService {
  private client?: SupabaseClient;

  async upload(path: string, data: Buffer, contentType: string) {
    const { error } = await this.getClient().storage.from(process.env.SUPABASE_STORAGE_BUCKET ?? 'Candidatos')
      .upload(path, data, { contentType, cacheControl: '31536000', upsert: false });
    if (error) throw new ServiceUnavailableException({ code: 'STORAGE_UNAVAILABLE', message: 'No se pudo guardar el medio.' });
    return { path, url: this.publicUrl(path) };
  }

  async remove(paths: string[]) {
    if (paths.length === 0) return;
    const { error } = await this.getClient().storage.from(process.env.SUPABASE_STORAGE_BUCKET ?? 'Candidatos').remove(paths);
    if (error) throw new ServiceUnavailableException({ code: 'STORAGE_UNAVAILABLE', message: 'No se pudo limpiar el medio.' });
  }

  publicUrl(path: string) {
    const base = process.env.STORAGE_PUBLIC_BASE_URL;
    if (!base) throw new Error('STORAGE_PUBLIC_BASE_URL is required');
    const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'Candidatos';
    const publicBase = new URL(base);
    const publicStoragePrefix = '/storage/v1/object/public/';
    const prefixIndex = publicBase.pathname.indexOf(publicStoragePrefix);
    if (prefixIndex >= 0) {
      publicBase.pathname = `${publicBase.pathname.slice(0, prefixIndex + publicStoragePrefix.length)}${encodeURIComponent(bucket)}`;
    }
    return `${publicBase.toString().replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  private getClient() {
    if (!this.client) {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SECRET_KEY;
      if (!url || !key) throw new Error('Supabase storage credentials are required');
      this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    }
    return this.client;
  }
}
