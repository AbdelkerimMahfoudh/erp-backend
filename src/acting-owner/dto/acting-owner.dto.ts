import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

const LANGUAGES = ['en', 'fr', 'ar'] as const;

/**
 * Ask for the confirmation code (D225): the Owner's password, then a code to the Owner's verified WhatsApp number,
 * bound to exactly the change described here — the appointment (who, from, until) or the removal (which one).
 */
export class RequestActingOwnerCodeDto {
  @ApiProperty({ enum: ['appoint', 'revoke'] })
  @IsIn(['appoint', 'revoke'])
  action: 'appoint' | 'revoke';

  @ApiPropertyOptional()
  @ValidateIf((o: RequestActingOwnerCodeDto) => o.action === 'appoint')
  @IsUUID()
  delegateId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: true })
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: true })
  endsAt?: string;

  @ApiPropertyOptional()
  @ValidateIf((o: RequestActingOwnerCodeDto) => o.action === 'revoke')
  @IsUUID()
  delegationId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword: string;

  @ApiPropertyOptional({ enum: LANGUAGES })
  @IsOptional()
  @IsIn(LANGUAGES)
  language?: (typeof LANGUAGES)[number];
}

/** The step-up every appointment and removal needs: the code sent for this very change. */
class StepUpProofDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword: string;

  @ApiProperty()
  @IsUUID()
  challengeId: string;

  /** Six digits. Anything else never reaches a hash. */
  @ApiProperty()
  @IsString()
  @Matches(/^\d{6}$/)
  code: string;
}

/** Appoint an Acting Owner (D225): the Owner's password AND the WhatsApp code sent for this appointment. */
export class AppointActingOwnerDto extends StepUpProofDto {
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
}

/** Remove an Acting Owner (D225): the Owner's password AND the WhatsApp code sent for this removal. */
export class RevokeActingOwnerDto extends StepUpProofDto {}
