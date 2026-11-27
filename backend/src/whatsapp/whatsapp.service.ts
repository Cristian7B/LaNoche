import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, HttpException, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, count, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import pLimit from 'p-limit';
import { DB, type Database } from '../db/db.module.js';
import { webhookInbox, whatsappIntakes } from '../db/schema.js';
import { EventService } from '../event/event.service.js';
import { MediaService } from '../media/media.service.js';
import { StorageService } from '../media/storage.service.js';
import { CryptoService } from './crypto.service.js';
import { GraphClient, GraphResponseError } from './graph-client.js';
import { botMessages } from './messages.js';

interface IncomingMessage {
  id?: string;
  from?: string;
  type?: string;
  sticker?: { id?: string; mime_type?: string; sha256?: string; animated?: boolean };
}

interface DeliveryStatus {
  id?: string;
  recipient_id?: string;
  status?: string;
  errors?: { code?: number }[];
}

type InboxMessage = typeof webhookInbox.$inferSelect;
type ReplyType = 'evento_cerrado' | 'ayuda' | 'cupo_agotado' | 'enlace_sticker';

const deliveryLabels = new Map([
  ['sent', 'enviado'], ['delivered', 'entregado'], ['read', 'leído'], ['failed', 'fallido'],
]);

function maskPhone(value: unknown) {
  return typeof value === 'string' && /^\+?\d{5,15}$/.test(value) ? `****${value.slice(-4)}` : undefined;
}

function logId(id: string) {
  // Some WhatsApp message IDs encode phone numbers.
  return createHash('sha256').update(id).digest('hex').slice(0, 24);
}

function errorFields(error: unknown) {
  if (error instanceof GraphResponseError) {
    return { errorTipo: error.constructor.name, operacion: error.operation, httpMeta: error.httpStatus,
      codigoMeta: error.graphCode, subcodigoMeta: error.graphSubcode };
  }
  const response = error instanceof HttpException ? error.getResponse() : undefined;
  const code = typeof response === 'object' && response !== null && 'code' in response ? response.code : undefined;
  const cause = error instanceof Error ? error.cause : undefined;
  const causeCode = cause instanceof Error && 'code' in cause ? cause.code : undefined;
  return {
    errorTipo: error instanceof Error ? error.constructor.name : 'Error',
    errorNombre: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : undefined,
    codigo: typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : undefined,
    causaTipo: cause instanceof Error ? cause.constructor.name : undefined,
    causaCodigo: typeof causeCode === 'string' && /^(?:[A-Z][A-Z0-9_]{0,39}|[A-Z0-9]{5})$/.test(causeCode) ? causeCode : undefined,
  };
}

@Injectable()
export class WhatsappService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly running = new Set<number>();
  private readonly limit = pLimit(2);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly events: EventService,
    private readonly media: MediaService,
    private readonly storage: StorageService,
    private readonly crypto: CryptoService,
    private readonly graph: GraphClient,
  ) {}

  onApplicationBootstrap() {
    void this.recover().catch((error: unknown) => {
      this.logger.error(errorFields(error), 'WhatsApp: no se pudo recuperar la bandeja al arrancar');
    });
  }

  async accept(payload: unknown) {
    const { messages, statuses } = this.extractNotifications(payload);
    for (const status of statuses) this.logDelivery(status);
    const inserted: number[] = [];
    for (const message of messages) {
      if (!message || typeof message.id !== 'string' || !message.id || typeof message.from !== 'string' || !message.from ||
        typeof message.type !== 'string' || !message.type) {
        this.logger.warn({ mensajeId: typeof message?.id === 'string' ? logId(message.id) : undefined,
          faltaNumero: typeof message?.from !== 'string' || !message.from }, 'WhatsApp: se ignoró un mensaje con datos incompletos');
        continue;
      }
      const fields = { mensajeId: logId(message.id), tipo: message.type, numero: maskPhone(message.from) };
      this.logger.log(fields, 'WhatsApp: mensaje recibido');
      try {
        const senderHash = this.crypto.hashSender(message.from);
        const sticker = message.type === 'sticker' ? message.sticker : undefined;
        const [row] = await this.db.insert(webhookInbox).values({
          messageId: message.id,
          mediaId: sticker?.id ?? null,
          mediaMimeType: sticker?.mime_type ?? null,
          mediaSha256: sticker?.sha256 ?? null,
          mediaAnimated: sticker?.animated ?? null,
          senderHash,
          senderCiphertext: this.crypto.encrypt(message.from),
          messageType: message.type,
          status: 'pending',
          nextAttemptAt: new Date(),
        }).onConflictDoNothing({ target: webhookInbox.messageId }).returning({ id: webhookInbox.id });
        if (row) {
          inserted.push(row.id);
          this.logger.log({ ...fields, bandejaId: row.id }, 'WhatsApp: mensaje guardado en la base de datos');
        } else {
          this.logger.log(fields, 'WhatsApp: mensaje duplicado, ya estaba guardado');
        }
      } catch (error) {
        this.logger.error({ ...fields, ...errorFields(error) }, 'WhatsApp: no se pudo guardar el mensaje');
        throw error;
      }
    }
    for (const id of inserted) this.enqueue(id);
    return inserted.length;
  }

  private enqueue(id: number) {
    if (this.running.has(id)) return;
    this.running.add(id);
    void this.limit(() => this.process(id)).catch((error: unknown) => {
      this.logger.error({ bandejaId: id, ...errorFields(error) }, 'WhatsApp: el trabajador no pudo completar el mensaje');
    }).finally(() => this.running.delete(id));
  }

  @Interval(5_000)
  async recover() {
    await this.db.update(webhookInbox).set({ status: 'pending', updatedAt: new Date() })
      .where(and(eq(webhookInbox.status, 'processing'), lt(webhookInbox.leaseUntil, sql`clock_timestamp()`), lt(webhookInbox.attempts, 3)));
    const failed = await this.db.update(webhookInbox).set({ status: 'failed', senderCiphertext: null, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
      .where(and(eq(webhookInbox.status, 'processing'), lt(webhookInbox.leaseUntil, sql`clock_timestamp()`)))
      .returning({ messageId: webhookInbox.messageId });
    if (failed.length) {
      for (const row of failed) {
        this.logger.error({ mensajeId: logId(row.messageId) }, 'WhatsApp: se agotaron los intentos tras vencer el bloqueo de procesamiento');
      }
      const staleIntakes = await this.db.update(whatsappIntakes).set({ status: 'failed', waId: null, tokenCiphertext: null, error: 'Worker lease expired', updatedAt: new Date() })
        .where(inArray(whatsappIntakes.waMessageId, failed.map((row) => row.messageId)))
        .returning({ storagePath: whatsappIntakes.storagePath, thumbPath: whatsappIntakes.thumbPath });
      for (const intake of staleIntakes) {
        const paths = [intake.storagePath, intake.thumbPath].filter((path): path is string => path !== null);
        if (paths.length) await this.storage.remove(paths).catch(() => undefined);
      }
    }
    const rows = await this.db.select({ id: webhookInbox.id }).from(webhookInbox)
      .where(and(eq(webhookInbox.status, 'pending'), lt(webhookInbox.nextAttemptAt, sql`clock_timestamp()`)))
      .limit(50);
    for (const row of rows) this.enqueue(row.id);
  }

  private async process(id: number) {
    const [inbox] = await this.db.select().from(webhookInbox).where(eq(webhookInbox.id, id));
    if (!inbox || inbox.status !== 'pending') return;
    const leaseToken = randomUUID();
    const [locked] = await this.db.update(webhookInbox).set({ status: 'processing', attempts: sql`${webhookInbox.attempts} + 1`,
      leaseToken, leaseUntil: sql`clock_timestamp() + interval '60 seconds'`, updatedAt: new Date() })
      .where(and(eq(webhookInbox.id, id), eq(webhookInbox.status, 'pending'))).returning({ id: webhookInbox.id, attempts: webhookInbox.attempts });
    if (!locked) return;
    this.logger.log({ mensajeId: logId(inbox.messageId), intento: locked.attempts }, 'WhatsApp: comenzó el procesamiento');
    const heartbeat = setInterval(() => {
      void this.db.update(webhookInbox).set({ leaseUntil: sql`clock_timestamp() + interval '60 seconds'`, updatedAt: new Date() })
        .where(and(eq(webhookInbox.id, id), eq(webhookInbox.leaseToken, leaseToken))).catch((error: unknown) => {
          this.logger.warn({ mensajeId: logId(inbox.messageId), ...errorFields(error) }, 'WhatsApp: no se pudo renovar el bloqueo de procesamiento');
        });
    }, 15_000);
    heartbeat.unref();
    try {
      if (!inbox.senderCiphertext) throw new Error('Missing encrypted sender');
      const waId = this.crypto.decrypt(inbox.senderCiphertext);
      const event = await this.events.getEvent();
      let replyText: string;
      let replyType: ReplyType;
      if (event.effective_status !== 'open') {
        replyText = botMessages.closed;
        replyType = 'evento_cerrado';
      } else if (inbox.messageType !== 'sticker' || !inbox.mediaId) {
        replyText = botMessages.help.replace('{{web_url}}', process.env.WEB_URL ?? '');
        replyType = 'ayuda';
      } else {
        const intake = await this.prepareIntake(inbox, waId).catch((error: unknown) => {
          if (error instanceof ConflictException && (error.getResponse() as { code?: string }).code === 'EVENT_NOT_OPEN') return undefined;
          throw error;
        });
        if (intake) {
          await this.finishSticker(inbox, intake, waId, leaseToken);
          return;
        }
        replyType = intake === null ? 'cupo_agotado' : 'evento_cerrado';
        replyText = intake === null ? botMessages.dailyLimit : botMessages.closed;
      }
      if (!await this.sendReply(inbox, waId, replyType, replyText, leaseToken)) return;
      const [finished] = await this.db.update(webhookInbox).set({ status: 'done', senderCiphertext: null, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
        .where(and(eq(webhookInbox.id, id), eq(webhookInbox.status, 'processing'), eq(webhookInbox.leaseToken, leaseToken)))
        .returning({ id: webhookInbox.id });
      this.logCompletion(inbox, Boolean(finished));
    } catch (error) {
      await this.retry(inbox, locked.attempts, error, leaseToken);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async prepareIntake(inbox: typeof webhookInbox.$inferSelect, waId: string) {
    return this.db.transaction(async (tx) => {
      await this.events.assertOpen(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${inbox.senderHash ?? ''}, 0))`);
      const [existing] = await tx.select().from(whatsappIntakes).where(eq(whatsappIntakes.waMessageId, inbox.messageId)).for('update');
      if (existing) return existing;
      const [daily] = await tx.select({ total: count() }).from(whatsappIntakes).where(and(
        eq(whatsappIntakes.waSenderHash, inbox.senderHash ?? ''),
        gt(whatsappIntakes.createdAt, sql`clock_timestamp() - interval '24 hours'`),
      ));
      const dailyLimit = Number(process.env.WA_MAX_INTAKES_PER_DAY ?? 10);
      if (daily.total >= dailyLimit) {
        this.logger.log({ mensajeId: logId(inbox.messageId), usados: daily.total, limite: dailyLimit }, 'WhatsApp: cupo de stickers agotado');
        return null;
      }
      const ttlHours = Number(process.env.INTAKE_TTL_HOURS ?? 72);
      const [intake] = await tx.insert(whatsappIntakes).values({
        waMessageId: inbox.messageId,
        waMediaId: inbox.mediaId!,
        waId,
        waSenderHash: inbox.senderHash ?? '',
        category: 'sticker',
        status: 'processing',
        expiresAt: sql`clock_timestamp() + (${ttlHours} * interval '1 hour')`,
      }).onConflictDoNothing({ target: whatsappIntakes.waMessageId }).returning();
      if (intake) return intake;
      const [concurrent] = await tx.select().from(whatsappIntakes).where(eq(whatsappIntakes.waMessageId, inbox.messageId)).for('update');
      return concurrent ?? null;
    });
  }

  private async finishSticker(inbox: typeof webhookInbox.$inferSelect, intake: typeof whatsappIntakes.$inferSelect, waId: string, leaseToken: string) {
    if (intake.status === 'ready' && intake.tokenCiphertext) {
      await this.sendIntakeLink(inbox, intake, waId, leaseToken);
      return;
    }
    if (intake.status !== 'processing') {
      this.logger.log({ mensajeId: logId(inbox.messageId), stickerId: intake.id, estado: intake.status }, 'WhatsApp: el sticker ya no requiere procesar o reenviar el enlace');
      await this.db.update(webhookInbox).set({ status: 'done', senderCiphertext: null, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
        .where(and(eq(webhookInbox.id, inbox.id), eq(webhookInbox.status, 'processing'), eq(webhookInbox.leaseToken, leaseToken)));
      return;
    }
    const { data, mimeType } = await this.graph.download(intake.waMediaId);
    const expectedHash = inbox.mediaSha256;
    if (expectedHash) {
      const actual = createHash('sha256').update(data).digest('base64');
      if (actual !== expectedHash) throw new Error('Sticker sha256 did not match');
    }
    if (data.length > 2 * 1024 * 1024) throw new Error('Sticker exceeds 2 MB');
    const path = join(tmpdir(), `${randomUUID()}.upload`);
    try {
      await writeFile(path, data);
      const [processed] = await this.media.process([{
        fieldname: 'files', originalname: 'sticker', encoding: '7bit', mimetype: mimeType,
        size: data.length, destination: tmpdir(), filename: path.split(/[\\/]/).at(-1)!, path,
        stream: Readable.from(data), buffer: data,
      }], 'sticker');
      const root = `intakes/${intake.id}`;
      const storagePath = `${root}/media.${processed.extension}`;
      const thumbPath = `${root}/thumb.webp`;
      if (!await this.ownsLease(inbox.id, leaseToken)) return;
      await this.storage.remove([storagePath, thumbPath]).catch(() => undefined);
      await this.storage.upload(storagePath, processed.data, processed.mimeType);
      try {
        await this.storage.upload(thumbPath, processed.thumbnail, 'image/webp');
      } catch (error) {
        await this.storage.remove([storagePath]).catch(() => undefined);
        throw error;
      }
      if (!await this.ownsLease(inbox.id, leaseToken)) return;
      const token = randomBytes(32).toString('base64url');
      const [ready] = await this.db.update(whatsappIntakes).set({
        status: 'ready', tokenHash: this.crypto.hashToken(token), tokenCiphertext: this.crypto.encrypt(token),
        sourceMime: inbox.mediaMimeType ?? mimeType, isAnimated: inbox.mediaAnimated ?? processed.kind === 'video',
        kind: processed.kind, storagePath, thumbPath, mimeType: processed.mimeType,
        width: processed.width, height: processed.height, durationMs: processed.durationMs,
        sizeBytes: processed.sizeBytes, updatedAt: new Date(),
      }).where(and(eq(whatsappIntakes.id, intake.id), eq(whatsappIntakes.status, 'processing'))).returning();
      if (ready) {
        this.logger.log({ mensajeId: logId(inbox.messageId), stickerId: ready.id, formato: ready.mimeType }, 'WhatsApp: sticker guardado en Storage y marcado como listo en la base de datos');
        await this.sendIntakeLink(inbox, ready, waId, leaseToken);
      }
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }

  private async sendIntakeLink(inbox: typeof webhookInbox.$inferSelect, intake: typeof whatsappIntakes.$inferSelect, waId: string, leaseToken: string) {
    if (!intake.tokenCiphertext) throw new Error('Temporary claim token is unavailable');
    const token = this.crypto.decrypt(intake.tokenCiphertext);
    const url = `${process.env.WEB_URL}/s/${token}`;
    if (!await this.sendReply(inbox, waId, 'enlace_sticker', botMessages.link(url), leaseToken)) return;
    const completed = await this.db.transaction(async (tx) => {
      const [finished] = await tx.update(webhookInbox).set({ status: 'done', senderCiphertext: null, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
        .where(and(eq(webhookInbox.id, inbox.id), eq(webhookInbox.status, 'processing'), eq(webhookInbox.leaseToken, leaseToken))).returning({ id: webhookInbox.id });
      if (finished) {
        await tx.update(whatsappIntakes).set({ replySentAt: new Date(), waId: null, tokenCiphertext: null, updatedAt: new Date() })
          .where(and(eq(whatsappIntakes.id, intake.id), eq(whatsappIntakes.status, 'ready')));
      }
      return Boolean(finished);
    });
    this.logCompletion(inbox, completed);
  }

  private async sendReply(inbox: InboxMessage, waId: string, replyType: ReplyType, text: string, leaseToken: string) {
    const fields = { mensajeId: logId(inbox.messageId), numero: maskPhone(waId), respuesta: replyType };
    if (!await this.renewLease(inbox.id, leaseToken)) {
      this.logger.warn(fields, 'WhatsApp: respuesta omitida porque venció el bloqueo de procesamiento');
      return false;
    }
    let replyId: string | undefined;
    try {
      replyId = await this.graph.sendText(waId, text);
    } catch (error) {
      this.logger.warn({ ...fields, ...errorFields(error) }, 'WhatsApp: no se pudo enviar la respuesta a Meta');
      throw error;
    }
    this.logger.log({ ...fields, respuestaId: replyId ? logId(replyId) : undefined }, 'WhatsApp: Meta aceptó la respuesta');
    return true;
  }

  private logCompletion(inbox: InboxMessage, completed: boolean) {
    const fields = { mensajeId: logId(inbox.messageId), bandejaId: inbox.id };
    if (completed) this.logger.log(fields, 'WhatsApp: mensaje marcado como procesado en la base de datos');
    else this.logger.warn(fields, 'WhatsApp: la respuesta se aceptó, pero el trabajador ya no pudo marcar el mensaje como procesado');
  }

  private async ownsLease(id: number, leaseToken: string) {
    const [owner] = await this.db.select({ id: webhookInbox.id }).from(webhookInbox).where(and(
      eq(webhookInbox.id, id), eq(webhookInbox.status, 'processing'), eq(webhookInbox.leaseToken, leaseToken),
      gt(webhookInbox.leaseUntil, sql`clock_timestamp()`),
    ));
    return Boolean(owner);
  }

  private async renewLease(id: number, leaseToken: string) {
    const [owner] = await this.db.update(webhookInbox).set({ leaseUntil: sql`clock_timestamp() + interval '60 seconds'` })
      .where(and(eq(webhookInbox.id, id), eq(webhookInbox.status, 'processing'), eq(webhookInbox.leaseToken, leaseToken),
        gt(webhookInbox.leaseUntil, sql`clock_timestamp()`))).returning({ id: webhookInbox.id });
    return Boolean(owner);
  }

  private async retry(inbox: InboxMessage, attempts: number, error: unknown, leaseToken: string) {
    const message = error instanceof Error ? error.constructor.name : 'Error';
    const fields = { mensajeId: logId(inbox.messageId), intento: attempts, ...errorFields(error) };
    if (attempts >= 3) {
      const [failed] = await this.db.update(webhookInbox).set({ status: 'failed', attempts, senderCiphertext: null, leaseToken: null, leaseUntil: null, lastError: message, updatedAt: new Date() })
        .where(and(eq(webhookInbox.id, inbox.id), eq(webhookInbox.status, 'processing'), eq(webhookInbox.leaseToken, leaseToken))).returning({ id: webhookInbox.id });
      if (!failed) {
        this.logger.warn(fields, 'WhatsApp: falló el intento y el trabajador perdió el bloqueo de procesamiento');
        return;
      }
      this.logger.error(fields, 'WhatsApp: mensaje marcado como fallido tras agotar los intentos');
      const [intake] = await this.db.update(whatsappIntakes).set({ status: 'failed', waId: null, tokenCiphertext: null, error: message, updatedAt: new Date() })
        .where(eq(whatsappIntakes.waMessageId, inbox.messageId)).returning({ storagePath: whatsappIntakes.storagePath, thumbPath: whatsappIntakes.thumbPath });
      if (intake) await this.storage.remove([intake.storagePath, intake.thumbPath].filter((path): path is string => path !== null)).catch(() => undefined);
      return;
    }
    const delaySeconds = attempts === 1 ? 2 : 10;
    const [scheduled] = await this.db.update(webhookInbox).set({ status: 'pending', attempts, leaseToken: null, leaseUntil: null, lastError: message,
      nextAttemptAt: sql`clock_timestamp() + (${delaySeconds} * interval '1 second')`, updatedAt: new Date() })
      .where(and(eq(webhookInbox.id, inbox.id), eq(webhookInbox.status, 'processing'), eq(webhookInbox.leaseToken, leaseToken)))
      .returning({ id: webhookInbox.id });
    if (scheduled) {
      this.logger.warn({ ...fields, reintentoEnSegundos: delaySeconds }, 'WhatsApp: falló el intento y quedó programado un reintento');
    } else {
      this.logger.warn(fields, 'WhatsApp: falló el intento y el trabajador perdió el bloqueo de procesamiento');
    }
  }

  private logDelivery(status: DeliveryStatus) {
    if (!status || typeof status.id !== 'string' || !status.id || typeof status.status !== 'string') return;
    const label = deliveryLabels.get(status.status);
    if (!label) return;
    const fields = { respuestaId: logId(status.id), numero: maskPhone(status.recipient_id), estado: label };
    if (status.status === 'failed') {
      const codes = Array.isArray(status.errors) ? status.errors.map((error) => error?.code).filter(Number.isInteger) : [];
      this.logger.warn({ ...fields, codigosMeta: codes }, 'WhatsApp: Meta informó que falló la entrega');
    } else {
      this.logger.log(fields, 'WhatsApp: estado de la respuesta informado por Meta');
    }
  }

  private extractNotifications(payload: unknown) {
    const messages: IncomingMessage[] = [];
    const statuses: DeliveryStatus[] = [];
    const entries = typeof payload === 'object' && payload !== null ? (payload as { entry?: unknown }).entry : undefined;
    if (!Array.isArray(entries)) return { messages, statuses };
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const changes = (entry as { changes?: unknown[] }).changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const value = typeof change === 'object' && change !== null ? (change as { value?: { messages?: unknown; statuses?: unknown } }).value : undefined;
        if (Array.isArray(value?.messages)) messages.push(...value.messages as IncomingMessage[]);
        if (Array.isArray(value?.statuses)) statuses.push(...value.statuses as DeliveryStatus[]);
      }
    }
    return { messages, statuses };
  }
}
