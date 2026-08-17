import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PLATAFORMA_ADMIN_KEY } from '../decorators/plataforma-admin.decorator';

const ctx = (user: any) => ({
  switchToHttp: () => ({ getRequest: () => ({ user }) }),
  getHandler: () => ({}),
  getClass: () => ({}),
}) as any;

const reflector = (respostas: Record<string, any>) => ({
  getAllAndOverride: (key: string) => respostas[key],
}) as any;

describe('RolesGuard', () => {
  it('libera quando a rota nao exige papel nenhum', () => {
    const g = new RolesGuard(reflector({}));
    expect(g.canActivate(ctx({ role: 'operator' }))).toBe(true);
  });

  it('libera quando o papel do usuario esta na lista exigida', () => {
    const g = new RolesGuard(reflector({ [ROLES_KEY]: ['owner', 'admin'] }));
    expect(g.canActivate(ctx({ role: 'admin' }))).toBe(true);
  });

  it('barra quando o papel do usuario nao esta na lista exigida', () => {
    const g = new RolesGuard(reflector({ [ROLES_KEY]: ['owner', 'admin'] }));
    expect(() => g.canActivate(ctx({ role: 'operator' }))).toThrow(ForbiddenException);
  });

  it('libera rota de plataforma mesmo com papel fora da lista da classe', () => {
    // Rota marcada com @PlataformaAdmin() nao e governada pelo RBAC da
    // organizacao -- quem decide e o PlataformaAdminGuard. O RolesGuard sai
    // do caminho mesmo que a CLASSE exija 'owner'/'admin' e o usuario tenha
    // um papel fora dessa lista (ex.: conta de operacao da Zaplane com
    // role 'operator' default, sem papel elevado em nenhuma organizacao).
    const g = new RolesGuard(
      reflector({ [PLATAFORMA_ADMIN_KEY]: true, [ROLES_KEY]: ['owner', 'admin'] }),
    );
    expect(g.canActivate(ctx({ role: 'operator' }))).toBe(true);
  });

  it('rota NAO marcada como plataforma continua barrada como antes', () => {
    // Este e o teste que impede a saida de plataforma de virar um buraco no
    // RBAC do resto do sistema: sem @PlataformaAdmin(), o comportamento
    // antigo (papel fora da lista -> ForbiddenException) se mantem intacto.
    const g = new RolesGuard(
      reflector({ [PLATAFORMA_ADMIN_KEY]: undefined, [ROLES_KEY]: ['owner', 'admin'] }),
    );
    expect(() => g.canActivate(ctx({ role: 'operator' }))).toThrow(ForbiddenException);
  });
});
