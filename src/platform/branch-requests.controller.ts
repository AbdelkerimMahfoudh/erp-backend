import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { actorRef } from '../common/privacy/audit-contact';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { binToUuid, isUuid, uuidToBin } from '../common/utils/uuid.util';
import { BadRequestException } from '@nestjs/common';
import { BranchRequestsService } from './branch-requests.service';

export class CreateBranchRequestDto {
  @IsString() @MaxLength(400) name!: string;
  @IsOptional() @IsString() @MaxLength(400) address?: string;
  @IsString() @MaxLength(80) requestKey!: string;
}

/**
 * Adding a branch from the app (0130; the owner's brief of 2026-11-05) — the Owner only, and only a request: the branch is
 * created pending activation, with no trial, no price, no plan and no way to pay here. Activation is the subscription's,
 * outside the app. Not a business write — like asking for a store on the portal, it records a request — so it is allowed
 * in every state the app opens in.
 */
@ApiTags('branches')
@Controller({ path: 'branches/requests', version: '1' })
export class BranchRequestsController {
  constructor(
    private readonly requests: BranchRequestsService,
    private readonly tenant: TenantContext,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a branch, pending activation (Owner only; idempotent by requestKey)' })
  create(@Body() dto: CreateBranchRequestDto) {
    const userId = this.tenant.requireUserId();
    return this.requests.create(this.tenant.companyId(), userId, dto, actorRef(binToUuid(userId)));
  }

  @Get()
  @ApiOperation({ summary: 'Branches waiting for activation (the Owner sees them; anyone else an empty list)' })
  list() {
    return this.requests.list(this.tenant.companyId(), this.tenant.requireUserId());
  }

  @Get(':id')
  @ApiOperation({ summary: 'One pending branch, read-only (Owner only)' })
  one(@Param('id') id: string) {
    if (!isUuid(id)) throw new BadRequestException({ code: 'branch_request_unknown', message: 'Unknown branch request.' });
    return this.requests.one(this.tenant.companyId(), this.tenant.requireUserId(), uuidToBin(id));
  }
}
