import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, Role } from '../decorators/roles.decorator';
import { PLATAFORMA_ADMIN_KEY } from '../decorators/plataforma-admin.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Rota marcada com @PlataformaAdmin() não é governada pelo RBAC da
    // organização — quem decide é o PlataformaAdminGuard. Sem esta saída, o
    // `@Roles(...)` da CLASSE (herdado via getAllAndOverride quando a rota
    // não tem `@Roles` próprio) barraria contas de operação da Zaplane que
    // não têm papel owner/admin em nenhuma organização.
    const plataforma = this.reflector.getAllAndOverride<boolean>(PLATAFORMA_ADMIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (plataforma) return true;

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const { user } = context.switchToHttp().getRequest();
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('Permissao insuficiente para esta acao.');
    }
    return true;
  }
}
