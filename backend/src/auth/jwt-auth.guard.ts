import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Request } from 'express';
import { ALLOW_BLOCKED, IS_PUBLIC, OPTIONAL_AUTH } from './auth.decorators.js';
import { ProfilesService } from './profiles.service.js';
import type { AuthRequest } from './auth.types.js';
import type { JWTPayload } from 'jose';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwks = createRemoteJWKSet(
    new URL(`${process.env.SUPABASE_URL ?? 'https://invalid.local'}/auth/v1/.well-known/jwks.json`),
  );

  constructor(private readonly reflector: Reflector, private readonly profiles: ProfilesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, controller]);
    if (isPublic) return true;
    const optional = this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH, [handler, controller]);
    const request = context.switchToHttp().getRequest<Request>();
    const authRequest = request as AuthRequest;
    const authorization = request.headers.authorization;
    if (!authorization) {
      if (optional) {
        authRequest.user = null;
        return true;
      }
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Se requiere un token Bearer válido.' });
    }
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Se requiere un token Bearer válido.' });
    let payload: JWTPayload;
    try {
      const issuer = `${process.env.SUPABASE_URL}/auth/v1`;
      ({ payload } = await jwtVerify(match[1], this.jwks, { issuer, audience: 'authenticated', requiredClaims: ['exp'] }));
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw new Error('Missing required claims');
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'El token Bearer no es válido.' });
    }
    const user = await this.profiles.findOrCreate({
      sub: payload.sub!,
      email: payload.email!,
      user_metadata: typeof payload.user_metadata === 'object' && payload.user_metadata !== null
        ? payload.user_metadata as Record<string, unknown>
        : undefined,
    });
    authRequest.user = user;
    const allowBlocked = this.reflector.getAllAndOverride<boolean>(ALLOW_BLOCKED, [handler, controller]);
    if (user.isBlocked && !allowBlocked) {
      throw new ForbiddenException({ code: 'ACCOUNT_BLOCKED', message: 'La cuenta está bloqueada.' });
    }
    return true;
  }
}
