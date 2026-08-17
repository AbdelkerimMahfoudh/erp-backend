import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional } from 'class-validator';

export class CommitImportDto {
  /**
   * The version the shop reviewed. Two people committing one preview produce
   * one import and one 409 — never two sets of stock from one file.
   */
  @ApiPropertyOptional({ description: 'Version the preview was reviewed at' })
  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}
