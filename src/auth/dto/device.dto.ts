import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Untrusted display metadata about the installation.
 *
 * Every field here is whatever the client chose to send. It is shown to the
 * user so they can tell their phones apart, and **no authorization or
 * recognition decision is ever made from it**. There is deliberately no IMEI,
 * serial or advertising id.
 */
export class DeviceMetaDto {
  @ApiPropertyOptional({ maxLength: 120, example: "Amine's Galaxy A54" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({ maxLength: 40, example: 'android' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  platform?: string;

  @ApiPropertyOptional({ maxLength: 120, example: 'SM-A546B' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;
}

/**
 * The credential pair a returning installation presents at login.
 *
 * Both parts are required together: the id alone recognises nothing, which is
 * what makes a leaked device list useless to an attacker.
 */
export class DeviceCredentialDto extends DeviceMetaDto {
  @ApiPropertyOptional({ description: 'Public device id issued at enrollment.' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'The secret issued once at enrollment. Never logged or echoed.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceSecret?: string;
}

/** LEGACY: the pre-Stage-3 shape, kept so old clients keep logging in. */
export class DeviceDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceId?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;

  @ApiPropertyOptional({ maxLength: 40, example: 'android' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  platform?: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;
}
