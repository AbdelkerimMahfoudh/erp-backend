import { Body, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { MAX_FILE_BYTES, ReceivingFilesService } from './receiving-files.service';

/**
 * Reading a delivery out of a file.
 *
 * One endpoint, and it writes nothing: it answers with what the file says, what
 * is wrong with it and which products it matched. Receiving happens afterwards
 * through `POST /purchases` — the existing paid-in-full, atomic, idempotent
 * path — so this flow can never post stock or money by itself, and never uses
 * the opening-inventory import, whose cash semantics are different.
 *
 * Permissions are both of the ones the two halves of the job need:
 * `import.run` (Owner only since `0073`) because it reads a stock file, and
 * `purchase.manage` because the next step buys stock. The UI hides the button
 * without them; the server refuses regardless.
 */
@ApiTags('receiving')
@ApiBearerAuth()
@Controller({ path: 'purchases/file', version: '1' })
export class ReceivingFilesController {
  constructor(private readonly files: ReceivingFilesService) {}

  @Post('parse')
  @RequirePermissions('import.run', 'purchase.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        sheet: { type: 'string', description: 'Worksheet to read; the best-scoring one by default' },
        mapping: { type: 'string', description: 'JSON object of field → column index, to correct the guess' },
      },
    },
  })
  @ApiOperation({
    summary: 'Read phones out of an .xlsx workbook or a text PDF — writes nothing',
    description:
      'Returns the worksheets found, the column mapping guessed, one entry per physical phone with its ' +
      'source row or page, the problems on each, and the catalogue match. Creates no purchase, no unit ' +
      'and no payment: the review screen confirms through POST /purchases.',
  })
  parse(
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype?: string } | undefined,
    @Body('sheet') sheet?: string,
    @Body('mapping') mapping?: string,
  ) {
    if (!file) throw new BadRequestException({ code: 'file_missing', message: 'Choose a file to read' });
    let parsedMapping: Record<string, number> | undefined;
    if (mapping) {
      try {
        parsedMapping = JSON.parse(mapping) as Record<string, number>;
      } catch {
        throw new BadRequestException({ code: 'mapping_invalid', message: 'The column mapping could not be read' });
      }
    }
    return this.files.parse(file, { sheet, mapping: parsedMapping });
  }
}
