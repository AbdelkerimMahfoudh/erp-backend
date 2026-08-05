import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SummaryLanguage } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  AUTO_LOCK_CHOICES,
  RETURN_WINDOW_MAX_HOURS,
  RETURN_WINDOW_NONE,
} from '../settings.constants';
import { Optional } from './optional.decorator';

export class WhatsappPreferencesDto {
  @ApiPropertyOptional({ enum: SummaryLanguage, description: 'Language of the Owner summary message.' })
  @Optional()
  @IsEnum(SummaryLanguage)
  language?: SummaryLanguage;

  @ApiPropertyOptional({ description: 'Whether money amounts may appear in the summary at all.' })
  @Optional()
  @IsBoolean()
  includeAmounts?: boolean;

  @ApiPropertyOptional()
  @Optional()
  @IsBoolean()
  dailyEnabled?: boolean;

  @ApiPropertyOptional()
  @Optional()
  @IsBoolean()
  monthlyEnabled?: boolean;
}

export class SecurityPreferencesDto {
  @ApiPropertyOptional({
    enum: AUTO_LOCK_CHOICES,
    description:
      'Longest auto-lock interval any user may choose, in seconds. 0 locks immediately. There is no "never".',
  })
  @Optional()
  @IsInt()
  @IsIn([...AUTO_LOCK_CHOICES], {
    message: `autoLockMaxSeconds must be one of: ${AUTO_LOCK_CHOICES.join(', ')} (seconds). "Never" is not permitted.`,
  })
  autoLockMaxSeconds?: number;
}

/**
 * Partial update of company policy. Every field is optional so one screen
 * section can be saved without resending the others, but `version` is not:
 * a save that cannot say which state it was editing cannot be checked for
 * having been overtaken.
 */
export class UpdateSettingsDto {
  @ApiProperty({ description: 'The `version` from the settings you loaded. A stale value is rejected with 409.' })
  @IsInt()
  @Min(0)
  version: number;

  @ApiPropertyOptional({
    minimum: RETURN_WINDOW_NONE,
    maximum: RETURN_WINDOW_MAX_HOURS,
    description: '0 = no returns. Otherwise the default return window in hours (e.g. 24, 48).',
  })
  @Optional()
  @IsInt()
  @Min(RETURN_WINDOW_NONE, { message: 'returnWindowHours cannot be negative. Use 0 for "no returns".' })
  @Max(RETURN_WINDOW_MAX_HOURS, { message: `returnWindowHours cannot exceed ${RETURN_WINDOW_MAX_HOURS} (one year).` })
  returnWindowHours?: number;

  @ApiPropertyOptional({ type: WhatsappPreferencesDto })
  @Optional()
  @ValidateNested()
  @Type(() => WhatsappPreferencesDto)
  whatsapp?: WhatsappPreferencesDto;

  @ApiPropertyOptional({ type: SecurityPreferencesDto })
  @Optional()
  @ValidateNested()
  @Type(() => SecurityPreferencesDto)
  security?: SecurityPreferencesDto;
}
