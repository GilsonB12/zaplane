import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ContactsService } from './contacts.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { QueryContactsDto } from './dto/query-contacts.dto';
import { ImportContactsDto } from './dto/import-contacts.dto';

@Controller('contacts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(@CurrentUser('organizationId') orgId: string, @Query() q: QueryContactsDto) {
    return this.contacts.list(orgId, q);
  }

  @Post()
  @Roles('owner', 'admin', 'operator')
  create(@CurrentUser('organizationId') orgId: string, @Body() dto: CreateContactDto) {
    return this.contacts.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('owner', 'admin', 'operator')
  update(
    @CurrentUser('organizationId') orgId: string,
    @Param('id') id: string,
    @Body() dto: Partial<CreateContactDto>,
  ) {
    return this.contacts.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  remove(@CurrentUser('organizationId') orgId: string, @Param('id') id: string) {
    return this.contacts.remove(orgId, id);
  }

  @Post(':id/opt-out')
  @Roles('owner', 'admin', 'operator')
  optOut(@CurrentUser('organizationId') orgId: string, @Param('id') id: string) {
    return this.contacts.optOut(orgId, id);
  }

  @Post('import')
  @Roles('owner', 'admin', 'operator')
  @UseInterceptors(FileInterceptor('file'))
  import(
    @CurrentUser('organizationId') orgId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: ImportContactsDto,
  ) {
    return this.contacts.importFile(orgId, file, dto);
  }
}
