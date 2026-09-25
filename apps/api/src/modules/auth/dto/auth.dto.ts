import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'chef.a@example.tn' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}

export class ForgotPasswordDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Jeton reçu par e-mail (usage unique, durée courte).' })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token!: string;

  @ApiProperty({ format: 'password', minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(256)
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @MaxLength(256)
  currentPassword!: string;

  @ApiProperty({ format: 'password', minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(256)
  newPassword!: string;
}

export class RevokeSessionsDto {
  @ApiPropertyOptional({ description: 'Utilisateur ciblé (administrateur uniquement) ; par défaut soi-même.' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'Conserver la session courante (défaut : vrai pour soi-même).' })
  @IsOptional()
  @IsBoolean()
  keepCurrent?: boolean;
}

export class CompanyGrantDto {
  @ApiProperty() companyId!: string;
  @ApiProperty() companyCode!: string;
  @ApiProperty() companyName!: string;
  @ApiProperty({ enum: ['ADMIN', 'CHEF_PARC', 'OPERATEUR', 'CONDUCTEUR', 'LECTEUR'] }) role!: string;
  @ApiProperty({ type: [String], description: 'Permissions effectives (clés fonctionnelles).' }) permissions!: string[];
}

export class SessionCompanyDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String, description: 'Raison sociale.' }) name!: string;
  @ApiProperty({ type: String }) status!: string;
}

export class SessionInfoDto {
  @ApiProperty() userId!: string;
  @ApiProperty() email!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() organizationId!: string;
  @ApiProperty() organizationName!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() currencyDecimals!: number;
  @ApiProperty() isAdmin!: boolean;
  @ApiProperty() isDriverOnly!: boolean;
  @ApiProperty({ nullable: true, type: String }) driverId!: string | null;
  @ApiProperty({ type: [CompanyGrantDto] }) grants!: CompanyGrantDto[];
  @ApiProperty({ type: [SessionCompanyDto], description: 'Sociétés visibles (toutes pour l’administrateur).' }) companies!: SessionCompanyDto[];
  @ApiProperty() sessionExpiresAt!: string;
  @ApiProperty({ description: 'Canal e-mail configuré côté serveur (SMTP).' }) emailChannelConfigured!: boolean;
}

export class LoginResultDto extends SessionInfoDto {}

export class OkDto {
  @ApiProperty({ example: true }) ok!: boolean;
}
