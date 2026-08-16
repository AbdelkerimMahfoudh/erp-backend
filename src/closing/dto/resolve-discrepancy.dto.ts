import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class ResolveDiscrepancyDto {
  @ApiProperty({ enum: ['employee_debt', 'store_absorbed', 'error_corrected', 'forgiven'] })
  @IsIn(['employee_debt', 'store_absorbed', 'error_corrected', 'forgiven'])
  resolution: 'employee_debt' | 'store_absorbed' | 'error_corrected' | 'forgiven';

  /**
   * Mandatory, every resolution, no exception. There is no resolving a shortage
   * silently — "the Owner looked at it" is not a record anybody can read back
   * in six months.
   */
  @ApiProperty({ minLength: 3, maxLength: 255 })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason: string;

  /**
   * Required for `employee_debt` and `forgiven`, refused for the others.
   * Naming somebody and then absorbing the loss records an accusation that led
   * to nothing.
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  responsibleUserId?: string;

  @ApiPropertyOptional({ description: 'Version the decision was made against' })
  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}
