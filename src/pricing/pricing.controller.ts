import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { PricingService } from './pricing.service';
import {
  PriceHistoryQueryDto,
  RemovePriceDto,
  SetPriceDto,
  SetQuantityPriceDto,
} from './dto/pricing.dto';

/**
 * Pricing.
 *
 * Every route names exactly what it acts on. There is deliberately no generic
 * "set a price" endpoint taking a model, field, permission or branch from the
 * body: such an endpoint is only ever as safe as its longest allowlist, and the
 * branch in particular must come from the request's active-branch context, which
 * `PermissionsGuard` has already proven the caller may act in.
 *
 * Reads of the effective price are open to any signed-in user — an employee at
 * the counter has to know what to charge. Writes and history require
 * `price.edit`, which is branch-scoped and delegated per branch, so holding it
 * in one branch grants nothing in another.
 */
@ApiTags('pricing')
@ApiBearerAuth()
@Controller({ path: 'pricing', version: '1' })
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  // ───────────────────────────── reads ─────────────────────────────

  @Get('products/:productId')
  @ApiOperation({
    summary: 'Effective price of a product in the active branch',
    description: 'Returns the price, which rung of the ladder produced it, and what removal would reveal.',
  })
  product(@Param('productId') productId: string) {
    return this.pricing.getProductPricing(productId);
  }

  @Get('units/:identifier')
  @ApiOperation({
    summary: 'Effective price of one exact item, by scanned or typed IMEI/serial',
    description: 'An override belonging to another branch is reported as ignored, never applied.',
  })
  unit(@Param('identifier') identifier: string) {
    return this.pricing.getUnitPricing(identifier);
  }

  @Get('history')
  @RequirePermissions('price.edit')
  @ApiOperation({ summary: 'Price change history for the active branch (keyset paginated)' })
  history(@Query() query: PriceHistoryQueryDto) {
    return this.pricing.history(query);
  }

  // ───────────────────── branch price, exact variant ─────────────────────

  @Put('products/:productId/branch-price')
  @RequirePermissions('price.edit')
  @ApiOperation({
    summary: 'Set this variant’s price in the active branch',
    description: 'Send `expectedVersion` when a price already exists; omit it only for the first one.',
  })
  setBranchPrice(@Param('productId') productId: string, @Body() dto: SetPriceDto) {
    return this.pricing.setBranchVariantPrice(productId, dto);
  }

  @Delete('products/:productId/branch-price')
  @RequirePermissions('price.edit')
  @ApiOperation({ summary: 'Remove the branch price and reveal the fallback' })
  removeBranchPrice(@Param('productId') productId: string, @Body() dto: RemovePriceDto) {
    return this.pricing.removeBranchVariantPrice(productId, dto);
  }

  // ───────────────────── quantity stock branch price ─────────────────────

  @Put('products/:productId/stock-price')
  @RequirePermissions('price.edit')
  @ApiOperation({
    summary: 'Change a quantity product’s branch price',
    description: 'Updates the existing stock row — quantity stock has no second price source.',
  })
  setStockPrice(@Param('productId') productId: string, @Body() dto: SetQuantityPriceDto) {
    return this.pricing.setQuantityPrice(productId, dto);
  }

  // ─────────────────────── one exact item’s price ───────────────────────

  @Put('units/:identifier/price')
  @RequirePermissions('price.edit')
  @ApiOperation({ summary: 'Give one exact item its own price' })
  setUnitPrice(@Param('identifier') identifier: string, @Body() dto: SetPriceDto) {
    return this.pricing.setUnitOverride(identifier, dto);
  }

  @Delete('units/:identifier/price')
  @RequirePermissions('price.edit')
  @ApiOperation({ summary: 'Remove one item’s own price and reveal the fallback' })
  removeUnitPrice(@Param('identifier') identifier: string, @Body() dto: RemovePriceDto) {
    return this.pricing.removeUnitOverride(identifier, dto);
  }
}
