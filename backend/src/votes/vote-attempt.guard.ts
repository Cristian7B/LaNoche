import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DB, type Database } from '../db/db.module.js';
import { voteAttempts } from '../db/schema.js';
import type { AuthRequest } from '../auth/auth.types.js';

@Injectable()
export class VoteAttemptGuard implements CanActivate {
  private readonly recentAttempts = new Map<string, number[]>();
  constructor(@Inject(DB) private readonly db: Database) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>() as AuthRequest;
    const response = context.switchToHttp().getResponse<Response>();
    const user = request.user;
    if (!user) return false;
    await this.db.insert(voteAttempts).values({ voterId: user.id, ip: request.ip ?? null });
    const now = Date.now();
    const recent = (this.recentAttempts.get(user.id) ?? []).filter((startedAt) => now - startedAt < 60_000);
    recent.push(now);
    this.recentAttempts.set(user.id, recent);
    if (this.recentAttempts.size > 10_000) {
      for (const [key, timestamps] of this.recentAttempts) if (!timestamps.some((timestamp) => now - timestamp < 60_000)) this.recentAttempts.delete(key);
    }
    if (recent.length > 20) {
      response.setHeader('Retry-After', '60');
      throw new HttpException({ code: 'RATE_LIMITED', message: 'Superaste el límite de votos por minuto.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
