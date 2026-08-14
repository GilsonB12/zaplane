import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { conferirConfigAssistida, criarMetaNumerosClient, timeoutDaMeta } from './channels.module';

const cfg = (valores: Record<string, any>) => ({ get: (chave: string) => valores[chave] } as any);

const COMPLETA = {
  'assisted.wabaId': 'WABA-ZAPLANE',
  'whatsapp.accessToken': 'TOKEN',
  'whatsapp.graphVersion': 'v21.0',
  env: 'production',
};

describe('ChannelsModule — configuração da conexão assistida no boot', () => {
  let erroLog: jest.SpyInstance;
  beforeEach(() => {
    erroLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as any);
  });
  afterEach(() => erroLog.mockRestore());

  it('recusa iniciar em produção com a WABA definida e o token vazio', () => {
    // Feature ligada pela metade: TODO cliente ouviria "capacidade cheia", que
    // é mentira — mascara falha de credencial. Mesmo remédio do
    // asaas.provider.ts (assertWebhookTokenIsSafe).
    expect(() =>
      conferirConfigAssistida(cfg({ ...COMPLETA, 'whatsapp.accessToken': '' })),
    ).toThrow(/Recusando iniciar em produção/);
  });

  it('fora de produção o mesmo estado só avisa alto', () => {
    expect(() =>
      conferirConfigAssistida(cfg({ ...COMPLETA, 'whatsapp.accessToken': '', env: 'development' })),
    ).not.toThrow();
    expect(erroLog).toHaveBeenCalledWith(expect.stringContaining('WHATSAPP_ACCESS_TOKEN'));
  });

  it('sem ZAPLANE_WABA_ID NÃO derruba o boot, nem em produção', () => {
    // As duas variáveis ainda não existem no Railway. Recusar aqui tiraria do
    // ar campanhas, webhooks de status e cobrança de clientes pagantes por
    // causa de uma feature que nenhum deles usa ainda — a recusa cairia sobre
    // o próprio deploy que traz a correção.
    expect(() =>
      conferirConfigAssistida(cfg({ ...COMPLETA, 'assisted.wabaId': '', 'whatsapp.accessToken': '' })),
    ).not.toThrow();
    expect(erroLog).toHaveBeenCalledWith(expect.stringContaining('CONEXÃO ASSISTIDA DESLIGADA'));
  });

  it('configuração completa sobe sem barulho', () => {
    expect(() => conferirConfigAssistida(cfg(COMPLETA))).not.toThrow();
    expect(erroLog).not.toHaveBeenCalled();
  });
});

describe('ChannelsModule — timeout do client da Meta', () => {
  const original = process.env.META_HTTP_TIMEOUT_MS;
  // Em produção, o ConfigService e o process.env são a MESMA fonte. Este bloco
  // sujava o ambiente antes de cada teste, o que escondia o defeito: enquanto o
  // default do client relia a env var, "abc" chegava como NaN só quando a
  // variável existia de verdade — exatamente o caso de produção. Agora o valor
  // inválido é plantado no ambiente, para o teste correr na condição real.
  beforeEach(() => { process.env.META_HTTP_TIMEOUT_MS = 'abc'; });
  afterAll(() => {
    if (original === undefined) delete process.env.META_HTTP_TIMEOUT_MS;
    else process.env.META_HTTP_TIMEOUT_MS = original;
  });

  it('injeta o valor configurado no client', () => {
    const client = criarMetaNumerosClient(cfg({ ...COMPLETA, META_HTTP_TIMEOUT_MS: '20000' }));
    expect((client as any).timeoutMs).toBe(20000);
    expect((client as any).versao).toBe('v21.0');
  });

  it('valor inválido cai no default em vez de virar NaN', () => {
    // parseInt('abc') é NaN e setTimeout(NaN) dispara na hora: toda chamada à
    // Meta morreria como "tempo esgotado".
    expect(timeoutDaMeta(cfg({ META_HTTP_TIMEOUT_MS: 'abc' }))).toBeUndefined();
    expect(timeoutDaMeta(cfg({ META_HTTP_TIMEOUT_MS: '0' }))).toBeUndefined();
    expect((criarMetaNumerosClient(cfg({ ...COMPLETA, META_HTTP_TIMEOUT_MS: 'abc' })) as any).timeoutMs).toBe(15000);
  });

  it('sem a variável, usa o default do client', () => {
    expect(timeoutDaMeta(cfg({}))).toBeUndefined();
    expect((criarMetaNumerosClient(cfg(COMPLETA)) as any).timeoutMs).toBe(15000);
  });
});
