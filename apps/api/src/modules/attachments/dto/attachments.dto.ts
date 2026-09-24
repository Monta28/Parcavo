import { ApiProperty } from '@nestjs/swagger';

export class AttachmentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() originalName!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() sha256!: string;
  @ApiProperty({ nullable: true, type: String }) ownerType!: string | null;
  @ApiProperty({ nullable: true, type: String }) ownerId!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ description: 'Chemin de téléchargement autorisé (session requise).' }) downloadPath!: string;
}

export class UploadResultDto extends AttachmentViewDto {}
