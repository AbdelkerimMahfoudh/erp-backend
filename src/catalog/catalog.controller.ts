import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CatalogService } from './catalog.service';
import { CreateProductDto } from './dto/create-product.dto';

@ApiTags('catalog')
@ApiBearerAuth()
@Controller({ path: 'products', version: '1' })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'List products' })
  list() {
    return this.catalog.list();
  }

  @Get('search')
  @ApiOperation({ summary: 'Search products by brand/model/variant' })
  search(@Query('q') q: string) {
    return this.catalog.search(q);
  }

  @Get('suggest')
  @ApiOperation({ summary: 'Confirm-card for a product template (by productId or barcode)' })
  suggest(@Query('productId') productId?: string, @Query('barcode') barcode?: string) {
    return this.catalog.findOrSuggest({ productId, barcode });
  }

  @Get('recognition/:imei')
  @ApiOperation({ summary: 'Recognize a product from an IMEI (TAC-based)' })
  recognize(@Param('imei') imei: string) {
    return this.catalog.recognize(imei);
  }

  @Post()
  @RequirePermissions('unit.add')
  @ApiOperation({ summary: 'Create a catalog product' })
  create(@Body() dto: CreateProductDto) {
    return this.catalog.create(dto);
  }
}
