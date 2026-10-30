import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID } from 'class-validator';

export const CHANGEABLE_ROLES = ['store_manager', 'store_employee'] as const;
export type ChangeableRole = (typeof CHANGEABLE_ROLES)[number];

/**
 * Make a staff member a Manager or an Employee (D225). Never the Owner: the field accepts only these two, and the
 * service refuses any person who holds the Owner role anywhere.
 */
export class ChangeRoleDto {
  @ApiProperty({ enum: CHANGEABLE_ROLES })
  @IsIn(CHANGEABLE_ROLES)
  role: ChangeableRole;

  /**
   * Promotion: the stores the new Manager manages. Demotion: the stores the person keeps working in, as an Employee —
   * every other store they managed is left. At least one either way.
   */
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  branchIds: string[];
}
