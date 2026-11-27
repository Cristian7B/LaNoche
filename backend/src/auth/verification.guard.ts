import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthRequest } from './auth.types.js';

@Injectable()
export class HumanVerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (!request.user?.humanVerifiedAt) {
      throw new ForbiddenException({ code: 'HUMAN_VERIFICATION_REQUIRED', message: 'Completa la verificación humana antes de continuar.' });
    }
    return true;
  }
}
