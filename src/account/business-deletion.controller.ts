import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { PlatformAdminService } from '../platform/platform-admin.service';
import { PlatformAdminGuard, type AdminRequest } from '../platform/platform-admin.guard';
import { BusinessDeletionService } from './business-deletion.service';

class PrepareDeletionDto {
  /** An older console's password; the open step-up window is the proof now (`requireStepUp`). */
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class DeleteBusinessDto {
  /** The business's name, typed back exactly as the console shows it. */
  @IsString() @MinLength(1) @MaxLength(160) confirmName!: string;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

/**
 * The console's staged deletion of a business (post-Build-4, `business-deletion.service.ts`). Here, not in the platform
 * module, because the de-identification it applies is the account module's. Both steps need the open step-up window.
 */
@ApiExcludeController()
@Controller({ path: 'platform', version: '1' })
export class BusinessDeletionController {
  constructor(
    private readonly admins: PlatformAdminService,
    private readonly deletions: BusinessDeletionService,
  ) {}

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('businesses/:id/deletion')
  view(@Param('id') id: string) {
    return this.deletions.view(id);
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/deletion/prepare')
  @HttpCode(HttpStatus.OK)
  async prepare(@Param('id') id: string, @Body() _dto: PrepareDeletionDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.requireStepUp(admin);
    return this.deletions.prepare(id, { admin, ip: req.ip ?? null });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/deletion')
  @HttpCode(HttpStatus.OK)
  async delete(@Param('id') id: string, @Body() dto: DeleteBusinessDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.requireStepUp(admin);
    return this.deletions.delete(id, dto.confirmName, { admin, ip: req.ip ?? null });
  }
}
