import React, { useState } from "react";
import { Plus, Send } from "lucide-react";
import {
  Card, PrimaryBtn, Topbar, Sidebar,
} from "./components/ui.jsx";
import { AuthProvider, useAuth } from "./auth/AuthContext.jsx";
import Login from "./screens/Login.jsx";
import Contatos, { ImportModal } from "./screens/Contatos.jsx";
import Templates from "./screens/Templates.jsx";
import Campanhas, { NovaCampanha, CampanhaDetalhe } from "./screens/Campanhas.jsx";
import Dashboard from "./screens/Dashboard.jsx";
import Configuracoes from "./screens/Configuracoes.jsx";

/* ----------------------------- App ----------------------------- */
const TITLES = {
  dashboard: ["Dashboard", "Visão geral da sua operação de mensagens"],
  contatos: ["Contatos", "Gerencie sua base e o consentimento (LGPD)"],
  nova: ["Nova campanha", "Configure público, template e disparo"],
  campanhas: ["Campanhas", "Acompanhe disparos em tempo real"],
  "campanha-detalhe": ["Detalhe da campanha", "Progresso e métricas em tempo real"],
  templates: ["Templates", "Modelos aprovados pela Meta"],
  config: ["Configurações", "Conexão, equipe e billing"],
};

function AppShell() {
  const { logout } = useAuth();
  const [screen, setScreen] = useState("dashboard");
  const [dark, setDark] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [campaignId, setCampaignId] = useState(null);
  const [contactsReload, setContactsReload] = useState(0);

  const openCampaign = (id) => { setCampaignId(id); setScreen("campanha-detalhe"); };
  const [title, subtitle] = TITLES[screen] || TITLES.dashboard;

  const topActions =
    screen === "campanhas" ? <PrimaryBtn onClick={() => setScreen("nova")}><Plus className="h-4 w-4" /> Nova campanha</PrimaryBtn> :
    screen === "dashboard" ? <PrimaryBtn onClick={() => setScreen("nova")}><Send className="h-4 w-4" /> Disparar campanha</PrimaryBtn> :
    null;

  return (
    <div className={dark ? "dark" : ""}>
      <div className="flex h-screen overflow-hidden bg-zinc-50 font-sans text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <Sidebar screen={screen} setScreen={(s) => { setScreen(s); }} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar title={title} subtitle={subtitle} dark={dark} setDark={setDark} actions={topActions} onLogout={logout} />
          <main className="flex-1 overflow-y-auto">
            {screen === "dashboard" && <Dashboard setScreen={setScreen} openCampaign={openCampaign} />}
            {screen === "contatos" && <Contatos openImport={() => setImportOpen(true)} reloadKey={contactsReload} />}
            {screen === "nova" && <NovaCampanha setScreen={setScreen} openCampaign={openCampaign} />}
            {screen === "campanhas" && <Campanhas openCampaign={openCampaign} setScreen={setScreen} />}
            {screen === "campanha-detalhe" && <CampanhaDetalhe campaignId={campaignId} setScreen={setScreen} />}
            {screen === "templates" && <Templates />}
            {screen === "config" && <Configuracoes />}
          </main>
        </div>
        {importOpen && <ImportModal onClose={() => setImportOpen(false)} onImported={() => setContactsReload((k) => k + 1)} />}
      </div>
    </div>
  );
}

function Gate() {
  const { authed } = useAuth();
  return authed ? <AppShell /> : <Login />;
}

export default function Zaplane() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
