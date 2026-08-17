import { ForbiddenException } from '@nestjs/common';
import { PlataformaAdminGuard } from './plataforma-admin.guard';

const ctx = (user: any) => ({
  switchToHttp: () => ({ getRequest: () => ({ user }) }),
  getHandler: () => ({}),
  getClass: () => ({}),
}) as any;

const reflector = (exigido: boolean) => ({ getAllAndOverride: () => exigido } as any);
const prisma = (u: any) => ({ user: { findUnique: jest.fn().mockResolvedValue(u) } } as any);

describe('PlataformaAdminGuard', () => {
  it('libera rota que nao exige admin de plataforma', async () => {
    const g = new PlataformaAdminGuard(reflector(false), prisma(null));
    expect(await g.canActivate(ctx({ userId: 'u' }))).toBe(true);
  });

  it('libera admin de plataforma ativo', async () => {
    const g = new PlataformaAdminGuard(reflector(true), prisma({ isPlatformAdmin: true, status: 'active' }));
    expect(await g.canActivate(ctx({ userId: 'u' }))).toBe(true);
  });

  it('barra owner de cliente comum', async () => {
    const g = new PlataformaAdminGuard(reflector(true), prisma({ isPlatformAdmin: false, status: 'active' }));
    await expect(g.canActivate(ctx({ userId: 'u', role: 'owner' }))).rejects.toThrow(ForbiddenException);
  });

  it('barra admin de plataforma desativado', async () => {
    const g = new PlataformaAdminGuard(reflector(true), prisma({ isPlatformAdmin: true, status: 'disabled' }));
    await expect(g.canActivate(ctx({ userId: 'u' }))).rejects.toThrow(ForbiddenException);
  });

  it('barra usuario que nao existe mais', async () => {
    const g = new PlataformaAdminGuard(reflector(true), prisma(null));
    await expect(g.canActivate(ctx({ userId: 'u' }))).rejects.toThrow(ForbiddenException);
  });

  it('le do BANCO, nao do JWT', async () => {
    // um token emitido antes de a flag ser revogada nao pode continuar valendo
    const p = prisma({ isPlatformAdmin: false, status: 'active' });
    const g = new PlataformaAdminGuard(reflector(true), p);
    await expect(g.canActivate(ctx({ userId: 'u', isPlatformAdmin: true }))).rejects.toThrow(ForbiddenException);
    expect(p.user.findUnique).toHaveBeenCalled();
  });
});
