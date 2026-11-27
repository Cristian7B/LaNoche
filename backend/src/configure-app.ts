import helmet from 'helmet';
import { HttpStatus, RequestMethod, StandardSchemaValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Environment } from './config/env.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';

export function configureApp(app: NestExpressApplication, env: Environment) {
  app.use(helmet());
  app.useGlobalPipes(new StandardSchemaValidationPipe({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY }));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableCors({ origin: env.WEB_URL, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });
  app.set('trust proxy', env.TRUST_PROXY);
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'webhooks/whatsapp', method: RequestMethod.ALL }] });
}
