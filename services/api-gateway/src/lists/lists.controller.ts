import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ListsService } from './lists.service';

@Controller('lists')
@UseGuards(JwtAuthGuard)
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  @Get()
  findAll(@CurrentUser('organizationId') orgId: string) {
    return this.lists.findAll(orgId);
  }

  @Post()
  create(@CurrentUser('organizationId') orgId: string, @Body() dto: { name: string; type?: string; rule?: any }) {
    return this.lists.create(orgId, dto);
  }

  @Post(':id/contacts')
  addContacts(
    @CurrentUser('organizationId') orgId: string,
    @Param('id') id: string,
    @Body() dto: { contactIds: string[] },
  ) {
    return this.lists.addContacts(orgId, id, dto.contactIds ?? []);
  }
}
