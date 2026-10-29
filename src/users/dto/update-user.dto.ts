import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { Optional } from '../../settings/dto/optional.decorator';
import { IsArabicName, IsLatinNameOrLegacy, NAME_MAX, NormalizeName } from '../../common/bilingual-name';

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
 * D225: `name` is the Latin-alphabet name and `nameAr` the Arabic one. Each is
 * edited on its own: sending one never touches the other.
 *
 * Phone and email accept an empty string to clear the value. A changed contact
 * always resets its verification timestamp in the service.
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ maxLength: NAME_MAX, description: 'The name in the Latin alphabet (French and English screens).' })
  @Optional()
  @NormalizeName()
  @IsLatinNameOrLegacy('nameAr')
  name?: string;

  @ApiPropertyOptional({ maxLength: NAME_MAX, description: 'الاسم بالعربية — the name the Arabic screens show.' })
  @Optional()
  @NormalizeName()
  @IsArabicName()
  nameAr?: string;

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

  /**
   * The ACTOR's own password, required only when this request changes a login
   * contact (email or phone).
   *
   * Not the target's: an Owner correcting an employee's number does not know
   * that employee's password, and demanding it would push shops toward sharing
   * passwords — the opposite of what this protects.
   */
  @ApiPropertyOptional({
    maxLength: 200,
    description: "Your own password. Required when changing a user's email or WhatsApp number.",
  })
  @Optional()
  @IsString()
  @MaxLength(200)
  currentPassword?: string;
}
