import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { DeviceCredentialDto, DeviceDto } from './device.dto';

export class LoginDto {
  @ApiProperty({ example: 'owner', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  login: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password: string;

  @ApiPropertyOptional({ type: DeviceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceDto)
  device?: DeviceDto;

  @ApiPropertyOptional({ type: DeviceCredentialDto, description: 'Device identity (F1 Stage 3). Omit on first sign-in to enroll.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceCredentialDto)
  deviceCredential?: DeviceCredentialDto;
}
