import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DbModule } from '../db/db.module.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { MeController } from './me.controller.js';
import { ProfilesService } from './profiles.service.js';
import { HumanVerifiedGuard } from './verification.guard.js';
import { TurnstileService } from './turnstile.service.js';
import { RolesGuard } from './roles.guard.js';

@Module({
  imports: [DbModule],
  controllers: [MeController],
  providers: [ProfilesService, HumanVerifiedGuard, TurnstileService, RolesGuard, JwtAuthGuard, { provide: APP_GUARD, useExisting: JwtAuthGuard }],
  exports: [ProfilesService, HumanVerifiedGuard, RolesGuard],
})
export class AuthModule {}
