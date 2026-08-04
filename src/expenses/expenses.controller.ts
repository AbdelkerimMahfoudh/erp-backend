import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';

@ApiTags('expenses')
@ApiBearerAuth()
@Controller({ path: 'expenses', version: '1' })
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermissions('expense.manage')
  @ApiOperation({ summary: 'List expenses at the active branch (optionally by date)' })
  @ApiQuery({ name: 'date', required: false, description: 'YYYY-MM-DD' })
  list(@Query('date') date?: string) {
    return this.expenses.list(date);
  }

  @Post()
  @RequirePermissions('expense.manage')
  @ApiOperation({ summary: 'Record an expense (feeds net profit for the day)' })
  create(@Body() dto: CreateExpenseDto) {
    return this.expenses.create(dto);
  }
}
