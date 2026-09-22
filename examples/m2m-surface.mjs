/**
 * Operaciones de la superficie M2M pública.
 *
 * Ejecutar con VERIKO_API_KEY para las llamadas de cuenta. Los planes son
 * públicos y no envían la clave aunque esté configurada.
 */
import { writeFile } from 'node:fs/promises';

import { Veriko } from '@veriko-mx/sdk';

const client = new Veriko();

const plans = await client.plans.listPublic();
console.log(plans);

if (!process.env.VERIKO_API_KEY) {
  console.log('Configura VERIKO_API_KEY para consultar cuenta, insights y finanzas.');
  process.exit(0);
}

const profile = await client.account.myProfile();
const trends = await client.insights.getTrends({ range: '30d', metric: 'latency' });
const statement = await client.finance.getStatement({ month: '2026-04', format: 'pdf' });

console.log(profile, trends);
await writeFile(statement.filename, statement.content);
