import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { ReturnPolicyController } from './return-policy.controller';
import { ReturnPolicyService } from './return-policy.service';

@Module({
  controllers: [SettingsController, ReturnPolicyController],
  providers: [SettingsService, ReturnPolicyService],
  exports: [SettingsService, ReturnPolicyService],
})
export class SettingsModule {}
