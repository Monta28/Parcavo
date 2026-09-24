import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { PERMISSIONS, ROLES, type PermissionKey, type RoleKey } from '@parc-auto/contracts';
import { PageQueryDto } from '../../../common/pagination.js';

export class MembershipInputDto {
  @ApiPropertyOptional({ description: 'Société ; null pour le rôle ADMIN (niveau groupe).', nullable: true })
  @IsOptional()
  @IsUUID()
  companyId?: string | null;

  @ApiProperty({ enum: ROLES })
  @IsIn(ROLES)
  role!: RoleKey;

  @ApiPropertyOptional({ enum: PERMISSIONS, isArray: true, description: 'Permissions ajoutées au rôle.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(PERMISSIONS, { each: true })
  grantedPermissions?: PermissionKey[];

  @ApiPropertyOptional({ enum: PERMISSIONS, isArray: true, description: 'Permissions retirées au rôle.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(PERMISSIONS, { each: true })
  revokedPermissions?: PermissionKey[];
}

export class CreateUserDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) firstName!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) lastName!: string;
  @ApiPropertyOptional({ description: 'Mot de passe initial ; sinon invitation par e-mail (lien de définition).', format: 'password' })
  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(256)
  password?: string;
  @ApiProperty({ type: [MembershipInputDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MembershipInputDto)
  memberships!: MembershipInputDto[];
  @ApiPropertyOptional({ description: 'Conducteur à lier au compte.' })
  @IsOptional()
  @IsUUID()
  driverId?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @ApiPropertyOptional({ type: [MembershipInputDto], description: 'Remplace l’ensemble des habilitations.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MembershipInputDto)
  memberships?: MembershipInputDto[];
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() driverId?: string | null;
  @ApiProperty() @Type(() => Number) expectedVersion!: number;
}

export class DisableUserDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class SetPasswordDto {
  @ApiProperty({ format: 'password' }) @IsString() @MinLength(12) @MaxLength(256) password!: string;
}

export class UsersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIF', 'DESACTIVE'] })
  @IsOptional()
  @IsEnum({ ACTIF: 'ACTIF', DESACTIVE: 'DESACTIVE' })
  status?: 'ACTIF' | 'DESACTIVE';

  @ApiPropertyOptional({ description: 'Filtre sur une société d’habilitation.' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() includeDisabled?: boolean;
}

export class MembershipViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) companyId!: string | null;
  @ApiProperty({ nullable: true, type: String }) companyCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) companyName!: string | null;
  @ApiProperty({ enum: ROLES }) role!: RoleKey;
  @ApiProperty({ enum: PERMISSIONS, isArray: true }) grantedPermissions!: PermissionKey[];
  @ApiProperty({ enum: PERMISSIONS, isArray: true }) revokedPermissions!: PermissionKey[];
  @ApiProperty({ enum: PERMISSIONS, isArray: true }) effectivePermissions!: PermissionKey[];
}

export class UserViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({ enum: ['ACTIF', 'DESACTIVE'] }) status!: string;
  @ApiProperty({ nullable: true, type: String }) lastLoginAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) driverId!: string | null;
  @ApiProperty() hasPassword!: boolean;
  @ApiProperty({ type: [MembershipViewDto] }) memberships!: MembershipViewDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() version!: number;
}

export class AccessLinkRequestDto {
  @ApiProperty({ enum: ['INVITATION', 'REINITIALISATION'], description: 'Invitation (72 h) ou réinitialisation (30 min).' })
  @IsIn(['INVITATION', 'REINITIALISATION'])
  purpose!: 'INVITATION' | 'REINITIALISATION';
}

export class AccessLinkDto {
  @ApiProperty({ description: 'Lien à usage unique, affiché une seule fois ; seule son empreinte est conservée.' }) link!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
