import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { DeviceCredentialDto, DeviceDto } from './device.dto';

export class LoginDto {
  /**
   * The ONE thing somebody types (CP3).
   *
   * Their phone number or their generated personal ID — whichever is to
   * hand. Never a Store ID: a shopkeeper should not have to know their
   * business's identifier to reach their own till, and the server resolves
   * the company from the credential rather than being told which one to
   * look in.
   */
  @ApiProperty({
    example: 'U-R6H5NWRY',
    maxLength: 120,
    description: 'Phone number or personal ID. One or the other; never a Store ID.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  identifier: string;

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

/**
 * Continuing after the account chooser (CP3).
 *
 * The continuation token is the authority: it was issued from a password that
 * already matched, so this carries no credential of its own. The device fields
 * come along because the chosen account still enrols or recognises a device
 * exactly as a direct sign-in would.
 */
export class ChooseAccountDto {
  @ApiProperty({ description: 'Issued by /auth/login when one phone matched more than one shop' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  continuationToken: string;

  /** An opaque index into the list that was offered — never a user id. */
  @ApiProperty({ example: '0', maxLength: 8 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8)
  accountRef: string;

  @ApiPropertyOptional({ type: DeviceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceDto)
  device?: DeviceDto;

  @ApiPropertyOptional({ type: DeviceCredentialDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceCredentialDto)
  deviceCredential?: DeviceCredentialDto;
}
