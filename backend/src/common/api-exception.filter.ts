import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : undefined;
    const body = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
    const nested = typeof body.message === 'object' && body.message !== null ? body.message as Record<string, unknown> : null;
    const code = typeof body.code === 'string' ? body.code
      : typeof nested?.code === 'string' ? nested.code
        : this.defaultCode(status);
    const message = typeof body.message === 'string' ? body.message
      : typeof nested?.message === 'string' ? nested.message
        : this.defaultMessage(status);
    const details = body.details ?? nested?.details;
    if (status >= 500) {
      const route = request.route?.path ? String(request.route.path) : '<unmatched>';
      this.logger.error(`Unhandled request error (${request.method} ${route}; ${exception instanceof Error ? exception.constructor.name : 'unknown'})`);
    }
    response.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
  }

  private defaultCode(status: number) {
    if (status === 400 || status === 422) return 'VALIDATION_ERROR';
    if (status === 401) return 'UNAUTHENTICATED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status === 409) return 'CONFLICT';
    return 'INTERNAL_ERROR';
  }

  private defaultMessage(status: number) {
    if (status >= 500) return 'Ocurrió un error interno.';
    if (status === 404) return 'No se encontró el recurso.';
    return 'La solicitud no se pudo procesar.';
  }
}
