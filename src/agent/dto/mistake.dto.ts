import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentMistakeKind, AgentMistakeStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** An Employee's claim that a recorded exchange is wrong (A7). It moves nothing. */
export class ReportAgentMistakeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientUuid: string;

  @ApiProperty({ enum: AgentMistakeKind })
  @IsEnum(AgentMistakeKind)
  kind: AgentMistakeKind;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListAgentMistakesDto {
  @ApiPropertyOptional({ enum: AgentMistakeStatus, description: 'Absent: every report of the branch' })
  @IsOptional()
  @IsEnum(AgentMistakeStatus)
  status?: AgentMistakeStatus;
}

/** The decision that the report was mistaken itself: the exchange stands. */
export class DismissAgentMistakeDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}
