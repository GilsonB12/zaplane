import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail/mail.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '')
    + '-' + Math.random().toString(36).slice(2, 7);
}

// Guardamos só o hash do refresh token: se o banco vazar, os tokens não são
// reutilizáveis. SHA-256 basta aqui (o token já é aleatório e de alta entropia,
// diferente de uma senha — não precisa de KDF lento).
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private mail: MailService,
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

  /** Inicia a recuperação de senha: gera um token de uso único e manda o link
   *  por e-mail.
   *
   *  A resposta é SEMPRE a mesma, exista o e-mail ou não. Responder "e-mail não
   *  encontrado" transformaria esta rota num verificador de cadastro — daria
   *  para descobrir quem é cliente do Zaplane só testando endereços. */
  async forgotPassword(email: string, ip?: string) {
    const respostaNeutra = {
      ok: true,
      message: 'Se este e-mail estiver cadastrado, enviamos as instruções de redefinição.',
    };

    const normalizado = String(email ?? '').trim().toLowerCase();
    if (!normalizado) return respostaNeutra;

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: normalizado, mode: 'insensitive' } },
    });
    if (!user || user.status !== 'active') return respostaNeutra;

    // invalida pedidos anteriores ainda abertos: um clique novo deve tornar o
    // link antigo inútil (senão vários links válidos circulam pela caixa)
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = randomBytes(32).toString('base64url');
    const validadeMin = 60;
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + validadeMin * 60 * 1000),
        requestedIp: ip ?? null,
      },
    });

    const base = this.config.get<string>('appPublicUrl') ?? 'https://zaplane.com.br';
    const link = `${base}/?redefinir=${token}`;
    await this.mail.send({
      to: user.email,
      subject: 'Redefinir sua senha do Zaplane',
      text:
        `Olá${user.name ? `, ${user.name}` : ''}.\n\n` +
        `Recebemos um pedido para redefinir a senha da sua conta no Zaplane.\n\n` +
        `Abra este link para escolher uma nova senha (vale por ${validadeMin} minutos):\n${link}\n\n` +
        `Se não foi você que pediu, ignore este e-mail — sua senha continua a mesma.`,
      html: emailRedefinicaoHtml(user.name, link, validadeMin),
    });

    return respostaNeutra;
  }

  /** Conclui a redefinição: valida o token, troca a senha e encerra todas as
   *  sessões abertas (se a senha foi redefinida por suspeita de invasão, deixar
   *  sessões antigas vivas anularia o efeito). */
  async resetPassword(token: string, novaSenha: string) {
    if (!token || !novaSenha || novaSenha.length < 8) {
      throw new BadRequestException('Link inválido ou senha muito curta (mínimo 8 caracteres).');
    }

    const registro = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!registro || registro.usedAt || registro.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Este link expirou ou já foi usado. Peça um novo.');
    }

    const passwordHash = await argon2.hash(novaSenha, { type: argon2.argon2id });

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: registro.userId }, data: { passwordHash } }),
      this.prisma.passwordResetToken.update({
        where: { id: registro.id },
        data: { usedAt: new Date() },
      }),
      // derruba sessões antigas: quem tinha o token roubado perde o acesso
      this.prisma.refreshToken.updateMany({
        where: { userId: registro.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    this.logger.log(`Senha redefinida para o usuário ${registro.userId}; sessões anteriores revogadas.`);
    return { ok: true, message: 'Senha redefinida. Faça login com a nova senha.' };
  }

  /** Troca um refresh token válido por um par novo (access + refresh).
   *
   *  O access token dura 15 minutos de propósito — curto o suficiente para
   *  limitar o estrago de um vazamento. Sem esta rota, porém, o usuário era
   *  jogado na tela de login a cada 15 minutos, perdendo o que estivesse
   *  fazendo; o refresh token já era emitido no login e simplesmente jogado
   *  fora pelo painel.
   *
   *  ROTAÇÃO COM DETECÇÃO DE REÚSO: cada refresh é de uso único — ao ser
   *  usado, é revogado e um novo é emitido. Se um token já revogado for
   *  apresentado, tratamos como indício de roubo (alguém está usando uma
   *  cópia) e revogamos TODAS as sessões do usuário, forçando novo login. */
  async refresh(refreshToken: string) {
    if (!refreshToken) throw new UnauthorizedException('Sessão inválida.');

    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Sessão expirada. Entre novamente.');
    }

    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findFirst({
      where: { tokenHash, userId: payload.sub },
    });

    if (!stored) {
      // assinatura válida mas token desconhecido: sessão antiga de antes deste
      // recurso existir, ou banco limpo. Exige login novo, sem alarde.
      throw new UnauthorizedException('Sessão expirada. Entre novamente.');
    }

    if (stored.revokedAt) {
      this.logger.warn(
        `Refresh token já revogado reapresentado (usuário ${payload.sub}) — revogando todas as sessões.`,
      );
      await this.prisma.refreshToken.updateMany({
        where: { userId: payload.sub, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Sessão encerrada por segurança. Entre novamente.');
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Sessão expirada. Entre novamente.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== 'active') throw new UnauthorizedException('Usuário inativo.');

    // consome o token atual e emite o próximo
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens(user);
  }

  /** Encerra a sessão: revoga o refresh token apresentado. Sem isso, um token
   *  roubado continuaria válido por 30 dias mesmo depois de "sair". */
  async logout(refreshToken?: string) {
    if (!refreshToken) return { ok: true };
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  private async issueTokens(user: { id: string; organizationId: string; role: string; email: string }) {
    const payload = { sub: user.id, orgId: user.organizationId, role: user.role, email: user.email };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('jwt.accessSecret'),
      expiresIn: this.config.get<number>('jwt.accessTtl'),
    });
    const refreshTtl = this.config.get<number>('jwt.refreshTtl') ?? 2592000;
    // `jti` único por emissão. Sem ele, dois refresh emitidos no MESMO segundo
    // sairiam byte a byte idênticos (payload e `iat` iguais) — e como o token
    // anterior acabou de ser revogado, o "novo" bateria com um hash revogado e
    // a rotação seria interpretada como reúso, derrubando todas as sessões do
    // usuário. Foi exatamente o que o teste de rotação apanhou.
    const refreshToken = await this.jwt.signAsync(
      { ...payload, jti: randomUUID() },
      { secret: this.config.get('jwt.refreshSecret'), expiresIn: refreshTtl },
    );

    // persiste o hash para permitir rotação e revogação
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, role: user.role, organizationId: user.organizationId },
    };
  }
}

/** Corpo do e-mail de redefinição. HTML em tabela e estilo inline porque
 *  cliente de e-mail ignora CSS externo e trata flex/grid de forma irregular. */
function emailRedefinicaoHtml(nome: string | null, link: string, minutos: number): string {
  const saudacao = nome ? `Olá, ${escapar(nome)}` : 'Olá';
  return `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:24px;background:#f4f6f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e9e5;">
    <tr><td style="padding:22px 26px 0;">
      <div style="font-size:17px;font-weight:700;color:#0F8C5A;letter-spacing:-.02em;">Zaplane</div>
    </td></tr>
    <tr><td style="padding:14px 26px 0;">
      <h1 style="margin:0;font-size:19px;line-height:1.3;color:#0C1F17;">Redefinir sua senha</h1>
      <p style="margin:10px 0 0;font-size:14px;line-height:1.55;color:#3B4E45;">
        ${saudacao}. Recebemos um pedido para redefinir a senha da sua conta no Zaplane.
      </p>
    </td></tr>
    <tr><td style="padding:20px 26px 0;">
      <a href="${link}" style="display:inline-block;background:#0F8C5A;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-size:14px;font-weight:600;">
        Escolher nova senha
      </a>
      <p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#6C7F75;">
        O link vale por ${minutos} minutos e só pode ser usado uma vez.
      </p>
    </td></tr>
    <tr><td style="padding:18px 26px 24px;">
      <p style="margin:0;font-size:12px;line-height:1.5;color:#6C7F75;border-top:1px solid #e3e9e5;padding-top:14px;">
        Se não foi você que pediu, ignore este e-mail — sua senha continua a mesma.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function escapar(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
