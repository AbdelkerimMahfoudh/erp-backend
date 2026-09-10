import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ScannerService } from './scanner.service';
import { ScanDto } from './dto/scan.dto';

@ApiTags('scanner')
@ApiBearerAuth()
@Controller({ path: 'scan', version: '1' })
export class ScannerController {
  constructor(private readonly scanner: ScannerService) {}

  @Post()
  @ApiOperation({ summary: 'Scan any identifier (IMEI/barcode/serial) → instant product suggestion' })
  scan(@Body() dto: ScanDto) {
    return this.scanner.scan(dto.code, dto.secondary);
  }
}
