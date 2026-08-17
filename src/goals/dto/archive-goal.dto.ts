import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ArchiveGoalDto {
  /**
   * Mandatory. A goal is archived rather than deleted — a missed target is a
   * fact about the shop's history — and an archived goal with no explanation
   * looks identical to one that was simply abandoned.
   */
  @ApiProperty({ minLength: 3, maxLength: 255 })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason: string;
}
