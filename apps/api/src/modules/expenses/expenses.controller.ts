import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiIdempotent, IdempotencyKey } from '../../common/idempotency.decorator.js';
import type { Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { CancelExpenseDto, CorrectExpenseDto, OperatingCostDto } from './dto/correct-expense.dto.js';
import { CreateExpenseDto } from './dto/create-expense.dto.js';
import { ExpensePageDto, ExpenseSummaryDto, ExpenseViewDto, ExpensesQueryDto, ExpensesSummaryQueryDto } from './dto/expense-view.dto.js';
import { ExpensesService } from './expenses.service.js';

@ApiTags('expenses')
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @ApiOperation({ summary: 'Registre des dépenses (costs.read) : dépenses validées par défaut ; filtres société, véhicule, catégorie, fournisseur, période, nature, source et incident.' })
  @ApiOkResponse({ type: ExpensePageDto })
  list(@Ctx() ctx: RequestContext, @Query() query: ExpensesQueryDto): Promise<Page<ExpenseViewDto>> {
    return this.expenses.list(ctx, query);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Totaux exacts du registre (costs.read) : par catégorie, net dépenses − avoirs, ligne « Non ventilé », dépenses hors coût d’exploitation. Annulées et remplacées exclues.' })
  @ApiOkResponse({ type: ExpenseSummaryDto })
  summary(@Ctx() ctx: RequestContext, @Query() query: ExpensesSummaryQueryDto): Promise<ExpenseSummaryDto> {
    return this.expenses.summary(ctx, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’une dépense (costs.read ; hors périmètre : introuvable).' })
  @ApiOkResponse({ type: ExpenseViewDto })
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<ExpenseViewDto> {
    return this.expenses.get(ctx, id);
  }

  @Post()
  @HttpCode(201)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Saisir une dépense ou un avoir (costs.write, clé d’idempotence obligatoire) : société imputée = société gestionnaire du véhicule à la date ; référence fournisseur unique.' })
  @ApiCreatedResponse({ type: ExpenseViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateExpenseDto, @IdempotencyKey() key: string): Promise<ExpenseViewDto> {
    return this.expenses.create(ctx, dto, key);
  }

  @Post(':id/correct')
  @HttpCode(201)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Corriger une dépense validée (chef ou administrateur, costs.read et costs.write, motif, clé d’idempotence obligatoire) : nouvelle version, l’ancienne passe REMPLACEE.' })
  @ApiCreatedResponse({ type: ExpenseViewDto })
  correct(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectExpenseDto, @IdempotencyKey() key: string): Promise<ExpenseViewDto> {
    return this.expenses.correct(ctx, id, dto, key);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Annuler une dépense validée (chef ou administrateur, costs.read et costs.write, motif) : le coût disparaît de sa période d’origine.' })
  @ApiOkResponse({ type: ExpenseViewDto })
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelExpenseDto): Promise<ExpenseViewDto> {
    return this.expenses.cancel(ctx, id, dto);
  }

  @Patch(':id/operating-cost')
  @ApiOperation({ summary: 'Inclure ou exclure une dépense du coût d’exploitation (costs.write et costs.read, audité).' })
  @ApiOkResponse({ type: ExpenseViewDto })
  operatingCost(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OperatingCostDto): Promise<ExpenseViewDto> {
    return this.expenses.setOperatingCost(ctx, id, dto);
  }
}
