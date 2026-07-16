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
      // cria canal placeholder para que a org possa enfileirar localmente
      // sem credenciais reais da Meta (dispensado por looksConfigured)
      await tx.whatsappChannel.create({
        data: {
          organizationId: org.id,
          label: 'Canal padrão',
          phoneNumberId: 'LOCAL_DEV',
          wabaId: 'LOCAL_DEV',
          accessTokenEnc: 'LOCAL_DEV',
          status: 'active',
        },
      });
      // cria a carteira pré-paga (saldo 0) da org — sem isso, o débito de
      // billing (webhooks.service.ts) cai no ramo "sem carteira provisionada"
      // e nunca desconta nada (ver review B1, Fix 2). Assinatura (B2) NÃO é
      // provisionada aqui.
      await tx.wallet.create({ data: { organizationId: org.id, balanceCents: 0 } });
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
