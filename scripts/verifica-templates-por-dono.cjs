/* Invariantes da migração 014 contra o Postgres real, em transação revertida. */
const fs = require('fs');
const { Client } = require('pg');

const MIGRACAO = 'd:/Projetos/Pessoal/meta-whatsapp-api/db/migrations/014_templates_por_dono.sql';

let ok = 0, fail = 0;
const check = (nome, cond, det = '') => {
  cond ? ok++ : fail++;
  console.log(`  ${cond ? 'PASS ' : 'FALHA'} | ${nome}${det ? ' — ' + det : ''}`);
};
const violou = (e, constraint) =>
  !!e && e.code === '23514' && e.constraint === constraint;
const violouUnico = (e, indice) =>
  !!e && e.code === '23505' && e.constraint === indice;

(async () => {
  const c = new Client({
    connectionString: process.env.PGCONN,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query('BEGIN');
  try {
    // a 014 traz o próprio BEGIN/COMMIT; remover para não fechar a transação
    const sql = fs.readFileSync(MIGRACAO, 'utf8').replace(/^\s*(BEGIN|COMMIT)\s*;\s*$/gim, '');
    await c.query(sql);
    check('014 aplica sem erro', true);

    const org = (await c.query(
      `INSERT INTO organizations (name, slug) VALUES ('T','t-1') RETURNING id`)).rows[0].id;

    // genérico com dono é rejeitado
    await c.query('SAVEPOINT s1');
    let erro = null;
    try {
      await c.query(
        `INSERT INTO templates (organization_id, name, meta_name, scope, category)
         VALUES ($1,'x','zaplane_x','platform','UTILITY')`, [org]);
    } catch (e) { erro = e; }
    await c.query('ROLLBACK TO SAVEPOINT s1');
    check('genérico com dono é rejeitado', violou(erro, 'templates_escopo_dono_check'),
      erro ? `${erro.code}/${erro.constraint}` : 'nenhum erro');

    // template de organização sem dono é rejeitado
    await c.query('SAVEPOINT s2');
    erro = null;
    try {
      await c.query(
        `INSERT INTO templates (name, meta_name, scope, category)
         VALUES ('y','zabc_y','org','UTILITY')`);
    } catch (e) { erro = e; }
    await c.query('ROLLBACK TO SAVEPOINT s2');
    check('template de org sem dono é rejeitado', violou(erro, 'templates_escopo_dono_check'),
      erro ? `${erro.code}/${erro.constraint}` : 'nenhum erro');

    // dois genéricos com o mesmo nome são rejeitados
    await c.query(
      `INSERT INTO templates (name, meta_name, scope, category)
       VALUES ('promo','zaplane_promo','platform','UTILITY')`);
    await c.query('SAVEPOINT s3');
    erro = null;
    try {
      await c.query(
        `INSERT INTO templates (name, meta_name, scope, category)
         VALUES ('promo','zaplane_promo2','platform','MARKETING')`);
    } catch (e) { erro = e; }
    await c.query('ROLLBACK TO SAVEPOINT s3');
    check('dois genéricos com o mesmo nome são rejeitados',
      violouUnico(erro, 'idx_templates_plataforma'),
      erro ? `${erro.code}/${erro.constraint}` : 'nenhum erro');

    // duas organizações PODEM ter o mesmo nome de exibição
    const org2 = (await c.query(
      `INSERT INTO organizations (name, slug) VALUES ('T2','t2-1') RETURNING id`)).rows[0].id;
    await c.query(
      `INSERT INTO templates (organization_id, name, meta_name, scope, category)
       VALUES ($1,'promoção','zaaaaaaaa_promocao','org','MARKETING')`, [org]);
    await c.query(
      `INSERT INTO templates (organization_id, name, meta_name, scope, category)
       VALUES ($1,'promoção','zbbbbbbbb_promocao','org','MARKETING')`, [org2]);
    check('duas organizações podem ter o mesmo nome de exibição', true);

    // os templates que já existiam ganharam meta_name
    const semMeta = await c.query(
      `SELECT count(*)::int n FROM templates WHERE meta_name IS NULL`);
    check('nenhum template ficou sem meta_name', semMeta.rows[0].n === 0);

    const flag = await c.query(
      `SELECT count(*)::int n FROM users WHERE is_platform_admin IS NULL`);
    check('is_platform_admin não é nula em nenhum usuário', flag.rows[0].n === 0);
  } catch (e) {
    fail++; console.log('  FALHA | erro:', e.message);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(`\n===== ${ok} PASS, ${fail} FALHA (revertido) =====`);
  process.exit(fail ? 1 : 0);
})();
