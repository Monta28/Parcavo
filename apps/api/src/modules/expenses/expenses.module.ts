import { Module } from '@nestjs/common';
import { SuppliersModule } from '../suppliers/suppliers.module.js';
import { ExpensesController } from './expenses.controller.js';
import { ExpensesService } from './expenses.service.js';

/** Registre unique des dépenses (CDC 8.4). */
@Module({ imports: [SuppliersModule], controllers: [ExpensesController], providers: [ExpensesService], exports: [ExpensesService] })
export class ExpensesModule {}
