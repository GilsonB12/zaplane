import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '')
    + '-' + Math.random().toString(36).slice(2, 7);
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({ where: { email: dto.email } });
    if (existing) throw new ConflictException('E-mail já cadastrado.');

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    // cria org + usuário owner em transação
    const { user } = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: dto.organizationName, slug: slugify(dto.organizationName) },
      });
      const user = await tx.user.create({
        data: {
          organizationId: org.id,
          email: dto.email,
          name: dto.name,
          passwordHash,
          role: 'owner',
        },
      });
      // NÃO criamos mais canal placeholder aqui. O antigo canal 'LOCAL_DEV'
      // aparecia como "Ativo" no painel de todo cliente novo e era elegível
      // para envio — o dispatcher tentava usar o literal 'LOCAL_DEV' como
      // token e a Meta respondia 401. Organização nova nasce sem canal e o
      // painel orienta a conectar um número de verdade.
      // cria a carteira pré-paga (saldo 0) da org — sem isso, o débito de
      // billing (webhooks.service.ts) cai no ramo "sem carteira provisionada"
      // e nunca desconta nada (ver review B1, Fix 2).
      await tx.wallet.create({ data: { organizationId: org.id, balanceCents: 0 } });
      // cria a assinatura da org já 'inactive' (sem trial — precisa assinar
      // para liberar campanhas/envios via SubscriptionGuard). Orgs que já
      // existiam antes da B2 foram "grandfathered" como 'active' pela
      // migração 005 (backfill); orgs novas passam sempre por aqui.
      // Fix M2 (review final): preço vem do config (mesma fonte usada por
      // BillingService.subscriptionPriceCents), não mais hardcoded — permite
      // ajustar via BILLING_SUBSCRIPTION_PRICE_CENTS sem tocar código.
      await tx.subscription.create({
        data: {
          organizationId: org.id,
          status: 'inactive',
          provider: 'asaas',
          priceCents: this.config.get<number>('billing.subscriptionPriceCents') ?? 14900,
          // cota de mensagens de marketing inclusa na assinatura (consumida em
          // webhooks.service.ts::recordPricing quando a Meta tarifa marketing)
          freeMarketingRemaining: this.config.get<number>('billing.freeMarketingQuota') ?? 200,
        },
      });
      return { org, user };
    });

    return this.issueTokens(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findFirst({ where: { email: dto.email } });
    if (!user || user.status !== 'active') throw new UnauthorizedException('Credenciais inválidas.');
    const ok = await argon2.verify(user.passwordHash, dto.password);
    if (!ok) throw new UnauthorizedException('Credenciais inválidas.');

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.issueTokens(user);
  }

  /** Perfil do usuário autenticado + nome da organização. Usado pelo painel
   *  para exibir quem está logado (antes o nome era literal no JSX) e para
   *  reidratar a identidade depois de um F5, quando só o token sobrevive. */
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, name: true, role: true, organizationId: true,
        organization: { select: { name: true } },
      },
    });
    if (!user) throw new UnauthorizedException('Usuário não encontrado.');
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      organizationName: user.organization?.name ?? null,
    };
  }

  private async issueTokens(user: { id: string; organizationId: string; role: string; email: string }) {
    const payload = { sub: user.id, orgId: user.organizationId, role: user.role, email: user.email };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('jwt.accessSecret'),
      expiresIn: this.config.get<number>('jwt.accessTtl'),
    });
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('jwt.refreshSecret'),
      expiresIn: this.config.get<number>('jwt.refreshTtl'),
    });
    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, role: user.role, organizationId: user.organizationId },
    };
  }
}
