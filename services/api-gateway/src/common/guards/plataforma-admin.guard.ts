import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { PLATAFORMA_ADMIN_KEY } from '../decorators/plataforma-admin.decorator';

/** Autoriza ação de plataforma.
 *
 *  O RBAC do projeto tem papéis DENTRO da organização (owner/admin/operator/
 *  viewer), então `@Roles('owner')` é alcançável pelo dono de qualquer cliente.
 *  Rota de plataforma precisa de outro eixo.
 *
 *  Lê a flag do BANCO e não do JWT de propósito: com a flag no token, revogar o
 *  acesso só teria efeito quando o token expirasse. São duas rotas raras, o
 *  custo da consulta é irrelevante. */
@Injectable()
export class PlataformaAdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const exigido = this.reflector.getAllAndOverride<boolean>(PLATAFORMA_ADMIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!exigido) return true;

    const { user } = context.switchToHttp().getRequest();
    const negar = () => {
      throw new ForbiddenException('Ação restrita à operação da Zaplane.');
    };
    if (!user?.userId) return negar();

    const u = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { isPlatformAdmin: true, status: true },
    });
    if (!u || !u.isPlatformAdmin || u.status !== 'active') return negar();
    return true;
  }
}
