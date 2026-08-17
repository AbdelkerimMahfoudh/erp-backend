import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateGoalDto {
  @ApiProperty({ enum: ['company', 'branch', 'user'] })
  @IsIn(['company', 'branch', 'user'])
  scope: 'company' | 'branch' | 'user';

  @ApiPropertyOptional({ format: 'uuid', description: 'Required for a branch or personal goal' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required for a personal goal' })
  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  /**
   * No `net_profit`. Expenses are not the salesperson's doing, and a target
   * somebody cannot influence is not a goal, it is a grievance.
   */
  @ApiProperty({ enum: ['gross_profit', 'revenue', 'sales_count', 'units_sold'] })
  @IsIn(['gross_profit', 'revenue', 'sales_count', 'units_sold'])
  metric: 'gross_profit' | 'revenue' | 'sales_count' | 'units_sold';

  @ApiProperty({ format: 'date' })
  @IsDateString()
  periodStart: string;

  @ApiProperty({ format: 'date' })
  @IsDateString()
  periodEnd: string;

  /** Wording only ("this month"). The dates are what the figures come from. */
  @ApiPropertyOptional({ enum: ['daily', 'weekly', 'monthly', 'custom'] })
  @IsOptional()
  @IsIn(['daily', 'weekly', 'monthly', 'custom'])
  periodLabel?: 'daily' | 'weekly' | 'monthly' | 'custom';

  @ApiProperty({ minimum: 0.01, description: 'A target of zero is met before anybody starts' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  targetAmount: number;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}
