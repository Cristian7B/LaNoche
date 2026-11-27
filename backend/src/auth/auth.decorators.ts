import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
export const OPTIONAL_AUTH = 'optionalAuth';
export const ALLOW_BLOCKED = 'allowBlocked';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH, true);
export const AllowBlocked = () => SetMetadata(ALLOW_BLOCKED, true);
