import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CustomersService } from './customers.service';
import { CreateCustomerDto, ListCustomersDto } from './dto/customer.dto';

@ApiTags('customers')
@ApiBearerAuth()
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  /**
   * Finding a customer is part of selling, so this is gated on `sale.create`
   * rather than on customer administration.
   *
   * The alternative — a separate read permission — would mean a cashier who may
   * take a credit sale could not find the person to attribute it to, and credit
   * sales REQUIRE a customer. Gating the list would gate the sale.
   */
  @Get()
  @RequirePermissions('sale.create')
  @ApiOperation({ summary: 'Find a customer by name, phone or id' })
  list(@Query() query: ListCustomersDto) {
    return this.customers.list(query);
  }

  /**
   * Creating one is a separate authority: `customer.manage`.
   *
   * A shop that wants its customer list curated can withhold it and still sell
   * — the cashier picks from what exists, or sells to nobody in particular,
   * which an ordinary cash sale does not need anyway.
   */
  @Post()
  @RequirePermissions('customer.manage')
  @ApiOperation({ summary: 'Add a customer from the till' })
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto);
  }
}
