import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { isUuid, uuidToBin } from '../common/utils/uuid.util';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: "List the current user's notifications (own + broadcast)" })
  list(@CurrentUser() user: AuthUser, @Query('unread') unread?: string) {
    return this.notifications.listForUser(uuidToBin(user.userId), unread === 'true');
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a notification as read' })
  markRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    if (!isUuid(id)) {
      throw new BadRequestException('Invalid notification id');
    }
    return this.notifications.markRead(uuidToBin(user.userId), uuidToBin(id));
  }
}
