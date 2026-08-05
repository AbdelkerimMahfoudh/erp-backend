import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { Optional } from '../../settings/dto/optional.decorator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Owner edit of a company user's identity and contact details.
 *
 * Stage 1 is deliberately narrow: name, contact channels, and the active flag.
 * There is **no** role, branch, permission, password or passcode field — those
 * are later stages, and the strict global ValidationPipe (`forbidNonWhitelisted`)
 * rejects any such property with a 400. That is what structurally prevents a
 * store-facing Owner from assigning `administrator` (Platform Administrator)
 * through this API: the field to do it does not exist here.
 *
 * Phone and email accept an empty string to clear the value. A changed contact
 * always resets its verification timestamp in the service.
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ maxLength: 160 })
  @Optional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'A name cannot be blank' })
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({
    maxLength: 24,
    example: '+2223XXXXXX',
    description: 'International format (E.164). Send an empty string to clear it.',
  })
  @Optional()
  @Transform(trim)
  @IsString()
  @MaxLength(24)
  phone?: string;

  @ApiPropertyOptional({
    maxLength: 160,
    description: 'Optional recovery email. Send an empty string to clear it.',
  })
  @Optional()
  @Transform(trimLower)
  @IsString()
  @MaxLength(160)
  email?: string;

  @ApiPropertyOptional({
    description: 'Deactivate (false) or restore (true). Users are never hard-deleted.',
  })
  @Optional()
  @IsBoolean()
  isActive?: boolean;
}
