import { SetMetadata } from '@nestjs/common';

export const PLATAFORMA_ADMIN_KEY = 'plataformaAdmin';

/** Marca a rota como ação da operação da Zaplane, acima do RBAC da organização. */
export const PlataformaAdmin = () => SetMetadata(PLATAFORMA_ADMIN_KEY, true);
