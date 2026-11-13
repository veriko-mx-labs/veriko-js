/**
 * Operations of the public M2M surface.
 *
 * Run with VERIKO_API_KEY for the account calls. The plans are public and do
 * not send the key even when it is set.
 */
import { writeFile } from 'node:fs/promises';

import { Veriko } from '@veriko-mx/sdk';

const client = new Veriko();

const plans = await client.plans.listPublic();
console.log(plans);

if (!process.env.VERIKO_API_KEY) {
  console.log('Set VERIKO_API_KEY to read the account, insights and finance.');
  process.exit(0);
}

const profile = await client.account.myProfile();
const trends = await client.insights.getTrends({ range: '30d', metric: 'latency' });
const statement = await client.finance.getStatement({ month: '2026-04', format: 'pdf' });

console.log(profile, trends);
await writeFile(statement.filename, statement.content);
