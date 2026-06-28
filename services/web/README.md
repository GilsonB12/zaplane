# Zaplane — Web (painel React)

Painel do Zaplane gerado no design do Claude e transformado em app **Vite + React +
Tailwind**. Hoje ele roda com **dados de exemplo (mock)**; a camada de API já está pronta
em `src/api/` para ligar no gateway local.

## Rodar (local, sem Docker)

```bash
cd services/web
cp .env.example .env        # opcional (o proxy do Vite já cobre o dev)
npm install
npm run dev                 # abre em http://localhost:5173
```

O Vite faz **proxy de `/api` → `http://localhost:3000`** (o API Gateway NestJS), então não
há problema de CORS no desenvolvimento.

## Estrutura

```
src/
  Zaplane.jsx        # a UI (seu design) — telas + componentes
  main.jsx           # ponto de entrada (monta o app)
  index.css          # Tailwind
  api/
    client.js        # fetch + JWT em memória (base /api/v1)
    endpoints.js     # 1 função por endpoint do gateway
```

## Mock → dados reais (como ligar)

Hoje as telas usam constantes no topo do `Zaplane.jsx` (`CONTATOS`, `CAMPANHAS`,
`TEMPLATES`...). Para usar dados reais, o padrão é:

```jsx
import { useEffect, useState } from "react";
import { listContacts } from "./api/endpoints";

const [contatos, setContatos] = useState([]);
useEffect(() => { listContacts({ page: 1 }).then((r) => setContatos(r.items)); }, []);
```

E o import real, no `ImportModal`:

```jsx
import { importContacts } from "./api/endpoints";
const stats = await importContacts(file, base, "cadastro_loja");
// stats = { imported, duplicates, invalid, total }
```

> Próximo passo natural: eu faço essa troca em todas as telas (login + contatos + import +
> campanhas + templates), com fallback para mock quando a API estiver offline.

## Pequenos ajustes que o backend precisa para o painel ficar 100%

A maioria dos endpoints já existe (ver `docs/ARCHITECTURE.md` §4). Faltam poucos para casar
com as telas:

- **`GET /campaigns`** (listar campanhas) — hoje o gateway só tem `GET /campaigns/:id`.
- **`GET /channels`** (status/quality rating do número) — para a aba "Conexão Meta".
- **`GET /organizations/members`** — para a aba "Equipe (RBAC)".

São endpoints simples de adicionar no gateway; posso incluí-los quando formos ligar as telas.
