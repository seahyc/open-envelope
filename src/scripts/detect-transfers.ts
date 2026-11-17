#!/usr/bin/env node
import { TransferService } from '../server/services/transfer-service.js';
import { openConfiguredDatabase } from './open-db.js';

const db = openConfiguredDatabase();
const summary = new TransferService(db).detectAndLinkTransfers('rule');
console.log(JSON.stringify(summary, null, 2));
db.close();
