/** Central de ajuda (Anexo B). O agent cita os artigos pelo id. */
export interface KbArticle {
  id: string;
  title: string;
  /** Como o artigo é citado: "do erro 809". */
  ref: string;
  /** Resumo usado pelo modelo para escolher o artigo. */
  summary: string;
  /** Passos para resolver um problema. */
  steps?: string[];
  /** Resposta direta para uma dúvida. */
  answer?: string;
  /** Sistema operacional a que o artigo se aplica, quando é específico. */
  os?: string;
}

export const KB: KbArticle[] = [
  {
    id: 'vpn-809',
    title: 'VPN: erro 809 no Windows 10',
    ref: 'do erro 809',
    summary: 'VPN com erro 809: reinstalar o cliente de VPN e reiniciar. Vale só para Windows 10; no Windows 11, abrir chamado.',
    os: 'Windows 10',
    steps: ['Reinstale o cliente de VPN pelo Portal da Empresa › Software.', 'Reinicie o computador.'],
  },
  {
    id: 'vpn',
    title: 'VPN não conecta',
    ref: 'de VPN',
    summary: 'VPN não conecta, sem código de erro: conferir a internet e entrar de novo no cliente.',
    steps: ['Confira se a internet funciona sem a VPN.', 'Feche o cliente da VPN e abra de novo.', 'Entre com o e-mail corporativo e a senha da rede.'],
  },
  {
    id: 'impressora',
    title: 'Impressora não imprime',
    ref: 'de impressão',
    summary: 'Impressora do andar não imprime: remover e adicionar de novo pelo servidor de impressão.',
    steps: ['Abra Configurações › Bluetooth e dispositivos › Impressoras.', 'Remova a impressora do seu andar.', 'Adicione de novo pelo endereço \\\\print.nexo.local.'],
  },
  {
    id: 'wifi',
    title: 'Sem conexão no Wi-Fi corporativo',
    ref: 'de Wi-Fi',
    summary: 'Sem conexão no Wi-Fi Nexo-Corp: esquecer a rede e conectar de novo.',
    steps: ['Esqueça a rede Nexo-Corp nas configurações de Wi-Fi.', 'Conecte de novo com o e-mail corporativo e a senha da rede.'],
  },
  {
    id: 'instalar-software',
    title: 'Instalar programas pelo Portal da Empresa',
    ref: 'de instalação',
    summary: 'Como instalar programas homologados (Figma, Office, Acrobat Reader...) sem chamado, pelo Portal da Empresa.',
    steps: ['Abra o Portal da Empresa › Software.', 'Procure o programa e clique em Instalar.', 'Aguarde uns 5 minutos e reinicie se for pedido.'],
  },
  {
    id: 'teams-cache',
    title: 'Teams fecha ou trava',
    ref: 'do Teams',
    summary: 'Teams fecha sozinho ou trava ao entrar em reunião: limpar o cache.',
    steps: ['Feche o Teams.', 'Apague a pasta %appdata%\\Microsoft\\Teams.', 'Abra o Teams de novo.'],
  },
  {
    id: 'senha-rede',
    title: 'Trocar a senha da rede',
    ref: 'de senha',
    summary: 'Troca de senha da rede (Windows, e-mail): o próprio colaborador faz pelo Meu perfil.',
    answer:
      'Para trocar a senha da rede, use Meu perfil › Redefinir senha — enviamos um link para o seu e-mail corporativo. Se a conta estiver bloqueada, posso chamar um analista.',
  },
  {
    id: 'horario',
    title: 'Horário do service desk',
    ref: 'de horário',
    summary: 'Horário de atendimento do service desk e plantão.',
    answer: 'O service desk atende de segunda a sexta, das 8h às 18h. Chamados críticos têm plantão 24 horas.',
  },
];

export const kbById = (id: string | undefined) => KB.find((a) => a.id === id);
