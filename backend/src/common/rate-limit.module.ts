import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [ThrottlerModule.forRoot({
    throttlers: [{ ttl: 60_000, limit: 120 }],
    getTracker: (request) => request.user?.id ? `user:${request.user.id}` : `ip:${request.ip ?? 'unknown'}`,
  })],
  providers: [ThrottlerGuard, { provide: APP_GUARD, useExisting: ThrottlerGuard }],
})
export class RateLimitModule {}
