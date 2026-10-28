import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

/** A buying cost that was not known when the stock was received (0107). */
export class CompleteCostDto {
  @ApiProperty({ minimum: 0.01, description: 'Per unit (IMEI/serial) or per piece (quantity) — what was actually paid.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsMoney({ min: 0.01 })
  cost!: number;

  @ApiPropertyOptional({ description: 'Why the cost is entered now — kept in the history.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
