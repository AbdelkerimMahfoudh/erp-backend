import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsUUID } from 'class-validator';

/**
 * The money a shop opens with (docs/63). The Owner must decide it; anybody else
 * who may open carries the tracked amounts forward, awaiting the Owner's review.
 * Only the shop's cash is decided here: the company's accounts carry forward.
 */
export class OpeningMoneyDto {
  /** One key per attempt, reused on every retry: the same key and request answer with what was recorded. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;

  @ApiPropertyOptional({
    enum: ['keep', 'set'],
    description: '`keep` the drawer as tracked (an unknown one stays unknown), or `set` it to `cashAmount` — the Owner alone',
  })
  @IsOptional()
  @IsIn(['keep', 'set'])
  decision?: 'keep' | 'set';

  /**
   * With `set`: what is in the drawer now — zero or more, at most two decimals,
   * chosen explicitly (0 is never assumed). Checked in the service, so a refusal
   * carries `amount_invalid` for the phone to act on.
   */
  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  cashAmount?: number;
}
