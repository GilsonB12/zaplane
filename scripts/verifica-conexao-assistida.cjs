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
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRACAO = path.join(__dirname, '..', 'db', 'migrations', '013_conexao_assistida.sql');

let ok = 0, fail = 0;
const check = (nome, cond, detalhe = '') => {
  cond ? ok++ : fail++;
  console.log(`  ${cond ? 'PASS ' : 'FALHA'} | ${nome}${detalhe ? ' — ' + detalhe : ''}`);
};

(async () => {
  const c = new Client({ connectionString: process.env.PGCONN, ssl: false });
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

    console.log('\n=== INVARIANTES ===');

    const org = (await c.query(
      `INSERT INTO organizations (name, slug) VALUES ('T','t-${Date.now()}') RETURNING id`)).rows[0].id;

    await c.query(`INSERT INTO channel_connection_requests
      (organization_id, waba_id, phone_e164_enc, phone_hash, phone_ddd, phone_last4, display_name, status)
      VALUES ($1,'W','enc','HASH','85','9999','Loja','aguardando_codigo')`, [org]);

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
    check('só uma solicitação viva por organização', !!erro);

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
    check('o mesmo número não vive em duas organizações', !!erro);

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
    check('phone_number_id é único globalmente', !!erro);
  } catch (e) {
    fail++; console.log('  FALHA | erro:', e.message);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(`\n===== ${ok} PASS, ${fail} FALHA (revertido) =====`);
  process.exit(fail ? 1 : 0);
})();
