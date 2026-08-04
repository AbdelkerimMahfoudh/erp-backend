import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateExpenseDto {
  @ApiProperty({ maxLength: 60, example: 'Rent' })
  @IsString()
  @MaxLength(60)
  category: string;

  @ApiProperty({ minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @ApiPropertyOptional({ format: 'date', description: 'Defaults to today (UTC)' })
  @IsOptional()
  @IsDateString()
  spentOn?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
