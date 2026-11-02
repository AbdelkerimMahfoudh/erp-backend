import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class StartPasswordChangeDto {
  @IsString() @MinLength(1) @MaxLength(128) currentPassword!: string;
  @IsOptional() @IsIn(['en', 'fr', 'ar']) language?: 'en' | 'fr' | 'ar';
}

export class ConfirmPasswordChangeDto {
  @IsUUID() changeId!: string;
  @IsString() @MaxLength(12) code!: string;
  @IsString() @MaxLength(128) newPassword!: string;
}

export class StartContactChangeDto {
  @IsIn(['phone', 'email']) kind!: 'phone' | 'email';
  @IsString() @MaxLength(160) value!: string;
  @IsString() @MinLength(1) @MaxLength(128) currentPassword!: string;
  @IsOptional() @IsIn(['en', 'fr', 'ar']) language?: 'en' | 'fr' | 'ar';
  @IsOptional() @IsString() @MaxLength(32) whatsappConsentVersion?: string;
  @IsOptional() @IsIn(['en', 'fr', 'ar']) whatsappConsentLocale?: 'en' | 'fr' | 'ar';
}

export class ChangeCodeDto {
  @IsUUID() changeId!: string;
  @IsString() @MaxLength(12) code!: string;
  @IsOptional() @IsIn(['en', 'fr', 'ar']) language?: 'en' | 'fr' | 'ar';
}

export class CancelChangeDto {
  @IsUUID() changeId!: string;
}
