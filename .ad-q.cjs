const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.LOCALAPPDATA + '/AgentDashboard/dashboard.db', { readOnly: true });
const sql = process.argv[2];
const max = Number(process.argv[3] || 400);
for (const r of db.prepare(sql).all()) console.log(JSON.stringify(r).slice(0, max));
