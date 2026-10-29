import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArabicName, IsLatinName, NAME_MAX, NormalizeName } from '../../common/bilingual-name';
import { Optional } from '../../settings/dto/optional.decorator';

/**
 * A business's or a store's two names (D225). Each is edited on its own: sending one never touches the other, so
 * completing the Arabic name of a store opened before 0111 cannot disturb the name on its existing receipts' sign.
 */
export class UpdateNamesDto {
  @ApiPropertyOptional({ maxLength: NAME_MAX, description: 'The name in the Latin alphabet (French and English screens).' })
  @Optional()
  @NormalizeName()
  @IsLatinName()
  name?: string;

  @ApiPropertyOptional({ maxLength: NAME_MAX, description: 'الاسم بالعربية — the name the Arabic screens show.' })
  @Optional()
  @NormalizeName()
  @IsArabicName()
  nameAr?: string;
}
