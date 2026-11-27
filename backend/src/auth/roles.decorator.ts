import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'requiredRoles';
export const Roles = (...roles: ('participant' | 'admin')[]) => SetMetadata(ROLES_KEY, roles);
