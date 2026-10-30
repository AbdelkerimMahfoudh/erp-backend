import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/** Appoint an Acting Owner (D225). The Owner's own password is the step-up: it proves who is at the phone. */
export class AppointActingOwnerDto {
  @ApiProperty()
  @IsUUID()
  delegateId: string;

  /** Now when absent. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: true })
  startsAt?: string;

  /** Until revoked when absent. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: true })
  endsAt?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword: string;
}

export class RevokeActingOwnerDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword: string;
}
