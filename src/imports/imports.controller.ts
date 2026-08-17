import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ImportsService } from './imports.service';
import { CommitImportDto } from './dto/commit-import.dto';

/**
 * Bringing a shop's stock list in (Milestone G).
 *
 * Every route is gated on `import.run`. Before this milestone that permission
 * was granted to three roles, labelled "Run Excel/CSV inventory import", and
 * guarded nothing at all — the G0 audit's second finding.
 */
@ApiTags('imports')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /**
   * Read a file and show what WOULD happen. Nothing reaches inventory here.
   *
   * The file is held in memory and never written to disk: a stock list is
   * commercially sensitive, and keeping a copy the shop did not ask us to keep
   * is a liability with no matching benefit. The parsed result is what persists.
   */
  @Post('imports')
  @RequirePermissions('import.run')
  @UseInterceptors(
    FileInterceptor('file', {
      // 10 MB. A stock list of 20 000 rows is well under this; the cap stops a
      // mis-selected video from being read into memory.
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        clientUuid: { type: 'string', format: 'uuid' },
      },
    },
  })
  @ApiOperation({ summary: 'Read a stock file and preview every row; writes no inventory' })
  preview(
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Body('clientUuid') clientUuid?: string,
  ) {
    if (!file) throw new BadRequestException('No file was sent');
    return this.imports.preview(file, clientUuid);
  }

  @Get('imports')
  @RequirePermissions('import.run')
  @ApiOperation({ summary: 'Recent imports for this branch' })
  list() {
    return this.imports.list();
  }

  @Get('imports/:id')
  @RequirePermissions('import.run')
  @ApiOperation({ summary: 'One import, with every row and why it passed or failed' })
  get(@Param('id') id: string) {
    return this.imports.get(id);
  }

  /** Create the stock, from the rows that passed and the mapping already shown. */
  @Post('imports/:id/commit')
  @RequirePermissions('import.run')
  @ApiOperation({ summary: 'Bring in the rows that passed' })
  commit(@Param('id') id: string, @Body() dto: CommitImportDto) {
    return this.imports.commit(id, dto.expectedVersion);
  }
}
