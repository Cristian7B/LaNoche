import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export type WhatsAppRecipient = { to: string } | { recipient: string };

export class GraphResponseError extends ServiceUnavailableException {
  constructor(
    readonly operation: 'consultar_medio' | 'descargar_medio' | 'enviar_respuesta',
    readonly httpStatus: number,
    readonly graphCode?: number,
    readonly graphSubcode?: number,
  ) {
    super('Meta rechazó una solicitud de WhatsApp.');
  }
}

@Injectable()
export class GraphClient {
  private baseUrl() {
    return `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION ?? 'v25.0'}`;
  }

  async download(mediaId: string) {
    const token = process.env.WA_ACCESS_TOKEN;
    if (!token) throw new Error('WA_ACCESS_TOKEN is required');
    const metadataResponse = await fetch(`${this.baseUrl()}/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!metadataResponse.ok) throw await this.responseError(metadataResponse, 'consultar_medio');
    const metadata = await metadataResponse.json() as { url?: string; mime_type?: string; file_size?: number };
    if (!metadata.url) throw new ServiceUnavailableException('Meta did not return a media URL');
    if (metadata.file_size !== undefined && metadata.file_size > 2 * 1024 * 1024) throw new Error('WhatsApp sticker exceeds 2 MB');
    const mediaUrl = new URL(metadata.url);
    if (mediaUrl.protocol !== 'https:' || !(mediaUrl.hostname === 'graph.facebook.com' || mediaUrl.hostname.endsWith('.fbcdn.net') || mediaUrl.hostname.endsWith('.fbsbx.com'))) {
      throw new ServiceUnavailableException('Meta media URL was not trusted');
    }
    const response = await fetch(mediaUrl, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new GraphResponseError('descargar_medio', response.status);
    const maximum = 2 * 1024 * 1024;
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maximum) throw new Error('WhatsApp sticker exceeds 2 MB');
    if (!response.body) throw new ServiceUnavailableException('Meta media response is empty');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const part = Buffer.from(chunk);
      size += part.length;
      if (size > maximum) throw new Error('WhatsApp sticker exceeds 2 MB');
      chunks.push(part);
    }
    const data = Buffer.concat(chunks, size);
    return { data, mimeType: metadata.mime_type ?? response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  async sendText(recipient: WhatsAppRecipient, body: string) {
    const token = process.env.WA_ACCESS_TOKEN;
    const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) throw new Error('WhatsApp Graph credentials are required');
    const response = await fetch(`${this.baseUrl()}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...recipient,
        type: 'text', text: { body, preview_url: true } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw await this.responseError(response, 'enviar_respuesta');
    // A response body that cannot be read must not trigger another send after a successful HTTP status.
    const result = await response.json().catch(() => null) as { messages?: { id?: unknown }[] } | null;
    const messageId = result?.messages?.[0]?.id;
    return typeof messageId === 'string' ? messageId : undefined;
  }

  private async responseError(response: Response, operation: GraphResponseError['operation']) {
    const result = await response.json().catch(() => null) as { error?: { code?: unknown; error_subcode?: unknown } } | null;
    const code = result?.error?.code;
    const subcode = result?.error?.error_subcode;
    return new GraphResponseError(operation, response.status, typeof code === 'number' ? code : undefined,
      typeof subcode === 'number' ? subcode : undefined);
  }
}
