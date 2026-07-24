import { inspectNibrsRollupAvailability } from "../lib/nibrs-rollup-router";

const status = inspectNibrsRollupAvailability();
console.log(JSON.stringify(status));
process.exit(status.available ? 0 : 1);
