import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger as RenderLogger, PinoLogger } from 'nestjs-pino';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { DB } from '../db/db.module.js';
import { EventService } from '../event/event.service.js';
import { MediaService } from '../media/media.service.js';
import { StorageService } from '../media/storage.service.js';
import { CryptoService } from './crypto.service.js';
import { GraphClient } from './graph-client.js';
import { WhatsappService } from './whatsapp.service.js';

const phone = '573000000123';
const incomingId = 'wamid.entrada';
const replyId = 'wamid.respuesta';
const incomingRef = createHash('sha256').update(incomingId).digest('hex').slice(0, 24);
const replyRef = createHash('sha256').update(replyId).digest('hex').slice(0, 24);
const privateText = 'Contenido privado del participante';
const logLines: string[] = [];
const pinoLogger = new PinoLogger({ pinoHttp: [{}, { write: (line: string) => logLines.push(line) }] });

const payload = (value: object) => ({ entry: [{ changes: [{ value }] }] });
const incomingMessage = { id: incomingId, from: phone, type: 'text', text: { body: privateText } };

async function createService() {
  const insert = vi.fn(() => ({
    values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: 7 }] }) }),
  }));
  const select = vi.fn(() => ({
    from: () => ({ where: async () => [{
      id: 7, messageId: incomingId, status: 'pending', senderCiphertext: 'dato-cifrado', messageType: 'text',
    }] }),
  }));
  const set = vi.fn(() => ({ where: () => ({ returning: async () => [{ id: 7, attempts: 1 }] }) }));
  const module = await Test.createTestingModule({
    providers: [
      WhatsappService,
      GraphClient,
      { provide: DB, useValue: { insert, select, update: () => ({ set }) } },
      { provide: EventService, useValue: { getEvent: async () => ({ effective_status: 'open' }) } },
      { provide: MediaService, useValue: {} },
      { provide: StorageService, useValue: {} },
      { provide: CryptoService, useValue: { hashSender: () => 'hash', encrypt: () => 'dato-cifrado', decrypt: () => phone } },
    ],
  }).setLogger(new RenderLogger(pinoLogger, {})).compile();
  return { module, service: module.get(WhatsappService), insert, set };
}

describe('Logs de WhatsApp', () => {
  afterEach(() => {
    logLines.length = 0;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterAll(() => Logger.overrideLogger(false));

  test('diagnostica el remitente ausente usando solo las claves del bloque correspondiente', async () => {
    const { module, service, insert } = await createService();
    try {
      const accepted = await pinoLogger.runInContext(() => service.accept({ entry: [{ changes: [
        { value: { contacts: [{ parent_user_id: 'otro-bloque' }] } },
        { value: { messages: [{ id: incomingId, type: 'text', text: { body: privateText }, from_user_id: 'CO.identificador' }],
          contacts: [{ wa_id: phone, profile: { name: 'nombre-privado' }, user_id: 'CO.identificador' }] } },
      ] }] }), { bindings: { req: { url: 'https://example.test/privado' } } });
      expect(accepted).toBe(0);
      expect(insert).not.toHaveBeenCalled();
      const line = logLines.find((line) => line.includes('WhatsApp: mensaje sin remitente'))!;
      expect(JSON.parse(line)).toMatchObject({
        messageKeys: ['from_user_id', 'id', 'text', 'type'], contactKeys: [['profile', 'user_id', 'wa_id']],
        hasMessageFrom: false, hasMessageFromUserId: true, hasContactWaId: true, hasContactParentUserId: false,
      });
      for (const value of [phone, privateText, incomingId, 'CO.identificador', 'nombre-privado', 'https://example.test/privado']) {
        expect(line).not.toContain(value);
      }
    } finally {
      await module.close();
    }
  });

  test('correlaciona recepción, persistencia, envío y entrega sin registrar el teléfono ni el contenido', async () => {
    vi.stubEnv('WA_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('WA_PHONE_NUMBER_ID', '1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ messages: [{ id: replyId }] })));
    const { module, service, insert } = await createService();
    try {
      expect(await service.accept(payload({ messages: [incomingMessage] }))).toBe(1);
      await vi.waitFor(() => expect(logLines.join('')).toContain('mensaje marcado como procesado'));
      expect(await service.accept(payload({ statuses: [
        { id: replyId, status: 'delivered', recipient_id: phone },
        { id: 'wamid.otra-respuesta', status: 'failed', errors: [{ code: 131026, title: privateText }] },
      ] }))).toBe(0);
      expect(insert).toHaveBeenCalledTimes(1);

      const logs = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(logs).toEqual(expect.arrayContaining([
        expect.objectContaining({ msg: 'WhatsApp: mensaje recibido', mensajeId: incomingRef, numero: '****0123' }),
        expect.objectContaining({ msg: 'WhatsApp: mensaje guardado en la base de datos', mensajeId: incomingRef, bandejaId: 7 }),
        expect.objectContaining({ msg: 'WhatsApp: Meta aceptó la respuesta', mensajeId: incomingRef, respuestaId: replyRef }),
        expect.objectContaining({ respuestaId: replyRef, estado: 'entregado', numero: '****0123' }),
        expect.objectContaining({ estado: 'fallido', codigosMeta: [131026] }),
      ]));
      expect(logLines.join('')).not.toContain(phone);
      expect(logLines.join('')).not.toContain(privateText);
      expect(logLines.join('')).not.toContain('test-token');
      expect(logLines.join('')).not.toContain('wamid.');
    } finally {
      await module.close();
    }
  });

  test('muestra el código de Meta y registra el reintento sin volcar el error original', async () => {
    vi.stubEnv('WA_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('WA_PHONE_NUMBER_ID', '1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: {
      code: 131026, error_subcode: 123, message: `${privateText} ${phone}`,
    } }, { status: 400 })));
    const { module, service, set } = await createService();
    try {
      await service.accept(payload({ messages: [incomingMessage] }));
      await vi.waitFor(() => expect(logLines.join('')).toContain('quedó programado un reintento'));
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending', attempts: 1 }));
      const logs = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(logs).toContainEqual(expect.objectContaining({ mensajeId: incomingRef, httpMeta: 400,
        codigoMeta: 131026, subcodigoMeta: 123, reintentoEnSegundos: 2 }));
      expect(logLines.join('')).not.toContain(phone);
      expect(logLines.join('')).not.toContain(privateText);
      expect(logLines.join('')).not.toContain('Meta aceptó la respuesta');
    } finally {
      await module.close();
    }
  });
});
