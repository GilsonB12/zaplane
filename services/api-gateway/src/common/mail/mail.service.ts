import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/** Envio de e-mail transacional (Resend).
 *
 *  Isolado atrás desta classe para que trocar de provedor seja reescrever um
 *  arquivo — o resto do sistema só chama `send`.
 *
 *  Sem RESEND_API_KEY configurada, o serviço não quebra: registra no log e
 *  segue. Isso mantém o ambiente de desenvolvimento utilizável sem
 *  credenciais, e evita que uma falha de e-mail derrube um fluxo de negócio.
 *  Em produção, a ausência da chave é logada como erro para não passar
 *  despercebida. */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly apiKey: string;
  private readonly from: string;

  constructor(private config: ConfigService) {
    this.apiKey = this.config.get<string>('mail.resendApiKey') ?? '';
    this.from = this.config.get<string>('mail.from') ?? 'Zaplane <onboarding@resend.dev>';
  }

  get configurado(): boolean {
    return this.apiKey.length > 0;
  }

  async send(params: { to: string; subject: string; html: string; text: string }): Promise<boolean> {
    if (!this.configurado) {
      const msg = `E-mail NÃO enviado (RESEND_API_KEY ausente): "${params.subject}" para ${mascarar(params.to)}`;
      if (this.config.get<string>('env') === 'production') this.logger.error(msg);
      else this.logger.warn(`${msg}\n--- conteúdo (dev) ---\n${params.text}`);
      return false;
    }

    try {
      await axios.post(
        'https://api.resend.com/emails',
        { from: this.from, to: [params.to], subject: params.subject, html: params.html, text: params.text },
        { headers: { Authorization: `Bearer ${this.apiKey}` }, timeout: 15_000 },
      );
      this.logger.log(`E-mail enviado: "${params.subject}" para ${mascarar(params.to)}`);
      return true;
    } catch (e: any) {
      // nunca logamos o corpo do e-mail (pode conter o link de redefinição)
      const detalhe = e?.response?.data?.message ?? e?.response?.status ?? e?.message ?? 'erro desconhecido';
      this.logger.error(`Falha ao enviar e-mail para ${mascarar(params.to)}: ${detalhe}`);
      return false;
    }
  }
}

/** j***@dominio.com — o suficiente para depurar sem despejar e-mail no log. */
function mascarar(email: string): string {
  const [user, dominio] = String(email).split('@');
  if (!dominio) return '***';
  return `${user.slice(0, 1)}***@${dominio}`;
}
