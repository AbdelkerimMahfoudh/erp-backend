import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, Min } from 'class-validator';

export class CreateClosingDto {
  @ApiProperty({ minimum: 0, description: 'Cash counted in the till at closing' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  countedCash: number;

  @ApiPropertyOptional({ format: 'date', description: 'Day to close; defaults to today (UTC)' })
  @IsOptional()
  @IsDateString()
  date?: string;
}
