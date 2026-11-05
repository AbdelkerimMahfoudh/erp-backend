import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { isUuid, uuidToBin } from '../common/utils/uuid.util';
import { NoticeService } from '../notices/notice.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAdminGuard, type AdminRequest } from './platform-admin.guard';
import { PlatformAuditService } from './platform-audit.service';

export class ResendBranchNoticeDto {
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

/**
 * The administrator's resend of a pending branch's activation notice (0130): the same notice waits again — never a second
 * notice, never a second branch — and the resend is audited with its reason.
 */
@ApiExcludeController()
@Controller({ path: 'platform/admin/branch-requests', version: '1' })
export class BranchNoticeAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notices: NoticeService,
    private readonly audit: PlatformAuditService,
  ) {}

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post(':id/resend-notice')
  @HttpCode(HttpStatus.OK)
  async resend(@Param('id') id: string, @Body() dto: ResendBranchNoticeDto, @Req() req: AdminRequest) {
    if (!isUuid(id)) throw new BadRequestException({ code: 'branch_request_unknown', message: 'Unknown branch request.' });
    const row = await this.prisma.seatAllocation.findFirst({ where: { id: uuidToBin(id), kind: 'store' }, select: { id: true, companyId: true, label: true } });
    if (!row) throw new BadRequestException({ code: 'branch_request_unknown', message: 'Unknown branch request.' });
    const outcome = await this.notices.resendBranchActivation(row.companyId, row.id);
    await this.audit.record({
      admin: req.platformAdmin!, action: 'branch.notice_resend', targetType: 'seat_allocation', targetId: row.id,
      targetLabel: row.label, reason: dto.reason, after: { outcome }, ip: req.ip,
    });
    return { outcome };
  }
}
