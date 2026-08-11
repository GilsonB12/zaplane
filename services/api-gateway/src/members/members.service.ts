import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Membros da organização (aba Equipe do painel).
 *
 *  Antes essa aba exibia quatro pessoas fictícias declaradas no frontend.
 *  Aqui devolvemos os usuários reais da organização do JWT — a tabela `users`
 *  já tem organization_id e role desde o schema inicial.
 *
 *  Convite de novo membro ainda não existe: depende de envio de e-mail, que o
 *  projeto não tem. O painel deixa isso explícito em vez de exibir um botão
 *  que não faz nada. */
@Injectable()
export class MembersService {
  constructor(private prisma: PrismaService) {}

  async list(orgId: string) {
    const users = await this.prisma.user.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true, createdAt: true },
      // owner primeiro, depois por data de entrada
      orderBy: [{ createdAt: 'asc' }],
    });

    const peso: Record<string, number> = { owner: 0, admin: 1, operator: 2, viewer: 3 };
    const items = [...users].sort((a, b) => (peso[a.role] ?? 9) - (peso[b.role] ?? 9));

    return { items, total: items.length };
  }
}
