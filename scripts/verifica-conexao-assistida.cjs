/* Verificação da conexão assistida contra o Postgres real de produção.
 *
 * Tudo roda dentro de UMA transação que termina em ROLLBACK — produção não é
 * alterada. A migração 013 ainda não foi aplicada em produção, então este
 * script a aplica primeiro (lendo o .sql do disco), dentro da mesma
 * transação, e só então roda as checagens. Ao final, o ROLLBACK desfaz tanto
 * a migração quanto os dados de teste.
 *
 * Prova os invariantes que vivem só no schema SQL (índices únicos parciais e
 * CHECK), que nenhum teste unitário em TypeScript alcança. O mais importante
 * é o índice de `phone_number_id` único globalmente: a vaga de um número na
 * WABA da Meta não volta por API, então um número duplicado entre
 * organizações é um estrago que a plataforma não desfaz sozinha.
 *
 * Uso:
 *   PGCONN='postgresql://…' node scripts/verifica-conexao-assistida.cjs
 *
 * A connection string vem SÓ por ambiente — nunca escreva host, usuário ou
 * senha num arquivo do repositório. O pacote `pg` precisa ser resolvível a
 * partir desta pasta; como o repo não tem node_modules na raiz, instale-o num
 * diretório de trabalho fora do git e aponte NODE_PATH para o node_modules
 * dele.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRACAO = path.join(__dirname, '..', 'db', 'migrations', '013_conexao_assistida.sql');

/** TLS obrigatório. O alvo declarado deste script é o Postgres de PRODUÇÃO,
 *  alcançado pelo proxy público do Railway — sem TLS a senha e os dados dos
 *  clientes atravessam a internet em texto puro. Um objeto `ssl` (mesmo vazio)
 *  faz o pg pedir o handshake antes de mandar credencial; se o servidor
 *  recusar TLS a conexão MORRE ("The server does not support SSL connections"),
 *  nunca cai de volta para texto puro sem avisar.
 *
 *  O Postgres do Railway apresenta um certificado AUTOASSINADO, então a
 *  verificação completa da cadeia falha ("self-signed certificate in
 *  certificate chain"). O caminho para ligá-la é apontar `PGSSLROOTCERT` para
 *  o CA do servidor (Railway → Postgres → Connect → certificado):
 *
 *      PGSSLROOTCERT=/caminho/ca.crt PGCONN=... node scripts/verifica-...
 *
 *  Sem o CA, o tráfego continua CIFRADO, mas a identidade do servidor não é
 *  verificada — protege contra escuta passiva, não contra um MITM ativo. O
 *  aviso abaixo existe para que essa diferença nunca passe despercebida. */
function configTls() {
  const caminhoCa = process.env.PGSSLROOTCERT;
  if (caminhoCa) {
    return { ca: fs.readFileSync(caminhoCa, 'utf8'), rejectUnauthorized: true };
  }
  console.log(
    'AVISO | TLS ligado, mas SEM verificar o certificado do servidor ' +
      '(o Postgres do Railway usa certificado autoassinado). Para verificação ' +
      'completa, defina PGSSLROOTCERT com o CA do servidor.',
  );
  return { rejectUnauthorized: false };
}

/** Colunas que a 013 acrescenta e que o `schema.prisma` já declara. O Prisma
 *  seleciona coluna por coluna (nunca `SELECT *`), então uma que falte no banco
 *  não quebra só a conexão assistida: quebra TODA consulta ao model — canais,
 *  campanhas, envio, webhook. É a checagem que justifica a ordem "SQL antes do
 *  código" do runbook. */
const COLUNAS_NOVAS = [
  ['channel_connection_requests', 'code_verified_at'],
  ['channel_connection_requests', 'register_pin_enc'],
  ['whatsapp_channels', 'register_pin_enc'],
];

let ok = 0, fail = 0;
const check = (nome, cond, detalhe = '') => {
  cond ? ok++ : fail++;
  console.log(`  ${cond ? 'PASS ' : 'FALHA'} | ${nome}${detalhe ? ' — ' + detalhe : ''}`);
};

// Confere não só que o INSERT falhou, mas que falhou pela violação de
// unicidade esperada (code 23505) e pelo índice esperado (constraint). Sem
// isso, uma checagem continuaria dizendo PASS mesmo que o índice em questão
// fosse removido — bastaria o INSERT falhar por outro motivo (NOT NULL, FK,
// etc.) para mascarar a ausência do invariante real.
const violacaoEsperada = (erro, indice) => {
  if (!erro) return false;
  if (erro.code !== '23505') return false;
  if (erro.constraint !== indice) return false;
  return true;
};

(async () => {
  const c = new Client({ connectionString: process.env.PGCONN, ssl: configTls() });
  await c.connect();
  await c.query('BEGIN');
  try {
    // ---- 0. aplica a migração 013 (ainda não aplicada em produção) --------
    // remove o BEGIN/COMMIT do arquivo: já estamos numa transação própria,
    // que termina em ROLLBACK — produção continua intocada.
    console.log('=== MIGRAÇÃO 013 ===');
    const sql = fs.readFileSync(MIGRACAO, 'utf8')
      .replace(/^\s*BEGIN;\s*$/m, '')
      .replace(/^\s*COMMIT;\s*$/m, '');
    await c.query(sql);
    check('013 aplica sem erro de sintaxe/semântica', true);

    console.log('\n=== COLUNAS QUE O PRISMA JÁ DECLARA ===');
    for (const [tabela, coluna] of COLUNAS_NOVAS) {
      const r = await c.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`,
        [tabela, coluna],
      );
      check(
        `${tabela}.${coluna} existe`,
        r.rowCount === 1,
        r.rowCount === 1 ? `${r.rows[0].data_type}, nullable=${r.rows[0].is_nullable}` : 'AUSENTE',
      );
    }

    console.log('\n=== INVARIANTES ===');

    const org = (await c.query(
      `INSERT INTO organizations (name, slug) VALUES ('T','t-${Date.now()}') RETURNING id`)).rows[0].id;

    await c.query(`INSERT INTO channel_connection_requests
      (organization_id, waba_id, phone_e164_enc, phone_hash, phone_ddd, phone_last4, display_name, status)
      VALUES ($1,'W','enc','HASH','85','9999','Loja','aguardando_codigo')`, [org]);

    // code_verified_at: marca o instante em que a Meta ACEITOU o código, e é
    // gravada ANTES do /register. É o que permite a segunda tentativa pular
    // direto para o registro em vez de reenviar um código que a Meta já não
    // aceita (recusa que contaria como erro e queimaria a solicitação — com a
    // vaga do número já consumida). A expressão abaixo é exatamente a que
    // AssistedService.verificacaoConcluida() manda por SQL cru.
    const lerVerificado = async () =>
      (await c.query(
        `SELECT code_verified_at IS NOT NULL AS verificado
           FROM channel_connection_requests WHERE organization_id = $1`, [org])).rows[0].verificado;
    check('code_verified_at nasce nula — nada verificado ainda', (await lerVerificado()) === false);
    await c.query(
      `UPDATE channel_connection_requests SET code_verified_at = now() WHERE organization_id = $1`, [org]);
    check('code_verified_at aceita o carimbo da verificação', (await lerVerificado()) === true);
    await c.query(
      `UPDATE channel_connection_requests SET code_verified_at = NULL WHERE organization_id = $1`, [org]);

    // A partir daqui cada checagem que espera um erro roda dentro de um
    // SAVEPOINT: no Postgres, um erro deixa a transação inteira "abortada"
    // (todo comando seguinte falha com "current transaction is aborted")
    // até um ROLLBACK — sem SAVEPOINT, a primeira violação de constraint já
    // impediria as checagens seguintes de rodar.
    let erro = null;
    await c.query('SAVEPOINT sp1');
    try {
      await c.query(`INSERT INTO channel_connection_requests
        (organization_id, waba_id, phone_e164_enc, phone_hash, phone_ddd, phone_last4, display_name, status)
        VALUES ($1,'W','enc','HASH2','85','8888','Loja 2','aguardando_codigo')`, [org]);
    } catch (e) { erro = e; }
    await c.query('ROLLBACK TO SAVEPOINT sp1');
    check('só uma solicitação viva por organização', violacaoEsperada(erro, 'idx_ccr_org_viva'),
      erro && !violacaoEsperada(erro, 'idx_ccr_org_viva') ? `code=${erro.code} constraint=${erro.constraint}` : '');

    const org2 = (await c.query(
      `INSERT INTO organizations (name, slug) VALUES ('T2','t2-${Date.now()}') RETURNING id`)).rows[0].id;
    erro = null;
    await c.query('SAVEPOINT sp2');
    try {
      await c.query(`INSERT INTO channel_connection_requests
        (organization_id, waba_id, phone_e164_enc, phone_hash, phone_ddd, phone_last4, display_name, status)
        VALUES ($1,'W','enc','HASH','85','9999','Outra','aguardando_codigo')`, [org2]);
    } catch (e) { erro = e; }
    await c.query('ROLLBACK TO SAVEPOINT sp2');
    check('o mesmo número não vive em duas organizações', violacaoEsperada(erro, 'idx_ccr_phone_viva'),
      erro && !violacaoEsperada(erro, 'idx_ccr_phone_viva') ? `code=${erro.code} constraint=${erro.constraint}` : '');

    // O INSERT abaixo fica em SAVEPOINT + try/catch LOCAL: se ele falhar, a
    // checagem seguinte (phone_number_id único — a mais importante) não pode
    // ser pulada nem herdar uma transação abortada. A asserção é "não houve
    // erro", não um `true` incondicional.
    erro = null;
    await c.query('SAVEPOINT sp3');
    try {
      await c.query(`INSERT INTO whatsapp_channels
        (organization_id,label,phone_number_id,waba_id,access_token_enc,connected_via)
        VALUES ($1,'A','PN1','W','','assisted')`, [org]);
    } catch (e) { erro = e; }
    if (erro) await c.query('ROLLBACK TO SAVEPOINT sp3');
    else await c.query('RELEASE SAVEPOINT sp3');
    check('connected_via aceita assisted', erro === null, erro ? erro.message : '');

    erro = null;
    await c.query('SAVEPOINT sp4');
    try {
      await c.query(`INSERT INTO whatsapp_channels
        (organization_id,label,phone_number_id,waba_id,access_token_enc,connected_via)
        VALUES ($1,'B','PN1','W','','assisted')`, [org2]);
    } catch (e) { erro = e; }
    await c.query('ROLLBACK TO SAVEPOINT sp4');
    check('phone_number_id é único globalmente', violacaoEsperada(erro, 'idx_channels_pnid_global'),
      erro && !violacaoEsperada(erro, 'idx_channels_pnid_global') ? `code=${erro.code} constraint=${erro.constraint}` : '');
  } catch (e) {
    fail++; console.log('  FALHA | erro:', e.message);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(`\n===== ${ok} PASS, ${fail} FALHA (revertido) =====`);
  process.exit(fail ? 1 : 0);
})();
