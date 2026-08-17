import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PLATAFORMA_ADMIN_KEY } from '../common/decorators/plataforma-admin.decorator';
import { PlataformaAdminGuard } from '../common/guards/plataforma-admin.guard';
import { TemplatesController } from './templates.controller';

describe('TemplatesController — rota de plataforma e o guard que a protege', () => {
  it('tem rota marcada como de plataforma', () => {
    // Âncora do teste seguinte: sem uma rota de plataforma neste controller, a
    // exigência do guard seria vazia e passaria por acidente.
    expect(Reflect.getMetadata(PLATAFORMA_ADMIN_KEY, TemplatesController.prototype.criarGenerico)).toBe(true);
  });

  it('anexa o PlataformaAdminGuard no @UseGuards da classe', () => {
    // Esta é a trava que faltava. O RolesGuard devolve `true` para qualquer
    // rota marcada com @PlataformaAdmin(), delegando a decisão ao
    // PlataformaAdminGuard — mas ele NÃO é APP_GUARD, é anexado à mão aqui.
    // Tirá-lo do @UseGuards (um refactor de import, um merge malfeito) deixava
    // `tsc` limpo, a suíte verde e POST /templates/platform alcançável por
    // QUALQUER usuário autenticado de QUALQUER organização, criando templates
    // de escopo 'platform' que todo cliente assistido vê. Testar o metadado do
    // decorador não pega isso; só a presença do guard pega.
    const guards = Reflect.getMetadata(GUARDS_METADATA, TemplatesController) ?? [];
    expect(guards).toContain(PlataformaAdminGuard);
  });
});

describe('TemplatesController — POST /templates/sync', () => {
  it('exige papel de dono ou admin da organizacao', () => {
    // A rota passou a dirigir o token de System User da PLATAFORMA quando quem
    // chama é cliente assistido. Sem @Roles, um 'viewer' de qualquer cliente
    // assistido gastava a cota da Graph API compartilhada com o dispatcher.
    expect(Reflect.getMetadata(ROLES_KEY, TemplatesController.prototype.sync)).toEqual(['owner', 'admin']);
  });

  it('tem limite de taxa proprio, mais apertado que o global por inquilino', () => {
    // O balde global é 300 req/min por usuário e cada sync faz até 10 páginas
    // de GET /{waba}/message_templates — sem limite dedicado, uma única conta
    // de cliente chegava a milhares de chamadas Graph por minuto contra a WABA
    // e o app da Zaplane.
    const limite = Reflect.getMetadata(`${THROTTLER_LIMIT}default`, TemplatesController.prototype.sync);
    const janela = Reflect.getMetadata(`${THROTTLER_TTL}default`, TemplatesController.prototype.sync);
    expect(typeof limite).toBe('number');
    expect(limite).toBeLessThanOrEqual(10);
    expect(janela).toBe(60_000);
  });
});
