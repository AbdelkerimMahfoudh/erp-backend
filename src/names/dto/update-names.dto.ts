import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { IsArabicName, IsLatinName, NAME_MAX, NormalizeOptionalName } from '../../common/bilingual-name';

/**
 * A business's or a store's two names (D225). Each is edited on its own: sending one never touches the other, so
 * completing the Arabic name of a store opened before 0111 cannot disturb the name on its existing receipts' sign.
 */
export class UpdateNamesDto {
  @ApiPropertyOptional({ maxLength: NAME_MAX, description: 'The name in the Latin alphabet (French and English screens).' })
  // D227: a blank business name clears the optional trading name. A store's route refuses it: a store needs a name.
  @IsOptional()
  @NormalizeOptionalName()
  @IsLatinName()
  name?: string | null;

  @ApiPropertyOptional({ maxLength: NAME_MAX, description: 'الاسم بالعربية — the name the Arabic screens show.' })
  @IsOptional()
  @NormalizeOptionalName()
  @IsArabicName()
  nameAr?: string | null;
}
