import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CatalogService } from './catalog.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsDto } from './dto/list-products.dto';

@ApiTags('catalog')
@ApiBearerAuth()
@Controller({ path: 'products', version: '1' })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * The catalog page (G1). Read paths stay open to any signed-in user, because
   * Sell, Receive and Inventory all need to find products; only writes carry
   * `catalog.manage`.
   */
  @Get()
  @ApiOperation({
    summary: 'Browse the catalog: search, filters and cursor pagination',
    description:
      'Search covers brand, model, variant, barcode and specifications. Archived products are hidden unless `active` says otherwise.',
  })
  browse(@Query() query: ListProductsDto) {
    return this.catalog.listPage(query);
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

  /**
   * One product in full. Declared after the fixed paths above so `search`,
   * `suggest` and `recognition` are never swallowed by `:id`.
   *
   * The stock summary covers only branches the caller is assigned to, and
   * individual IMEIs are deliberately absent — unit lists stay on the separately
   * paginated inventory endpoints.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Product detail with stock summary and existing price information' })
  detail(@Param('id') id: string) {
    return this.catalog.getDetail(id);
  }

  /**
   * Final catalog administration (G1).
   *
   * Guarded by `catalog.manage`, NOT `unit.add`. `unit.add` is what lets an
   * employee receive stock, so guarding creation with it meant any employee
   * could shape the catalog. `catalog.manage` is branch-scoped (it is absent
   * from COMPANY_PERMISSIONS), so the caller must present a branch they are
   * really assigned to — the catalog stays company-shared, but the action is
   * attributed to the branch they acted in.
   */
  @Post()
  @RequirePermissions('catalog.manage')
  @ApiOperation({ summary: 'Create a catalog product (exact sellable variant)' })
  create(@Body() dto: CreateProductDto) {
    return this.catalog.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('catalog.manage')
  @ApiOperation({
    summary: 'Edit product metadata',
    description:
      'Identity, category, tracking mode, barcode and specifications. There is deliberately no price or cost field: catalog administration never implies price.edit. Stock, units and sale history are untouched.',
  })
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.catalog.update(id, dto);
  }

  /*
   * Lifecycle. No hard delete, ever — the state is named in the PATH, so a
   * client cannot ask for anything else, and both verbs are idempotent.
   *
   * Archiving hides a product from the catalog and receiving selectors while
   * existing stock stays visible in Inventory and stays sellable until depleted.
   */
  @Patch(':id/archive')
  @RequirePermissions('catalog.manage')
  @ApiOperation({ summary: 'Archive a product (existing stock keeps selling)' })
  archive(@Param('id') id: string) {
    return this.catalog.setActive(id, false);
  }

  @Patch(':id/restore')
  @RequirePermissions('catalog.manage')
  @ApiOperation({ summary: 'Restore an archived product to the catalog' })
  restore(@Param('id') id: string) {
    return this.catalog.setActive(id, true);
  }
}
