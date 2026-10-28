import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ReturnPolicyService } from './return-policy.service';
import { UpdateReturnPolicyDto } from './dto/update-return-policy.dto';

/** The active branch's return policy (0108): read by anyone working there, edited with `return.policy.edit`. */
@ApiTags('settings')
@ApiBearerAuth()
@Controller({ path: 'return-policy', version: '1' })
export class ReturnPolicyController {
  constructor(private readonly policy: ReturnPolicyService) {}

  @Get()
  @ApiOperation({ summary: 'The return policy sales at the active branch are sold under' })
  read() {
    return this.policy.read();
  }

  @Put()
  @RequirePermissions('return.policy.edit')
  @ApiOperation({ summary: "Change the active branch's return policy — future sales only, audited" })
  update(@Body() dto: UpdateReturnPolicyDto) {
    return this.policy.update(dto);
  }
}
