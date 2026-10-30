import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { isUuid, uuidToBin } from '../common/utils/uuid.util';
import { NOTIFICATION_FILTERS, NotificationsService, type NotificationFilter } from './notifications.service';
import { NOTIFICATION_LEVELS, type NotificationLevel } from './notification-catalog';

class PreferenceDto {
  @IsIn(NOTIFICATION_LEVELS)
  level: NotificationLevel;
}

/** A phone's push token (Expo's or the platform's), its platform, and the language it reads. */
class DeviceDto {
  @IsString()
  @MaxLength(255)
  @Matches(/^[A-Za-z0-9_\-:\[\]]+$/)
  token: string;

  @IsIn(['ios', 'android'])
  platform: 'ios' | 'android';

  @IsIn(['en', 'fr', 'ar'])
  locale: 'en' | 'fr' | 'ar';
}

class DeviceTokenDto {
  @IsString()
  @MaxLength(255)
  token: string;
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: "List the current user's notifications (own + broadcast)" })
  list(
    @CurrentUser() user: AuthUser,
    @Query('unread') unread?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('filter') filter?: string,
  ) {
    if (cursor && !isUuid(cursor)) {
      throw new BadRequestException('Invalid cursor');
    }
    if (filter && !(NOTIFICATION_FILTERS as readonly string[]).includes(filter)) {
      throw new BadRequestException('Invalid filter');
    }
    return this.notifications.listForUser(uuidToBin(user.userId), {
      onlyUnread: unread === 'true',
      cursor: cursor ? uuidToBin(cursor) : undefined,
      limit: limit ? Number(limit) : undefined,
      filter: filter as NotificationFilter | undefined,
    });
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every notification you can see as read (on every device)' })
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(uuidToBin(user.userId));
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Your push level: all | important | approvals (the default for your role until you choose)' })
  preference(@CurrentUser() user: AuthUser) {
    return this.notifications.preferenceOf(uuidToBin(user.userId));
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Choose your push level; it follows your account to every device and never widens what you see' })
  setPreference(@CurrentUser() user: AuthUser, @Body() dto: PreferenceDto) {
    return this.notifications.setPreference(uuidToBin(user.userId), dto.level);
  }

  @Post('devices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register this phone for push, with the language it reads' })
  registerDevice(@CurrentUser() user: AuthUser, @Body() dto: DeviceDto) {
    return this.notifications.registerDevice(uuidToBin(user.userId), dto);
  }

  @Delete('devices')
  @ApiOperation({ summary: 'Stop pushing to this phone' })
  revokeDevice(@CurrentUser() user: AuthUser, @Body() dto: DeviceTokenDto) {
    return this.notifications.revokeDevice(uuidToBin(user.userId), dto.token);
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
