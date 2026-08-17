import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PLATAFORMA_ADMIN_KEY } from '../../common/decorators/plataforma-admin.decorator';
import { AssistedController } from './assisted.controller';

const ORG = 'ORG';
const ORFAO = { phoneNumberId: 'PN2', motivo: 'sem dono no banco' };

function montar(wabaId = 'WABA-ZAPLANE') {
  const assisted = {
    atual: jest.fn().mockResolvedValue({ solicitacao: null }),
    iniciar: jest.fn().mockResolvedValue({ id: 'REQ' }),
    reenviar: jest.fn().mockResolvedValue({ ok: true }),
    verificar: jest.fn().mockResolvedValue({ canalId: 'CH' }),
    cancelar: jest.fn().mockResolvedValue({ ok: true }),
  } as any;
  const reconciliacao = { orfaos: jest.fn().mockResolvedValue([ORFAO]) } as any;
  const config = { get: (chave: string) => (chave === 'assisted.wabaId' ? wabaId : undefined) } as any;
  return { ctrl: new AssistedController(assisted, reconciliacao, config), assisted, reconciliacao };
}

describe('AssistedController — rota de reconciliação', () => {
  it('expõe os órfãos da WABA da plataforma', async () => {
    // Sem esta rota o ReconciliacaoService é código morto: não há agendador
    // nem script no projeto que o chame.
    const { ctrl, reconciliacao } = montar();
    expect(await ctrl.orfaos()).toEqual({ orfaos: [ORFAO] });
    expect(reconciliacao.orfaos).toHaveBeenCalled();
  });

  it('é restrita a admin de plataforma, fora do RBAC da organização', () => {
    // A resposta é operacional (varre a WABA inteira, não a organização de
    // quem chamou): o RBAC da classe ('owner'/'admin', dentro da organização)
    // não é a barreira certa aqui — quem decide é a flag is_platform_admin,
    // checada pelo PlataformaAdminGuard via @PlataformaAdmin().
    expect(Reflect.getMetadata(PLATAFORMA_ADMIN_KEY, AssistedController.prototype.orfaos)).toBe(true);
    expect(Reflect.getMetadata(ROLES_KEY, AssistedController)).toEqual(['owner', 'admin']);
  });
});

describe('AssistedController — conexão assistida sem ZAPLANE_WABA_ID', () => {
  it('responde 503 honesto em vez de "capacidade cheia", sem chamar a Meta', async () => {
    const { ctrl, assisted } = montar('');
    const dto = { telefone: '85998062656', nomeExibicao: 'Petshop', aceitouPreRequisito: true } as any;
    expect(() => ctrl.iniciar(ORG, 'USER', dto)).toThrow(ServiceUnavailableException);
    expect(() => ctrl.reenviar(ORG, 'REQ', {} as any)).toThrow(ServiceUnavailableException);
    expect(() => ctrl.verificar(ORG, 'REQ', { codigo: '123456' } as any)).toThrow(
      ServiceUnavailableException,
    );
    await expect(ctrl.orfaos()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(assisted.iniciar).not.toHaveBeenCalled();
    expect(assisted.reenviar).not.toHaveBeenCalled();
    expect(assisted.verificar).not.toHaveBeenCalled();
  });

  it('não bloqueia consulta nem cancelamento: são locais e tiram o cliente do limbo', async () => {
    const { ctrl, assisted } = montar('');
    await expect(ctrl.atual(ORG)).resolves.toEqual({ solicitacao: null });
    await expect(ctrl.cancelar(ORG, 'REQ')).resolves.toEqual({ ok: true });
    expect(assisted.cancelar).toHaveBeenCalledWith(ORG, 'REQ');
  });

  it('com a WABA configurada, segue direto para o serviço', () => {
    const { ctrl, assisted } = montar();
    const dto = { telefone: '85998062656', nomeExibicao: 'Petshop', aceitouPreRequisito: true } as any;
    ctrl.iniciar(ORG, 'USER', dto);
    expect(assisted.iniciar).toHaveBeenCalledWith(ORG, 'USER', dto);
  });
});
