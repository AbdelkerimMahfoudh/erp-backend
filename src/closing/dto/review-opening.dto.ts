import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsUUID } from 'class-validator';

/**
 * The Owner's review of an opening somebody else made with the tracked amounts
 * (docs/63): keep them, or set the drawer to what is in it now — true from the
 * review's own instant, never backdated to the opening.
 */
export class ReviewOpeningDto {
  /** One key per attempt, reused on every retry. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientUuid: string;

  @ApiProperty({ enum: ['keep', 'set'] })
  @IsIn(['keep', 'set'])
  decision: 'keep' | 'set';

  /** With `set`: what is in the drawer now — zero or more, at most two decimals, chosen explicitly. */
  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  cashAmount?: number;
}
