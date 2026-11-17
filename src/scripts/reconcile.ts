#!/usr/bin/env node
import { ReconciliationService } from '../server/services/reconciliation-service.js';
import { openConfiguredDatabase } from './open-db.js';

const db = openConfiguredDatabase();
const summary = new ReconciliationService(db).reconcileAllPeriods('adapter');
console.log(JSON.stringify(summary, null, 2));
db.close();
