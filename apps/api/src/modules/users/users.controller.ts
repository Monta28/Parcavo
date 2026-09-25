import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiPageResponse, type Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { OkDto } from '../auth/dto/auth.dto.js';
import { AccessLinkDto, AccessLinkRequestDto, CreateUserDto, DisableUserDto, SetPasswordDto, UpdateUserDto, UserViewDto, UsersQueryDto } from './dto/users.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Liste des utilisateurs de l’organisation (administrateur).' })
  @ApiPageResponse(UserViewDto)
  list(@Ctx() ctx: RequestContext, @Query() query: UsersQueryDto): Promise<Page<UserViewDto>> {
    return this.users.list(ctx, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’un utilisateur : identité, statut et habilitations (administrateur).' })
  @ApiOkResponse({ type: UserViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<UserViewDto> {
    return this.users.get(ctx, id);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Crée ou invite un utilisateur avec ses habilitations.' })
  @ApiCreatedResponse({ type: UserViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateUserDto): Promise<UserViewDto> {
    return this.users.create(ctx, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modifie l’identité, l’e-mail, les habilitations ou la fiche conducteur liée (administrateur, expectedVersion, audité).' })
  @ApiOkResponse({ type: UserViewDto })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto): Promise<UserViewDto> {
    return this.users.update(ctx, id, dto);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Désactive le compte et révoque ses sessions.' })
  @ApiOkResponse({ type: UserViewDto })
  disable(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DisableUserDto): Promise<UserViewDto> {
    return this.users.disable(ctx, id, dto.reason);
  }

  @Post(':id/enable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Réactive un compte désactivé (administrateur, audité).' })
  @ApiOkResponse({ type: UserViewDto })
  enable(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<UserViewDto> {
    return this.users.enable(ctx, id);
  }

  @Post(':id/set-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Définit le mot de passe d’un utilisateur (administrateur) et révoque ses sessions.' })
  @ApiOkResponse({ type: OkDto })
  async setPassword(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPasswordDto): Promise<OkDto> {
    await this.users.setPassword(ctx, id, dto.password);
    return { ok: true };
  }

  @Post(':id/resend-invitation')
  @HttpCode(200)
  @ApiOperation({ summary: 'Renvoie l’e-mail d’invitation (canal e-mail configuré et compte actif requis).' })
  @ApiOkResponse({ type: OkDto })
  async resendInvitation(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<OkDto> {
    await this.users.resendInvitation(ctx, id);
    return { ok: true };
  }

  @Post(':id/access-link')
  @HttpCode(201)
  @ApiOperation({ summary: 'Génère un lien d’invitation ou de réinitialisation à usage unique, affiché une seule fois (sans e-mail).' })
  @ApiCreatedResponse({ type: AccessLinkDto })
  accessLink(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AccessLinkRequestDto): Promise<AccessLinkDto> {
    return this.users.createAccessLink(ctx, id, dto.purpose);
  }
}
