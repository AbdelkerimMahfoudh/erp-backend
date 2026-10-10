import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { isUuid } from '../utils/uuid.util';

/**
 * A record id in the path that is not a uuid is the client's mistake: 400
 * `id_invalid`, before anything is looked up (D161).
 *
 * Without it the id reached `uuidToBin`, whose plain Error became a 500 — and
 * a phone replaying a queued write treats a 5xx as "the outcome is unknown,
 * check again", which for a malformed id it never stops being.
 */
@Injectable()
export class RecordIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isUuid(value)) throw new BadRequestException({ code: 'id_invalid', message: 'That record id is not valid.' });
    return value;
  }
}
