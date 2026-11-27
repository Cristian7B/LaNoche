import { Controller, Get } from '@nestjs/common';
import { AllowBlocked, Public } from '../auth/auth.decorators.js';
import { EventService } from './event.service.js';

@Controller('event')
export class EventController {
  constructor(private readonly events: EventService) {}

  @Get()
  @Public()
  @AllowBlocked()
  getEvent() {
    return this.events.getEvent();
  }
}
